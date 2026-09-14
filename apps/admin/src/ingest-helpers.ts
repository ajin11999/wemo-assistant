import { api } from './api';
import type { BlobPackage, DiagramBox, EditorDot, ExtractedPage } from './types';
import { BLOB_VERSION } from './types';

// --- Ingest blob caps (hard) ---
// A blob packs up to a whole machine's catalog (multi-PDF) into ONE file that
// is staged in React state before committing. Past ~50 pages the tab risks
// OOM on the base64 crops, and the commit loop becomes unresumable in
// practice — so oversize blobs are rejected outright: split by group
// (engine/frame) into two files instead. Byte cap guards the JSON.parse.
export const BLOB_MAX_PAGES = 50;
export const BLOB_MAX_BYTES = 80 * 1024 * 1024;

// Does this extracted page actually carry the exploded diagram? Multi-page
// assemblies put the diagram on page 1 and continue the parts table on later
// pages sharing the same code. A table-only continuation page returns a
// whole-page bbox ({0,0,1,1}) and no balloon dots — its (absent) crop must NOT
// overwrite page 1's diagram and its empty dot set must NOT wipe page 1's dots.
export function pageHasDiagram(ex: ExtractedPage): boolean {
  if (ex.items.some((it) => it.dots && it.dots.length > 0)) return true;
  const b = ex.diagram;
  if (!b) return false;
  return b.x > 0.03 || b.y > 0.03 || b.width < 0.97 || b.height < 0.97;
}

