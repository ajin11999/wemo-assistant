import { Hono } from 'hono';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Bindings } from '../bindings';
import { requireAdmin } from '../middleware/auth';
import { getVisionProvider, resolveAiConfig } from '../ai';
import type { ImageMediaType } from '../ai/provider';
import { extractedColorPage, extractedPage } from '../ai/types';
import { getDb } from '../db/client';
import { machines, partNumbers, parts } from '../db/schema';
import { persistExtractedPage } from '../services/ingest-persist';
import { persistColorPage } from '../services/color-persist';

export const ingestRoute = new Hono<{ Bindings: Bindings }>();

// Extract an assembly page image -> structured DRAFT (admin reviews before committing).
// Admin-only: ingestion is a write-side (catalog-building) operation.
ingestRoute.post('/page', requireAdmin, async (c) => {
  const body = await c.req
    .json<{ imageBase64?: string; mediaType?: string; mapDots?: boolean }>()
    .catch(() => null);
  if (!body?.imageBase64) {
    return c.json({ error: 'imageBase64 is required' }, 400);
  }
  const mediaType = (body.mediaType ?? 'image/png') as ImageMediaType;
  // Default true (existing behavior); admin can disable balloon-dot placement to save tokens.
  const mapDots = body.mapDots !== false;

  const provider = getVisionProvider(await resolveAiConfig(getDb(c.env), c.env));
  try {
    const extracted = await provider.extractCatalogPage({ imageBase64: body.imageBase64, mediaType, mapDots });
    return c.json({ extracted });
  } catch (e) {
    return c.json({ error: 'extraction failed', detail: String(e) }, 502);
  }
});

// Batch number-existence check for blob-import preview. Read-only: given the
// distinct part numbers staged from a blob file, report which already exist as
// live canonical parts (green "exists" badge) vs which would be created on
// commit (grey "new" badge). One round-trip instead of N+1 GET /parts?number=.
// A 50-page blob carries ~500-1000 distinct numbers; cap keeps the IN clause
// and response bounded. Admin-only like the rest of the ingest surface.
const MAX_PREVIEW_NUMBERS = 2000;
ingestRoute.post('/preview', requireAdmin, async (c) => {
  const body = await c.req.json<{ numbers?: unknown }>().catch(() => null);
  if (!Array.isArray(body?.numbers)) {
    return c.json({ error: 'numbers string array is required' }, 400);
  }
  const wanted = [...new Set(body.numbers.filter((n): n is string => typeof n === 'string').map((n) => n.trim()).filter(Boolean))];
  if (wanted.length === 0) return c.json({ results: [] });
  if (wanted.length > MAX_PREVIEW_NUMBERS) {
    return c.json({ error: `too many numbers (max ${MAX_PREVIEW_NUMBERS})` }, 400);
  }

  const db = getDb(c.env);
  const matched = await db
    .select({ value: partNumbers.value, partId: partNumbers.partId })
    .from(partNumbers)
    .where(and(inArray(partNumbers.value, wanted), isNull(partNumbers.deletedAt)));

  const seenValueToPart = new Map(matched.map((m) => [m.value, m.partId]));
  const partIds = [...new Set(matched.map((m) => m.partId))];
  const partRows = partIds.length
    ? await db.select().from(parts).where(inArray(parts.id, partIds))
    : [];
  const nameById = new Map(partRows.map((p) => [p.id, (p.nameNormalized ?? p.nameRaw) as string]));
  const numRows = partIds.length
    ? await db
        .select({ partId: partNumbers.partId, value: partNumbers.value, isPrimary: partNumbers.isPrimary })
        .from(partNumbers)
        .where(and(inArray(partNumbers.partId, partIds), isNull(partNumbers.deletedAt)))
    : [];
  const primaryById = new Map<string, string>();
  for (const n of numRows) {
    if (n.isPrimary && !primaryById.has(n.partId)) primaryById.set(n.partId, n.value);
    else if (!primaryById.has(n.partId)) primaryById.set(n.partId, n.value);
  }

  return c.json({
    results: wanted.map((value) => {
      const partId = seenValueToPart.get(value);
      if (!partId) return { value, found: false as const, partId: null, name: null, primaryNumber: null };
      return {
        value,
        found: true as const,
        partId,
        name: nameById.get(partId) ?? null,
        primaryNumber: primaryById.get(partId) ?? value,
      };
    }),
  });
});

// Persist a reviewed assembly draft. Parts deduped by number (interchange merge).
ingestRoute.post('/commit', requireAdmin, async (c) => {
  const body = await c.req
    .json<{ machineId?: string; groupType?: string; extracted?: unknown }>()
    .catch(() => null);
  if (!body?.machineId || !body?.groupType || body.extracted === undefined) {
    return c.json({ error: 'machineId, groupType, extracted are required' }, 400);
  }
  if (body.groupType !== 'engine' && body.groupType !== 'frame') {
    return c.json({ error: "groupType must be 'engine' or 'frame'" }, 400);
  }
  const parsed = extractedPage.safeParse(body.extracted);
  if (!parsed.success) {
    return c.json({ error: 'invalid extracted payload', detail: parsed.error.issues }, 400);
  }

  const db = getDb(c.env);
  const machine = await db
    .select({ id: machines.id })
    .from(machines)
    .where(eq(machines.id, body.machineId))
    .get();
  if (!machine) return c.json({ error: 'machine not found' }, 404);

  const summary = await persistExtractedPage(db, {
    machineId: body.machineId,
    groupType: body.groupType,
    extracted: parsed.data,
  });
  return c.json({ ok: true, summary }, 201);
});

// Extract a COLOR-INDEX page -> draft color variants (admin reviews).
ingestRoute.post('/color-page', requireAdmin, async (c) => {
  const body = await c.req.json<{ imageBase64?: string; mediaType?: string }>().catch(() => null);
  if (!body?.imageBase64) {
    return c.json({ error: 'imageBase64 is required' }, 400);
  }
  const mediaType = (body.mediaType ?? 'image/png') as ImageMediaType;

  const provider = getVisionProvider(await resolveAiConfig(getDb(c.env), c.env));
  try {
    const extracted = await provider.extractColorPage({ imageBase64: body.imageBase64, mediaType });
    return c.json({ extracted });
  } catch (e) {
    return c.json({ error: 'extraction failed', detail: String(e) }, 502);
  }
});

// Persist reviewed color variants. Colors deduped per machine; parts found-or-created by base number.
ingestRoute.post('/color-commit', requireAdmin, async (c) => {
  const body = await c.req.json<{ machineId?: string; extracted?: unknown }>().catch(() => null);
  if (!body?.machineId || body.extracted === undefined) {
    return c.json({ error: 'machineId and extracted are required' }, 400);
  }
  const parsed = extractedColorPage.safeParse(body.extracted);
  if (!parsed.success) {
    return c.json({ error: 'invalid extracted payload', detail: parsed.error.issues }, 400);
  }

  const db = getDb(c.env);
  const machine = await db
    .select({ id: machines.id })
    .from(machines)
    .where(eq(machines.id, body.machineId))
    .get();
  if (!machine) return c.json({ error: 'machine not found' }, 404);

  const summary = await persistColorPage(db, { machineId: body.machineId, extracted: parsed.data });
  return c.json({ ok: true, summary }, 201);
});
