import { Hono } from 'hono';
import { and, asc, eq, gt, lte, or } from 'drizzle-orm';
import type { Bindings } from '../bindings';
import { requireClerkRead, requireClerkWrite } from '../middleware/auth';
import { getDb } from '../db/client';
import {
  aliases,
  assemblies,
  assemblyItems,
  assemblyLinks,
  colors,
  dots,
  itemResolutions,
  machineVariants,
  machines,
  partColorVariants,
  partNumbers,
  partSubstitutes,
  parts,
  serviceItems,
  customers,
  customerVehicles,
  maintenanceRecords,
  maintenanceItems,
} from '../db/schema';

export const syncRoute = new Hono<{ Bindings: Bindings }>();

// Catalog tables + CRM tables the clerk replica needs (everything except `users`). 
// Order is FIXED — pagination walks the tables in this sequence, so it must not change 
// between requests. CRM tables added at the end to maintain backward compatibility.
// Typed loosely because they are aggregated in one loop; each has `updated_at` + `id`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SYNC_TABLES: { name: string; table: any }[] = [
  // Catalog tables (original sync order - do not change)
  { name: 'machines', table: machines },
  { name: 'machineVariants', table: machineVariants },
  { name: 'colors', table: colors },
  { name: 'assemblies', table: assemblies },
  { name: 'assemblyItems', table: assemblyItems },
  { name: 'itemResolutions', table: itemResolutions },
  { name: 'dots', table: dots },
  { name: 'assemblyLinks', table: assemblyLinks },
  { name: 'parts', table: parts },
  { name: 'partNumbers', table: partNumbers },
  { name: 'partColorVariants', table: partColorVariants },
  { name: 'aliases', table: aliases },
  { name: 'serviceItems', table: serviceItems },
  { name: 'partSubstitutes', table: partSubstitutes },
  // CRM tables (bidirectional sync - clerk can write)
  { name: 'customers', table: customers },
  { name: 'customerVehicles', table: customerVehicles },
  { name: 'maintenanceRecords', table: maintenanceRecords },
  { name: 'maintenanceItems', table: maintenanceItems },
];

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

type Pos = { tableIdx: number; ts: number; id: string };

/**
 * Decode the request position. Two shapes:
 *   - bare number `"<ms>"` (or absent)  -> fresh session, low watermark = that number
 *   - composite `"<since>|<newSince>|<tableIdx>|<ts>|<id>"` -> resume mid-session
 */
function parseToken(raw: string | undefined): { since: number; newSince: number | null; pos: Pos | null } {
  if (!raw) return { since: 0, newSince: null, pos: null };
  if (!raw.includes('|')) return { since: Number(raw) || 0, newSince: null, pos: null };
  const [s, ns, ti, ts, id] = raw.split('|');
  return {
    since: Number(s) || 0,
    newSince: Number(ns) || 0,
    pos: { tableIdx: Number(ti) || 0, ts: Number(ts) || 0, id: id ?? '' },
  };
}

const msOf = (v: Date | number | string): number =>
  v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(v).getTime();

// Delta sync for the offline clerk replica.
//   GET /sync?since=<ms>&cursor=<token>&limit=<n>
//     since  : low watermark; 0/omitted = full catalog. Backward compatible.
//     cursor : opaque continuation token; when present it supersedes `since`.
//     limit  : max rows per page across all tables (default 1000, max 5000).
//
// Each session pulls the fixed window `since < updated_at <= newSince` (newSince captured at
// session start), walking SYNC_TABLES in order with keyset pagination (ORDER BY updated_at, id).
// Soft-deleted rows are INCLUDED (they carry a bumped updated_at), so the client removes them.
//
// Response: { since, cursor, hasMore, limit, tables }.
//   hasMore=true  -> call again, passing the returned `cursor` back verbatim.
//   hasMore=false -> delta complete; `cursor` is a bare number = the next session's `since`.
syncRoute.get('/', requireClerkRead, async (c) => {
  const parsed = parseToken(c.req.query('cursor') ?? c.req.query('since'));
  const since = parsed.since;
  // newSince: constant across a paginated session. On a fresh session, snapshot "now" (never below
  // the current watermark). Carried in the cursor while paging.
  const newSince = Math.max(parsed.newSince ?? Date.now(), since);
  const pos = parsed.pos;
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const sinceDate = new Date(since);
  const newSinceDate = new Date(newSince);
  const db = getDb(c.env);

  const tables: Record<string, unknown[]> = {};
  let budget = limit;
  let hasMore = false;
  let nextPos: Pos | null = null;

  const startIdx = pos ? pos.tableIdx : 0;
  for (let i = startIdx; i < SYNC_TABLES.length; i++) {
    const { name, table } = SYNC_TABLES[i];

    const conds = [gt(table.updatedAt, sinceDate), lte(table.updatedAt, newSinceDate)];
    // Keyset tiebreak only on the resume table, and only when we stopped mid-table.
    if (pos && i === pos.tableIdx && (pos.ts > 0 || pos.id !== '')) {
      const posDate = new Date(pos.ts);
      conds.push(or(gt(table.updatedAt, posDate), and(eq(table.updatedAt, posDate), gt(table.id, pos.id)))!);
    }

    const rows = (await db
      .select()
      .from(table)
      .where(and(...conds))
      .orderBy(asc(table.updatedAt), asc(table.id))
      .limit(budget + 1)) as { updatedAt: Date | number | string; id: string }[];

    if (rows.length > budget) {
      // This table has more rows than the remaining budget: emit a partial page, resume here.
      const page = rows.slice(0, budget);
      tables[name] = page;
      const last = page[page.length - 1];
      nextPos = { tableIdx: i, ts: msOf(last.updatedAt), id: last.id };
      hasMore = true;
      break;
    }

    tables[name] = rows;
    budget -= rows.length;
    if (budget === 0) {
      // Filled exactly. Later tables may still have rows — resume at the next table's start.
      if (i + 1 < SYNC_TABLES.length) {
        nextPos = { tableIdx: i + 1, ts: 0, id: '' };
        hasMore = true;
      }
      break;
    }
  }

  const cursor =
    hasMore && nextPos
      ? `${since}|${newSince}|${nextPos.tableIdx}|${nextPos.ts}|${nextPos.id}`
      : String(newSince);

  return c.json({ since, cursor, hasMore, limit, tables });
});

