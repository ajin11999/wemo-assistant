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
  users,
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

// Schema column definitions (whitelists allowed keys per table)
const TABLE_COLUMNS: Record<string, Set<string>> = {
  customers: new Set([
    'id', 'name', 'phone', 'phoneAlt', 'email', 'address', 'notes', 'tag',
    'createdAt', 'updatedAt', 'deletedAt'
  ]),
  customerVehicles: new Set([
    'id', 'customerId', 'machineId', 'licensePlate', 'frameNumber', 'colorId',
    'year', 'nickname', 'notes', 'createdAt', 'updatedAt', 'deletedAt'
  ]),
  maintenanceRecords: new Set([
    'id', 'customerVehicleId', 'customerId', 'type', 'date', 'description',
    'technicianId', 'clerkId', 'invoiceNumber', 'totalAmount', 'notes',
    'createdAt', 'updatedAt', 'deletedAt'
  ]),
  maintenanceItems: new Set([
    'id', 'maintenanceRecordId', 'category', 'partId', 'partNumberId',
    'partNumber', 'brand', 'quantity', 'hasWarranty', 'warrantyPeriodValue',
    'warrantyPeriodUnit', 'warrantyStartDate', 'warrantyExpiryDate',
    'warrantyNotes', 'unitPrice', 'notes', 'sortOrder',
    'createdAt', 'updatedAt', 'deletedAt'
  ]),
};

const FK_FIELDS = new Set([
  'customerId',
  'machineId',
  'colorId',
  'customerVehicleId',
  'technicianId',
  'clerkId',
  'partId',
  'partNumberId',
  'maintenanceRecordId',
]);

const parseDate = (v: unknown): Date | null => {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
};

function sanitizeRow(tableName: string, rawRow: Record<string, unknown>): Record<string, unknown> {
  const allowedKeys = TABLE_COLUMNS[tableName];
  const sanitized: Record<string, unknown> = {};

  if (!allowedKeys) return sanitized;

  for (const key of Object.keys(rawRow)) {
    if (!allowedKeys.has(key)) continue;
    let value = rawRow[key];

    if (FK_FIELDS.has(key) && typeof value === 'string' && value.trim() === '') {
      value = null;
    }

    if (['createdAt', 'updatedAt', 'deletedAt', 'date', 'warrantyStartDate', 'warrantyExpiryDate'].includes(key)) {
      sanitized[key] = parseDate(value);
    } else if (key === 'hasWarranty') {
      sanitized[key] = Boolean(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Validates foreign keys against D1 and current push batch.
 * - Optional FKs referencing non-existent rows are set to null so SQLite foreign key constraints pass.
 * - Required FKs referencing non-existent rows cause validation to return null so the invalid row is skipped.
 */
async function validateAndSanitizeFks(
  db: any,
  tableName: string,
  data: Record<string, unknown>,
  pushedIds: Record<string, Set<string>>
): Promise<Record<string, unknown> | null> {
  const result = { ...data };

  // --- 1. Required FKs (if invalid/missing, row cannot satisfy D1 foreign key constraint) ---

  if (tableName === 'customerVehicles') {
    if (!result.customerId || typeof result.customerId !== 'string') return null;
    const custInBatch = pushedIds.customers?.has(result.customerId as string);
    if (!custInBatch) {
      const exists = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, result.customerId as string)).get();
      if (!exists) return null;
    }

    if (!result.machineId || typeof result.machineId !== 'string') return null;
    const exists = await db.select({ id: machines.id }).from(machines).where(eq(machines.id, result.machineId as string)).get();
    if (!exists) return null;
  }

  if (tableName === 'maintenanceRecords') {
    if (!result.customerId || typeof result.customerId !== 'string') return null;
    const custInBatch = pushedIds.customers?.has(result.customerId as string);
    if (!custInBatch) {
      const exists = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, result.customerId as string)).get();
      if (!exists) return null;
    }
  }

  if (tableName === 'maintenanceItems') {
    if (!result.maintenanceRecordId || typeof result.maintenanceRecordId !== 'string') return null;
    const recInBatch = pushedIds.maintenanceRecords?.has(result.maintenanceRecordId as string);
    if (!recInBatch) {
      const exists = await db
        .select({ id: maintenanceRecords.id })
        .from(maintenanceRecords)
        .where(eq(maintenanceRecords.id, result.maintenanceRecordId as string))
        .get();
      if (!exists) return null;
    }
  }

  // --- 2. Optional / Nullable FKs (if invalid, set to null so SQLite foreign key constraint passes) ---

  if (result.colorId && typeof result.colorId === 'string') {
    const exists = await db.select({ id: colors.id }).from(colors).where(eq(colors.id, result.colorId as string)).get();
    if (!exists) result.colorId = null;
  }

  if (result.customerVehicleId && typeof result.customerVehicleId === 'string') {
    const inBatch = pushedIds.customerVehicles?.has(result.customerVehicleId as string);
    if (!inBatch) {
      const exists = await db
        .select({ id: customerVehicles.id })
        .from(customerVehicles)
        .where(eq(customerVehicles.id, result.customerVehicleId as string))
        .get();
      if (!exists) result.customerVehicleId = null;
    }
  }

  if (result.technicianId && typeof result.technicianId === 'string') {
    const exists = await db.select({ id: users.id }).from(users).where(eq(users.id, result.technicianId as string)).get();
    if (!exists) result.technicianId = null;
  }

  if (result.clerkId && typeof result.clerkId === 'string') {
    const exists = await db.select({ id: users.id }).from(users).where(eq(users.id, result.clerkId as string)).get();
    if (!exists) result.clerkId = null;
  }

  if (result.partId && typeof result.partId === 'string') {
    const exists = await db.select({ id: parts.id }).from(parts).where(eq(parts.id, result.partId as string)).get();
    if (!exists) result.partId = null;
  }

  if (result.partNumberId && typeof result.partNumberId === 'string') {
    const exists = await db.select({ id: partNumbers.id }).from(partNumbers).where(eq(partNumbers.id, result.partNumberId as string)).get();
    if (!exists) result.partNumberId = null;
  }

  return result;
}

