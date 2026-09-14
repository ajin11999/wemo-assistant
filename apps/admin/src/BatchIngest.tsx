import { useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  Alert,
  Button,
  Card,
  FileButton,
  Group,
  Image,
  Loader,
  Paper,
  Progress,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconCheck,
  IconDatabaseImport,
  IconFileTypePdf,
  IconScan,
  IconX,
} from '@tabler/icons-react';
import { api } from './api';
import { autoMap, b64of, getMapDots, pageHasDiagram, setMapDots } from './ingest-helpers';
import { notifySuccess } from './notify';
import type { ExtractedColorPage, ExtractedPage } from './types';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const RENDER_SCALE = 2;
const CONCURRENCY = 3;

type PageType = 'skip' | 'assembly' | 'color';
type PageStatus = 'pending' | 'extracting' | 'extracted' | 'committing' | 'committed' | 'error';
type PageState = {
  id: string;
  pageNo: number;
  source: string;
  dataUrl: string;
  type: PageType;
  status: PageStatus;
  extracted?: ExtractedPage | ExtractedColorPage;
  info?: string;
  error?: string;
};

type Phase = { label: string; done: number; total: number } | null;

function inferGroup(code: string): 'engine' | 'frame' {
  return code.trim().toUpperCase().startsWith('F') ? 'frame' : 'engine';
}

const borderFor: Record<PageStatus, string> = {
  pending: 'var(--mantine-color-default-border)',
  extracting: 'var(--mantine-color-blue-4)',
  extracted: 'var(--mantine-color-blue-6)',
  committing: 'var(--mantine-color-blue-4)',
  committed: 'var(--mantine-color-green-6)',
  error: 'var(--mantine-color-red-6)',
};

function StatusIcon({ status }: { status: PageStatus }) {
  if (status === 'extracting' || status === 'committing') return <Loader size={14} />;
  if (status === 'committed') return <IconCheck size={14} color="var(--mantine-color-green-6)" />;
  if (status === 'extracted') return <IconCheck size={14} color="var(--mantine-color-blue-6)" />;
  if (status === 'error') return <IconX size={14} color="var(--mantine-color-red-6)" />;
  return null;
}

async function renderPdf(
  file: File,
  onProgress: (n: number, total: number) => void,
): Promise<{ pageNo: number; dataUrl: string }[]> {
  const buf = await file.arrayBuffer();
  // wasmUrl is required for pdf.js to decode JBIG2/JPX-compressed images — the
  // exploded diagrams in Honda catalogs are JBIG2 stencils. Without it pdf.js
  // silently drops them ("ignoring XObject") and pages render with a blank
  // diagram region. Served from /pdfjs-wasm/ (see vite.config.ts).
  const pdf = await pdfjsLib.getDocument({
    data: buf,
    wasmUrl: new URL('pdfjs-wasm/', document.baseURI).href,
    iccUrl: new URL('pdfjs-wasm/', document.baseURI).href,
  }).promise;
  const out: { pageNo: number; dataUrl: string }[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d canvas context');
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    out.push({ pageNo: i, dataUrl: canvas.toDataURL('image/png') });
    onProgress(i, pdf.numPages);
  }
  return out;
}