// Bidirectional sync: Clerk can POST changes back to the server
// This endpoint accepts writes to CRM tables from the clerk mobile app
syncRoute.post('/push', requireClerkWrite, async (c) => {
  const db = getDb(c.env);
  const body = await c.req.json().catch(() => null);

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'invalid request body' }, 400);
  }

  // Validate that we only have CRM tables (for now)
  const allowedTables = new Set(['customers', 'customerVehicles', 'maintenanceRecords', 'maintenanceItems']);
  const tables = body.tables as Record<string, unknown[]> | undefined;

  if (!tables) {
    return c.json({ error: 'no tables provided' }, 400);
  }

  const processed: Record<string, { inserted: number; updated: number; deleted: number }> = {};

  for (const [tableName, rows] of Object.entries(tables)) {
    if (!allowedTables.has(tableName)) {
      continue; // Skip non-CRM tables for now
    }

    if (!Array.isArray(rows)) {
      continue;
    }

    // Get the drizzle table
    const tableMap: Record<string, any> = {
      customers,
      customerVehicles,
      maintenanceRecords,
      maintenanceItems,
    };

    const table = tableMap[tableName];
    if (!table) continue;

    let inserted = 0;
    let updated = 0;
    let deleted = 0;

    for (const row of rows as any[]) {
      if (!row || typeof row !== 'object' || !row.id) continue;

      const now = new Date();
      const isDelete = !!row.deletedAt;

      // Check if row already exists in D1
      const existing = await db
        .select({ id: table.id })
        .from(table)
        .where(eq(table.id, row.id))
        .get();

      const parseDate = (v: unknown) => (v != null ? new Date(v as string | number) : null);

      if (isDelete) {
        const deletedAtDate = parseDate(row.deletedAt) ?? now;
        if (existing) {
          await db
            .update(table)
            .set({ deletedAt: deletedAtDate, updatedAt: now })
            .where(eq(table.id, row.id));
        } else {
          // Row was deleted before server ever saw it; insert tombstone so sync can propagate it
          const tombstoneData: Record<string, unknown> = {
            ...row,
            createdAt: now,
            updatedAt: now,
            deletedAt: deletedAtDate,
          };
          delete tombstoneData._sync_op;
          await db.insert(table).values(tombstoneData);
        }
        deleted++;
      } else if (existing) {
        // Update existing row
        const updateData: Record<string, unknown> = { ...row, updatedAt: now };
        delete updateData.id;
        delete updateData.createdAt;
        delete updateData._sync_op;

        if ('date' in updateData && updateData.date != null) {
          updateData.date = parseDate(updateData.date);
        }
        if ('warrantyStartDate' in updateData && updateData.warrantyStartDate != null) {
          updateData.warrantyStartDate = parseDate(updateData.warrantyStartDate);
        }
        if ('warrantyExpiryDate' in updateData && updateData.warrantyExpiryDate != null) {
          updateData.warrantyExpiryDate = parseDate(updateData.warrantyExpiryDate);
        }
        if ('deletedAt' in updateData) {
          updateData.deletedAt = parseDate(updateData.deletedAt);
        }

        await db
          .update(table)
          .set(updateData)
          .where(eq(table.id, row.id));
        updated++;
      } else {
        // Insert new row (with client-generated UUID id)
        const insertData: Record<string, unknown> = {
          ...row,
          createdAt: parseDate(row.createdAt) ?? now,
          updatedAt: now,
        };
        delete insertData._sync_op;

        if ('date' in insertData && insertData.date != null) {
          insertData.date = parseDate(insertData.date);
        }
        if ('warrantyStartDate' in insertData && insertData.warrantyStartDate != null) {
          insertData.warrantyStartDate = parseDate(insertData.warrantyStartDate);
        }
        if ('warrantyExpiryDate' in insertData && insertData.warrantyExpiryDate != null) {
          insertData.warrantyExpiryDate = parseDate(insertData.warrantyExpiryDate);
        }
        if ('deletedAt' in insertData) {
          insertData.deletedAt = parseDate(insertData.deletedAt);
        }

        await db.insert(table).values(insertData);
        inserted++;
      }
    }

    processed[tableName] = { inserted, updated, deleted };
  }

  return c.json({ ok: true, processed });
});
