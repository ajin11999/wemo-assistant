import { useMemo, useState } from 'react';
import {
  Alert,
  Badge,
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
  Text,
  ThemeIcon,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconCheck,
  IconDatabaseImport,
  IconFileUpload,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import { api } from './api';
import {
  BLOB_MAX_BYTES,
  BLOB_MAX_PAGES,
  commitBlobCrop,
  pageHasDiagram,
  validateBlobPackage,
} from './ingest-helpers';
import { notifySuccess } from './notify';
import type {
  BlobAssemblyPage,
  BlobColorPage,
  BlobMachineHint,
  ExtractedColorPage,
  ExtractedPage,
  PreviewEntry,
} from './types';

type StagedStatus = 'staged' | 'committing' | 'committed' | 'error';
type StagedPage = {
  key: string;
  source: string;
  pageNo: number;
  seq: number;
  type: 'assembly' | 'color';
  groupType: 'engine' | 'frame' | null;
  assemblyExtracted: ExtractedPage | null;
  colorExtracted: ExtractedColorPage | null;
  crop: { base64: string; mediaType: string; w: number; h: number } | null;
  thumb: string | null;
  status: StagedStatus;
  info?: string;
  error?: string;
};

type Phase = { label: string; done: number; total: number } | null;

const borderFor: Record<StagedStatus, string> = {
  staged: 'var(--mantine-color-default-border)',
  committing: 'var(--mantine-color-blue-4)',
  committed: 'var(--mantine-color-green-6)',
  error: 'var(--mantine-color-red-6)',
};

function StatusIcon({ status }: { status: StagedStatus }) {
  if (status === 'committing') return <Loader size={14} />;
  if (status === 'committed') return <IconCheck size={14} color="var(--mantine-color-green-6)" />;
  if (status === 'error') return <IconX size={14} color="var(--mantine-color-red-6)" />;
  return null;
}

function hintLabel(h: BlobMachineHint | null | undefined): string | null {
  if (!h) return null;
  const parts = [h.brand, h.model, h.typeCode].filter((s) => s && s.trim());
  return parts.length ? parts.join(' · ') : null;
}

function cropToDataUrl(crop: NonNullable<StagedPage['crop']>): string {
  return `data:${crop.mediaType};base64,${crop.base64}`;
}

export function BlobIngest({ machineId, onCommitted }: { machineId: string; onCommitted: () => void }) {
  const [pages, setPages] = useState<StagedPage[]>([]);
  const [fileName, setFileName] = useState('');
  const [hint, setHint] = useState<BlobMachineHint | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [phase, setPhase] = useState<Phase>(null);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState<Map<string, PreviewEntry> | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const patch = (seq: number, p: Partial<StagedPage>) =>
    setPages((prev) => prev.map((pg) => (pg.seq === seq ? { ...pg, ...p } : pg)));

  async function onFile(file: File | null) {
    if (!file) return;
    setErr('');
    setPreview(null);
    if (file.size > BLOB_MAX_BYTES) {
      setErr(
        `File is ${(file.size / 1024 / 1024).toFixed(1)} MB (hard cap is ${BLOB_MAX_BYTES / 1024 / 1024} MB) — split the catalog into smaller blobs.`,
      );
      return;
    }
    try {
      const raw = JSON.parse(await file.text());
      const pkg = validateBlobPackage(raw);
      const staged: StagedPage[] = [...pkg.pages]
        .sort((a, b) => a.seq - b.seq)
        .map((p, k) => {
          if (p.type === 'assembly') {
            const ap = p as BlobAssemblyPage;
            const crop =
              ap.diagramCropBase64 && ap.width && ap.height
                ? { base64: ap.diagramCropBase64, mediaType: ap.mediaType ?? 'image/png', w: ap.width, h: ap.height }
                : null;
            return {
              key: `${ap.source}#${ap.pageNo}#${k}`,
              source: ap.source,
              pageNo: ap.pageNo,
              seq: ap.seq,
              type: 'assembly' as const,
              groupType: ap.groupType,
              assemblyExtracted: ap.extracted as ExtractedPage,
              colorExtracted: null,
              crop,
              thumb: ap.thumbDataUrl ?? null,
              status: 'staged' as const,
            };
          }
          const cp = p as BlobColorPage;
          return {
            key: `${cp.source}#${cp.pageNo}#${k}`,
            source: cp.source,
            pageNo: cp.pageNo,
            seq: cp.seq,
            type: 'color' as const,
            groupType: null,
            assemblyExtracted: null,
            colorExtracted: cp.extracted as ExtractedColorPage,
            crop: null,
            thumb: null,
            status: 'staged' as const,
          };
        });
      setPages(staged);
      setFileName(file.name);
      setHint((pkg.machineHint as BlobMachineHint) ?? null);
      setSources(pkg.sources ?? Array.from(new Set(staged.map((s) => s.source))));
      setSourceFilter('all');
      notifySuccess(`Staged ${staged.length} pages`, 'Nothing is written yet — preview matches, then Commit all.');
    } catch (e) {
      setPages([]);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  const distinctNumbers = useMemo(() => {
    const set = new Set<string>();
    for (const p of pages) {
      if (p.type === 'assembly' && p.assemblyExtracted) {
        for (const it of p.assemblyExtracted.items) for (const pn of it.partNumbers) if (pn.value.trim()) set.add(pn.value.trim());
      } else if (p.type === 'color' && p.colorExtracted) {
        for (const it of p.colorExtracted.items) if (it.baseNumber.trim()) set.add(it.baseNumber.trim());
      }
    }
    return [...set];
  }, [pages]);

  async function runPreview() {
    if (!distinctNumbers.length) {
      setErr('Nothing staged to preview.');
      return;
    }
    setErr('');
    setPreviewBusy(true);
    try {
      const { results } = await api.previewNumbers(distinctNumbers);
      setPreview(new Map(results.map((r) => [r.value, r])));
      const nNew = results.filter((r) => !r.found).length;
      notifySuccess('Preview done', `${results.length - nNew} exist · ${nNew} new — review badges, then Commit all.`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setPreviewBusy(false);
    }
  }

  async function commitAll() {
    if (!machineId) {
      setErr('Select a machine first.');
      return;
    }
    const targets = pages
      .filter((p) => p.status === 'staged' || p.status === 'error')
      .sort((a, b) => a.seq - b.seq);
    if (!targets.length) {
      setErr('Nothing staged to commit.');
      return;
    }
    setErr('');
    let done = 0;
    let failed = 0;
    setPhase({ label: 'Committing', done: 0, total: targets.length });
    for (const p of targets) {
      patch(p.seq, { status: 'committing', error: undefined });
      try {
        if (p.type === 'assembly' && p.assemblyExtracted && p.groupType) {
          const ex = p.assemblyExtracted;
          const { summary } = await api.commitPage(machineId, p.groupType, ex);
          let mapNote = '';
          if (pageHasDiagram(ex)) {
            try {
              const n = await commitBlobCrop(summary.assemblyId, ex, p.crop);
              mapNote = `, ${n} dots`;
            } catch {
              /* dots best-effort */
            }
          } else {
            mapNote = ', merged (no diagram)';
          }
          patch(p.seq, { status: 'committed', info: `${ex.assembly.code} → ${p.groupType}${mapNote}` });
        } else if (p.type === 'color' && p.colorExtracted) {
          const { summary } = await api.colorCommit(machineId, p.colorExtracted);
          patch(p.seq, { status: 'committed', info: `${summary.variantsCreated} color variants` });
        } else {
          throw new Error('staged page is missing its extracted payload');
        }
      } catch (e2) {
        failed++;
        patch(p.seq, { status: 'error', error: String(e2) });
      } finally {
        done++;
        setPhase({ label: 'Committing', done, total: targets.length });
      }
    }
    setPhase(null);
    notifySuccess(
      `Committed ${done - failed}/${targets.length} pages`,
      failed ? `${failed} failed — fix the blob or retry.` : 'All pages are in the catalog.',
    );
    onCommitted();
  }

  const nAssembly = pages.filter((p) => p.type === 'assembly').length;
  const nColor = pages.filter((p) => p.type === 'color').length;
  const hintText = hintLabel(hint);
  const visible = sourceFilter === 'all' ? pages : pages.filter((p) => p.source === sourceFilter);
  const previewCounts = useMemo(() => {
    if (!preview) return null;
    let exist = 0;
    for (const r of preview.values()) if (r.found) exist++;
    return { exist, fresh: preview.size - exist };
  }, [preview]);

  function pageMatch(p: StagedPage): { exist: number; fresh: number } | null {
    if (!preview) return null;
    let exist = 0;
    let fresh = 0;
    const bump = (v: string) => {
      const r = preview.get(v.trim());
      if (!r) return;
      if (r.found) exist++;
      else fresh++;
    };
    if (p.type === 'assembly' && p.assemblyExtracted) {
      for (const it of p.assemblyExtracted.items) for (const pn of it.partNumbers) bump(pn.value);
    } else if (p.type === 'color' && p.colorExtracted) {
      for (const it of p.colorExtracted.items) bump(it.baseNumber);
    }
    return { exist, fresh };
  }

  return (
    <Stack>
      {pages.length === 0 ? (
        <Card withBorder>
          <Stack align="center" gap={6} py="lg">
            <ThemeIcon variant="light" size="xl" radius="xl">
              <IconFileUpload size={26} />
            </ThemeIcon>
            <Text fw={500}>Import one machine's ingest blob</Text>
            <Text size="xs" c="dimmed" ta="center" maw={560}>
              Single JSON file produced offline from this machine's catalog PDFs (multi-PDF compacted into one blob —
              see docs/blob-ingest.md). Nothing is written on upload: pages stage below for preview, then commit to
              the machine selected in the header. Hard caps: {BLOB_MAX_PAGES} pages,{' '}
              {BLOB_MAX_BYTES / 1024 / 1024} MB — split larger catalogs by group.
            </Text>
            <FileButton onChange={onFile} accept="application/json,.json">
              {(props) => (
                <Button mt="xs" leftSection={<IconFileUpload size={16} />} {...props}>
                  Choose blob JSON
                </Button>
              )}
            </FileButton>
          </Stack>
        </Card>
      ) : (
        <Group align="center">
          <FileButton onChange={onFile} accept="application/json,.json">
            {(props) => (
              <Button variant="default" leftSection={<IconFileUpload size={16} />} {...props}>
                Replace file
              </Button>
            )}
          </FileButton>
          <Button variant="subtle" color="gray" onClick={() => { setPages([]); setPreview(null); setFileName(''); }} disabled={!!phase}>
            Clear
          </Button>
          <Text size="sm" c="dimmed">
            {fileName} · {pages.length} pages · {nAssembly} assembly · {nColor} color
            {hintText ? ` · hint: ${hintText}` : ''}
          </Text>
          {sources.length > 1 && (
            <Select
              size="xs"
              w={220}
              data={['all', ...sources]}
              value={sourceFilter}
              onChange={(v) => setSourceFilter(v ?? 'all')}
              allowDeselect={false}
            />
          )}
          <Button variant="light" leftSection={<IconSearch size={16} />} onClick={runPreview} loading={previewBusy} disabled={!!phase}>
            Preview matches
          </Button>
          <Button color="green" leftSection={<IconDatabaseImport size={16} />} onClick={commitAll} disabled={!!phase}>
            Commit all
          </Button>
          {previewCounts && (
            <Text size="sm" c="dimmed">
              {previewCounts.exist} exist · {previewCounts.fresh} new
            </Text>
          )}
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
          {visible.map((p) => {
            const m = pageMatch(p);
            const img = p.thumb ?? (p.crop ? cropToDataUrl(p.crop) : null);
            const title =
              p.type === 'assembly' && p.assemblyExtracted
                ? `${p.assemblyExtracted.assembly.code} ${p.assemblyExtracted.assembly.name} · ${p.assemblyExtracted.items.length} items`
                : p.colorExtracted
                  ? `${p.colorExtracted.colors.length} colors · ${p.colorExtracted.items.length} parts`
                  : p.type;
            return (
              <Paper key={p.key} withBorder p={4} style={{ borderColor: borderFor[p.status] }}>
                <Text fz={10} c="dimmed" lineClamp={1} title={p.source}>
                  {p.source} · p{p.pageNo} · seq {p.seq}
                </Text>
                {img ? (
                  <Image src={img} h={110} fit="contain" alt={`${p.source} page ${p.pageNo}`} />
                ) : (
                  <Text fz={11} c="dimmed" ta="center" py="md">
                    table-only (no diagram)
                  </Text>
                )}
                <Group justify="space-between" wrap="nowrap" mt={4} gap={4}>
                  <Group gap={4} wrap="nowrap">
                    <Badge size="xs" variant="light" color={p.type === 'assembly' ? 'blue' : 'grape'}>
                      {p.type}
                    </Badge>
                    <StatusIcon status={p.status} />
                  </Group>
                  {m && (
                    <Text size="xs" c="dimmed">
                      {m.exist}∪{m.fresh}+
                    </Text>
                  )}
                </Group>
                <Text size="xs" c={p.status === 'error' ? 'red' : p.status === 'committed' ? 'green' : 'dimmed'} lineClamp={3}>
                  {p.status}
                  {`: ${title}`}
                  {p.info ? ` — ${p.info}` : ''}
                  {p.error ? `: ${p.error}` : ''}
                </Text>
              </Paper>
            );
          })}
        </SimpleGrid>
      )}
    </Stack>
  );
}