// Fixed dependency order for push processing (parents before children)
const PUSH_TABLE_ORDER = ['customers', 'customerVehicles', 'maintenanceRecords', 'maintenanceItems'];

// Bidirectional sync: Clerk can POST changes back to the server
// This endpoint accepts writes to CRM tables from the clerk mobile app
syncRoute.post('/push', requireClerkWrite, async (c) => {
  try {
    const db = getDb(c.env);
    const body = await c.req.json().catch(() => null);

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'invalid request body' }, 400);
    }

    const tables = body.tables as Record<string, unknown[]> | undefined;

    if (!tables || typeof tables !== 'object') {
      return c.json({ error: 'no tables provided' }, 400);
    }

    const tableMap: Record<string, any> = {
      customers,
      customerVehicles,
      maintenanceRecords,
      maintenanceItems,
    };

    const processed: Record<string, { inserted: number; updated: number; deleted: number }> = {};
    const pushedIds: Record<string, Set<string>> = {
      customers: new Set(),
      customerVehicles: new Set(),
      maintenanceRecords: new Set(),
      maintenanceItems: new Set(),
    };

    for (const tableName of PUSH_TABLE_ORDER) {
      const rows = tables[tableName];
      if (!Array.isArray(rows)) continue;

      const table = tableMap[tableName];
      if (!table) continue;

      let inserted = 0;
      let updated = 0;
      let deleted = 0;

      for (const row of rows as Record<string, unknown>[]) {
        if (!row || typeof row !== 'object' || !row.id || typeof row.id !== 'string') {
          continue;
        }

        try {
          const now = new Date();
          const isDelete = !!row.deletedAt;

          // Check if row already exists in D1
          const existing = await db
            .select({ id: table.id })
            .from(table)
            .where(eq(table.id, row.id))
            .get();

          if (isDelete) {
            const deletedAtDate = parseDate(row.deletedAt) ?? now;
            if (existing) {
              await db
                .update(table)
                .set({ deletedAt: deletedAtDate, updatedAt: now })
                .where(eq(table.id, row.id));
            } else {
              // Row was deleted before server ever saw it; insert tombstone so sync can propagate it
              let data = sanitizeRow(tableName, row);
              const validated = await validateAndSanitizeFks(db, tableName, data, pushedIds);
              if (!validated) {
                console.warn(`[sync/push] Skipping tombstone for ${tableName}/${row.id} due to invalid required FK`);
                continue;
              }
              data = validated;
              data.id = row.id;
              data.createdAt = parseDate(row.createdAt) ?? now;
              data.updatedAt = now;
              data.deletedAt = deletedAtDate;
              await db.insert(table).values(data as any);
            }
            deleted++;
          } else if (existing) {
            // Update existing row
            let data = sanitizeRow(tableName, row);
            const validated = await validateAndSanitizeFks(db, tableName, data, pushedIds);
            if (!validated) {
              console.warn(`[sync/push] Skipping update for ${tableName}/${row.id} due to invalid required FK`);
              continue;
            }
            data = validated;
            delete data.id;
            delete data.createdAt;
            data.updatedAt = now;

            await db
              .update(table)
              .set(data as any)
              .where(eq(table.id, row.id));
            updated++;
          } else {
            // Insert new row (with client-generated UUID id)
            let data = sanitizeRow(tableName, row);
            const validated = await validateAndSanitizeFks(db, tableName, data, pushedIds);
            if (!validated) {
              console.warn(`[sync/push] Skipping insert for ${tableName}/${row.id} due to invalid required FK`);
              continue;
            }
            data = validated;
            data.id = row.id;
            data.createdAt = parseDate(row.createdAt) ?? now;
            data.updatedAt = now;

            await db.insert(table).values(data as any);
            inserted++;
          }

          pushedIds[tableName]?.add(row.id);
        } catch (rowErr: any) {
          console.error(`[sync/push] Failed to process row ${row.id} in ${tableName}:`, rowErr?.message || String(rowErr));
        }
      }

      processed[tableName] = { inserted, updated, deleted };
    }

    return c.json({ ok: true, processed });
  } catch (err: any) {
    console.error('[sync/push error]:', err);
    return c.json(
      {
        error: 'Failed to push sync changes',
        details: err?.message || String(err),
      },
      500,
    );
  }
});