// Whether ingest should ask the AI to place balloon dots. Persisted so the admin sets it
// once; shared by the single-page (Ingest) and Batch flows. Default true (existing behavior);
// turn off to save tokens when the AI dot placement isn't precise enough to keep.
const MAP_DOTS_KEY = 'wemo.mapDots';
export function getMapDots(): boolean {
  return localStorage.getItem(MAP_DOTS_KEY) !== 'false';
}
export function setMapDots(on: boolean): void {
  localStorage.setItem(MAP_DOTS_KEY, on ? 'true' : 'false');
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function imageMeta(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

export function cropToBox(dataUrl: string, box: DiagramBox): Promise<{ dataUrl: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const sx = Math.max(0, box.x * img.naturalWidth);
      const sy = Math.max(0, box.y * img.naturalHeight);
      const sw = Math.min(img.naturalWidth - sx, box.width * img.naturalWidth);
      const sh = Math.min(img.naturalHeight - sy, box.height * img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sw));
      canvas.height = Math.max(1, Math.round(sh));
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('no 2d canvas context'));
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      resolve({ dataUrl: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height });
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

export function b64of(dataUrl: string): { b64: string; mediaType: string } {
  const [meta, b64] = dataUrl.split(',');
  return { b64, mediaType: meta.substring(5, meta.indexOf(';')) };
}

// After commit: crop the page to the AI's diagram bbox, upload it as the assembly image
// (first diagram page only), then transform this page's per-ref balloon coords into crop
// space and save them. Multi-page assemblies share one diagram, so we MERGE dots: positions
// contributed by other pages are preserved (saveDots replaces the whole assembly's set), and
// only the first page's crop becomes the image so cross-page dots stay on the same picture.
export async function autoMap(assemblyId: string, page: ExtractedPage, pageDataUrl: string): Promise<number> {
  const box = page.diagram ?? null;
  const full = await api.getAssemblyFull(assemblyId);

  // The first diagram page owns the image; later pages of the same assembly keep it.
  if (!full.assembly.imageRef) {
    let uploadUrl = pageDataUrl;
    let w: number;
    let h: number;
    if (box) {
      const cropped = await cropToBox(pageDataUrl, box);
      uploadUrl = cropped.dataUrl;
      w = cropped.w;
      h = cropped.h;
    } else {
      const meta = await imageMeta(pageDataUrl);
      w = meta.w;
      h = meta.h;
    }
    const { b64, mediaType } = b64of(uploadUrl);
    await api.uploadAssemblyImage(assemblyId, b64, mediaType, w, h);
  }

  const idByRef = new Map(full.items.map((it) => [it.refNo, it.id]));
  const thisPageRefs = new Set(page.items.map((it) => it.refNo));
  const dots: EditorDot[] = [];
  // Preserve dots already placed for positions this page doesn't cover (earlier pages of a
  // multi-page assembly) — saveDots overwrites the whole assembly, so resend them.
  for (const it of full.items) {
    if (thisPageRefs.has(it.refNo)) continue;
    for (const d of it.dots) dots.push({ assemblyItemId: it.id, x: d.x, y: d.y });
  }
  let placed = 0;
  for (const it of page.items) {
    const aid = idByRef.get(it.refNo);
    if (!aid || !it.dots) continue;
    for (const d of it.dots) {
      let x = d.x;
      let y = d.y;
      if (box) {
        x = (d.x - box.x) / box.width;
        y = (d.y - box.y) / box.height;
      }
      if (x < 0 || x > 1 || y < 0 || y > 1) continue;
      dots.push({ assemblyItemId: aid, x, y });
      placed++;
    }
  }
  if (dots.length) await api.saveDots(assemblyId, dots);
  return placed;
}

// Blob variant of autoMap: the crop is already embedded in the blob file, so
// upload it as-is (no re-crop) and transform this page's FULL-PAGE balloon
// coords into crop space via the extracted diagram bbox. Same merge rules:
// the first diagram page in `seq` order owns the image; later pages of the
// same assembly keep it and only merge their dots (saveDots overwrites the
// whole assembly, so other pages' dots are re-sent).
export async function commitBlobCrop(
  assemblyId: string,
  page: ExtractedPage,
  crop: { base64: string; mediaType: string; w: number; h: number } | null,
): Promise<number> {
  const box = page.diagram ?? null;
  const full = await api.getAssemblyFull(assemblyId);

  if (!full.assembly.imageRef && crop) {
    await api.uploadAssemblyImage(assemblyId, crop.base64, crop.mediaType, crop.w, crop.h);
  }

  const idByRef = new Map(full.items.map((it) => [it.refNo, it.id]));
  const thisPageRefs = new Set(page.items.map((it) => it.refNo));
  const dots: EditorDot[] = [];
  for (const it of full.items) {
    if (thisPageRefs.has(it.refNo)) continue;
    for (const d of it.dots) dots.push({ assemblyItemId: it.id, x: d.x, y: d.y });
  }
  let placed = 0;
  for (const it of page.items) {
    const aid = idByRef.get(it.refNo);
    if (!aid || !it.dots) continue;
    for (const d of it.dots) {
      let x = d.x;
      let y = d.y;
      if (box) {
        x = (d.x - box.x) / box.width;
        y = (d.y - box.y) / box.height;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) continue;
      dots.push({ assemblyItemId: aid, x, y });
      placed++;
    }
  }
  if (dots.length) await api.saveDots(assemblyId, dots);
  return placed;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function assertFinite01(n: unknown, what: string): void {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) throw new Error(`invalid ${what} (must be 0..1)`);
}

// Structural validation for a blob file (no zod in the admin bundle). The
// commit endpoints re-validate every extracted payload with zod server-side;
// this only enforces the package envelope + hard caps so a bad file fails
// fast at stage time with a human-readable message.
export function validateBlobPackage(raw: unknown): BlobPackage {
  if (!isRecord(raw)) throw new Error('not a JSON object');
  if (raw.version !== BLOB_VERSION) throw new Error(`unrecognized blob (expected version ${BLOB_VERSION})`);
  if (!Array.isArray(raw.sources) || !raw.sources.every((s) => typeof s === 'string')) {
    throw new Error('blob.sources must be a string array of source PDF names');
  }
  if (!Array.isArray(raw.pages)) throw new Error('blob.pages must be an array');
  if (raw.pages.length === 0) throw new Error('blob has no pages');
  if (raw.pages.length > BLOB_MAX_PAGES) {
    throw new Error(
      `blob has ${raw.pages.length} pages (hard cap is ${BLOB_MAX_PAGES}) — split it by group (engine/frame) into two files`,
    );
  }
  const seenPage = new Set<string>();
  const seenSeq = new Set<number>();
  raw.pages.forEach((p, i) => {
    const what = `pages[${i}]`;
    if (!isRecord(p)) throw new Error(`invalid ${what}`);
    if (typeof p.source !== 'string' || !p.source) throw new Error(`invalid ${what}.source`);
    if (!Number.isInteger(p.pageNo)) throw new Error(`invalid ${what}.pageNo`);
    if (!Number.isInteger(p.seq)) throw new Error(`invalid ${what}.seq`);
    const key = `${p.source}#${p.pageNo}`;
    if (seenPage.has(key)) throw new Error(`duplicate page ${key}`);
    seenPage.add(key);
    if (seenSeq.has(p.seq as number)) throw new Error(`duplicate seq ${p.seq}`);
    seenSeq.add(p.seq as number);
    if (p.type === 'assembly') {
      if (p.groupType !== 'engine' && p.groupType !== 'frame') throw new Error(`invalid ${what}.groupType`);
      if (!isRecord(p.extracted)) throw new Error(`invalid ${what}.extracted`);
      const ex = p.extracted as Record<string, unknown>;
      const asm = ex.assembly as Record<string, unknown> | undefined;
      if (!isRecord(asm) || typeof asm.code !== 'string' || typeof asm.name !== 'string') {
        throw new Error(`invalid ${what}.extracted.assembly (code + name required)`);
      }
      if (!Array.isArray(ex.items)) throw new Error(`invalid ${what}.extracted.items`);
      for (const it of ex.items as unknown[]) {
        if (!isRecord(it) || typeof it.refNo !== 'string' || typeof it.description !== 'string') {
          throw new Error(`invalid ${what}.extracted.items entry (refNo + description required)`);
        }
        if (!Array.isArray(it.partNumbers)) throw new Error(`invalid ${what}.extracted.items partNumbers`);
        for (const pn of it.partNumbers as unknown[]) {
          if (!isRecord(pn) || typeof pn.value !== 'string' || !pn.value.trim()) {
            throw new Error(`invalid ${what}.extracted.items part number (value required)`);
          }
        }
        if (it.dots !== undefined) {
          if (!Array.isArray(it.dots)) throw new Error(`invalid ${what}.extracted.items dots`);
          for (const d of it.dots as unknown[]) {
            if (!isRecord(d)) throw new Error(`invalid ${what}.extracted.items dots entry`);
            assertFinite01(d.x, `${what} dot x`);
            assertFinite01(d.y, `${what} dot y`);
          }
        }
      }
      if (p.diagramCropBase64 !== undefined && p.diagramCropBase64 !== null && typeof p.diagramCropBase64 !== 'string') {
        throw new Error(`invalid ${what}.diagramCropBase64`);
      }
    } else if (p.type === 'color') {
      if (!isRecord(p.extracted)) throw new Error(`invalid ${what}.extracted`);
      const ex = p.extracted as Record<string, unknown>;
      if (!Array.isArray(ex.colors) || !Array.isArray(ex.items)) {
        throw new Error(`invalid ${what}.extracted (colors + items required)`);
      }
      for (const it of ex.items as unknown[]) {
        if (!isRecord(it) || typeof it.baseNumber !== 'string' || !it.baseNumber.trim()) {
          throw new Error(`invalid ${what}.extracted.items entry (baseNumber required)`);
        }
      }
    } else {
      throw new Error(`invalid ${what}.type (must be 'assembly' or 'color')`);
    }
  });
  return raw as unknown as BlobPackage;
}