async function runPool<T>(items: T[], limit: number, worker: (t: T) => Promise<void>): Promise<void> {
  let idx = 0;
  async function next(): Promise<void> {
    while (idx < items.length) {
      const cur = items[idx++];
      await worker(cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
}

export function BatchIngest({ machineId, onCommitted }: { machineId: string; onCommitted: () => void }) {
  const [pages, setPages] = useState<PageState[]>([]);
  const [phase, setPhase] = useState<Phase>(null);
  const [err, setErr] = useState('');
  const [mapDots, setMapDotsState] = useState(getMapDots);

  const patch = (i: number, p: Partial<PageState>) =>
    setPages((prev) => prev.map((pg, k) => (k === i ? { ...pg, ...p } : pg)));

  // Renders each selected PDF and APPENDS its pages to the grid (choose again to add more
  // catalogs / more parts of a split catalog). Pages are tagged with their source file so a
  // multi-file grid stays legible; commit still targets the single selected machine.
  async function onPdfs(files: File[]) {
    if (!files.length) return;
    setErr('');
    let total = 0;
    try {
      for (let f = 0; f < files.length; f++) {
        const file = files[f];
        const base = file.name.replace(/\.pdf$/i, '');
        const label = files.length > 1 ? `Rendering ${base} (${f + 1}/${files.length})` : 'Rendering PDF';
        setPhase({ label, done: 0, total: 1 });
        const rendered = await renderPdf(file, (n, t) => setPhase({ label, done: n, total: t }));
        setPages((prev) => [
          ...prev,
          ...rendered.map((r) => ({
            id: `${base}#${r.pageNo}#${crypto.randomUUID().slice(0, 8)}`,
            pageNo: r.pageNo,
            source: base,
            dataUrl: r.dataUrl,
            type: 'skip' as PageType,
            status: 'pending' as PageStatus,
          })),
        ]);
        total += rendered.length;
      }
      notifySuccess(
        `${total} pages rendered${files.length > 1 ? ` from ${files.length} PDFs` : ''}`,
        "Mark each page's type, then Extract selected.",
      );
    } catch (e) {
      setErr(String(e));
    } finally {
      setPhase(null);
    }
  }

  const setAll = (type: PageType) => setPages((prev) => prev.map((pg) => ({ ...pg, type })));

  async function extractSelected() {
    // Only pending/error pages: re-running Extract after a partial failure must not
    // re-pay for pages that already extracted. To redo one, flip it to skip and back.
    const targets = pages
      .map((p, i) => ({ p, i }))
      .filter((x) => x.p.type !== 'skip' && (x.p.status === 'pending' || x.p.status === 'error'));
    if (!targets.length) {
      setErr('Mark some pages as assembly or color first.');
      return;
    }
    if (targets.length > 15 && !window.confirm(`Extract ${targets.length} pages? Each is a paid Claude call.`)) {
      return;
    }
    setErr('');
    let done = 0;
    setPhase({ label: 'Extracting', done: 0, total: targets.length });
    await runPool(targets, CONCURRENCY, async ({ p, i }) => {
      patch(i, { status: 'extracting', error: undefined });
      try {
        const { b64, mediaType } = b64of(p.dataUrl);
        if (p.type === 'assembly') {
          const { extracted } = await api.ingestPage(b64, mediaType, mapDots);
          patch(i, {
            status: 'extracted',
            extracted,
            info: `${extracted.assembly.code} ${extracted.assembly.name} · ${extracted.items.length} items`,
          });
        } else {
          const { extracted } = await api.ingestColorPage(b64, mediaType);
          patch(i, { status: 'extracted', extracted, info: `${extracted.colors.length} colors · ${extracted.items.length} parts` });
        }
      } catch (e2) {
        patch(i, { status: 'error', error: String(e2) });
      } finally {
        done++;
        setPhase({ label: 'Extracting', done, total: targets.length });
      }
    });
    setPhase(null);
    const failed = pages.filter((p) => p.status === 'error').length;
    notifySuccess('Extraction done', failed ? `${failed} pages failed — check the grid.` : 'Review the pages, then Commit all.');
  }

  async function commitAll() {
    if (!machineId) {
      setErr('Select a machine first.');
      return;
    }
    const targets = pages.map((p, i) => ({ p, i })).filter((x) => x.p.status === 'extracted' && x.p.extracted);
    if (!targets.length) {
      setErr('Nothing extracted to commit.');
      return;
    }
    setErr('');
    let done = 0;
    let failed = 0;
    setPhase({ label: 'Committing', done: 0, total: targets.length });
    for (const { p, i } of targets) {
      patch(i, { status: 'committing' });
      try {
        if (p.type === 'assembly') {
          const ex = p.extracted as ExtractedPage;
          const group = inferGroup(ex.assembly.code);
          const { summary } = await api.commitPage(machineId, group, ex);
          let n = 0;
          let mapNote = '';
          // Only the diagram-bearing page owns the image + dots; continuation pages merged
          // their rows server-side and must not touch the diagram.
          if (pageHasDiagram(ex)) {
            try {
              n = await autoMap(summary.assemblyId, ex, p.dataUrl);
              mapNote = `, ${n} dots`;
            } catch {
              /* dots best-effort */
            }
          } else {
            mapNote = ', merged (no diagram)';
          }
          patch(i, { status: 'committed', info: `${ex.assembly.code} → ${group}${mapNote}` });
        } else {
          const ex = p.extracted as ExtractedColorPage;
          const { summary } = await api.colorCommit(machineId, ex);
          patch(i, { status: 'committed', info: `${summary.variantsCreated} color variants` });
        }
      } catch (e2) {
        failed++;
        patch(i, { status: 'error', error: String(e2) });
      } finally {
        done++;
        setPhase({ label: 'Committing', done, total: targets.length });
      }
    }
    setPhase(null);
    notifySuccess(
      `Committed ${done - failed}/${targets.length} pages`,
      failed ? `${failed} failed — check the grid.` : 'All pages are in the catalog.',
    );
    onCommitted();
  }

  const nAssembly = pages.filter((p) => p.type === 'assembly').length;
  const nColor = pages.filter((p) => p.type === 'color').length;
  const sources = Array.from(new Set(pages.map((p) => p.source)));
  const multiFile = sources.length > 1;

  return (
    <Stack>
      {pages.length === 0 ? (
        <Card withBorder>
          <Stack align="center" gap={6} py="lg">
            <ThemeIcon variant="light" size="xl" radius="xl">
              <IconFileTypePdf size={26} />
            </ThemeIcon>
            <Text fw={500}>Ingest whole catalog PDFs</Text>
            <Text size="xs" c="dimmed" ta="center" maw={520}>
              Renders the PDFs in your browser (pdf.js) — pick one or more. Mark front-matter/index
              pages as “skip”. Each assembly/color page is one paid Claude call; group is inferred
              from the assembly code (E→engine, F→frame). All pages commit to the machine selected in
              the header.
            </Text>
            <FileButton onChange={onPdfs} accept="application/pdf" multiple>
              {(props) => (
                <Button mt="xs" leftSection={<IconFileTypePdf size={16} />} {...props}>
                  Choose catalog PDFs
                </Button>
              )}
            </FileButton>
          </Stack>
        </Card>
      ) : (
        <Group align="center">
          <FileButton onChange={onPdfs} accept="application/pdf" multiple>
            {(props) => (
              <Button variant="default" leftSection={<IconFileTypePdf size={16} />} {...props}>
                Add PDFs
              </Button>
            )}
          </FileButton>
          <Button variant="subtle" color="gray" onClick={() => setPages([])} disabled={!!phase}>
            Clear
          </Button>
          <Text size="sm" c="dimmed">
            {pages.length} pages{multiFile ? ` · ${sources.length} PDFs` : ''} · {nAssembly} assembly · {nColor} color
          </Text>
          <Button variant="light" onClick={() => setAll('assembly')}>
            All → assembly
          </Button>
          <Button variant="light" onClick={() => setAll('skip')}>
            All → skip
          </Button>
          <Tooltip
            multiline
            w={240}
            label="Ask the AI to place balloon dots on each diagram. Off saves tokens — diagrams are still cropped; place dots by hand in Dot mapping."
          >
            <Switch
              size="xs"
              checked={mapDots}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                setMapDotsState(on);
                setMapDots(on);
              }}
              label="Auto-place dots"
            />
          </Tooltip>
          <Button leftSection={<IconScan size={16} />} onClick={extractSelected} disabled={!!phase}>
            Extract selected
          </Button>
          <Button color="green" leftSection={<IconDatabaseImport size={16} />} onClick={commitAll} disabled={!!phase}>
            Commit all
          </Button>
        </Group>
      )}

      {phase && (
        <Stack gap={4}>
          <Text size="sm" c="dimmed">
            {phase.label} {phase.done}/{phase.total}…
          </Text>
          <Progress value={phase.total ? (phase.done / phase.total) * 100 : 0} animated />
        </Stack>
      )}
      {err && (
        <Alert color="red" icon={<IconAlertCircle size={16} />} withCloseButton onClose={() => setErr('')}>
          {err}
        </Alert>
      )}

      {pages.length > 0 && (
        <SimpleGrid cols={{ base: 2, sm: 4, md: 6 }} spacing="xs">
          {pages.map((p, i) => (
            <Paper key={p.id} withBorder p={4} style={{ borderColor: borderFor[p.status] }}>
              {multiFile && (
                <Text fz={10} c="dimmed" lineClamp={1} title={p.source}>
                  {p.source}
                </Text>
              )}
              <Image src={p.dataUrl} h={110} fit="contain" alt={`${p.source} page ${p.pageNo}`} />
              <Group justify="space-between" wrap="nowrap" mt={4} gap={4}>
                <Group gap={4} wrap="nowrap">
                  <Text size="xs" fw={600}>
                    p{p.pageNo}
                  </Text>
                  <StatusIcon status={p.status} />
                </Group>
                <Select
                  size="xs"
                  w={92}
                  data={['skip', 'assembly', 'color']}
                  value={p.type}
                  onChange={(v) =>
                    patch(i, {
                      type: (v as PageType) ?? 'skip',
                      status: 'pending',
                      extracted: undefined,
                      info: undefined,
                      error: undefined,
                    })
                  }
                  allowDeselect={false}
                />
              </Group>
              <Text size="xs" c={p.status === 'error' ? 'red' : p.status === 'committed' ? 'green' : 'dimmed'} lineClamp={3}>
                {p.status}
                {p.info ? `: ${p.info}` : ''}
                {p.error ? `: ${p.error}` : ''}
              </Text>
            </Paper>
          ))}
        </SimpleGrid>
      )}
    </Stack>
  );
}
