import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Bindings } from '../bindings';
import { getDb } from '../db/client';
import { maintenanceItems, maintenanceRecords, parts, partNumbers } from '../db/schema';
import { requireClerkWrite, requireClerkRead } from '../middleware/auth';

export const recordItemsRoute = new Hono<{ Bindings: Bindings }>();

// --- Reads ---

recordItemsRoute.get('/:id', requireClerkRead, async (c) => {
  const db = getDb(c.env);
  const id = c.req.param('id');
  const item = await db
    .select()
    .from(maintenanceItems)
    .where(eq(maintenanceItems.id, id))
    .get();
  if (!item) return c.json({ error: 'not found' }, 404);
  return c.json(item);
});

// --- Writes ---

recordItemsRoute.post('/:recordId/items', requireClerkWrite, async (c) => {
  const recordId = c.req.param('recordId');
  const body = await c.req.json().catch(() => null);
  if (!body?.category) return c.json({ error: 'category is required' }, 400);

  const db = getDb(c.env);
  // Verify record exists
  const record = await db
    .select({ id: maintenanceRecords.id })
    .from(maintenanceRecords)
    .where(eq(maintenanceRecords.id, recordId))
    .get();
  if (!record) return c.json({ error: 'record not found' }, 404);

  let partId = typeof body.partId === 'string' && body.partId.trim() ? body.partId.trim() : null;
  if (partId) {
    const p = await db.select({ id: parts.id }).from(parts).where(eq(parts.id, partId)).get();
    if (!p) partId = null;
  }

  let partNumberId = typeof body.partNumberId === 'string' && body.partNumberId.trim() ? body.partNumberId.trim() : null;
  if (partNumberId) {
    const pn = await db.select({ id: partNumbers.id }).from(partNumbers).where(eq(partNumbers.id, partNumberId)).get();
    if (!pn) partNumberId = null;
  }

  const [row] = await db.insert(maintenanceItems).values({
    maintenanceRecordId: recordId,
    category: body.category,
    partId,
    partNumberId,
    partNumber: typeof body.partNumber === 'string' && body.partNumber.trim() ? body.partNumber.trim() : null,
    brand: typeof body.brand === 'string' && body.brand.trim() ? body.brand.trim() : null,
    quantity: typeof body.quantity === 'number' ? body.quantity : 1,
    hasWarranty: Boolean(body.hasWarranty),
    warrantyPeriodValue: typeof body.warrantyPeriodValue === 'number' ? body.warrantyPeriodValue : null,
    warrantyPeriodUnit: body.warrantyPeriodUnit ?? null,
    warrantyStartDate: typeof body.warrantyStartDate === 'number' ? new Date(body.warrantyStartDate) : null,
    warrantyExpiryDate: typeof body.warrantyExpiryDate === 'number' ? new Date(body.warrantyExpiryDate) : null,
    warrantyNotes: typeof body.warrantyNotes === 'string' && body.warrantyNotes.trim() ? body.warrantyNotes.trim() : null,
    unitPrice: typeof body.unitPrice === 'number' ? body.unitPrice : null,
    notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null,
    sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
  }).returning();
  return c.json(row, 201);
});

recordItemsRoute.put('/:id', requireClerkWrite, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400);
  const db = getDb(c.env);
  const existing = await db.select({ id: maintenanceItems.id }).from(maintenanceItems).where(eq(maintenanceItems.id, id)).get();
  if (!existing) return c.json({ error: 'not found' }, 404);

  const allowedCols = ['maintenanceRecordId', 'category', 'partId', 'partNumberId', 'partNumber',
    'brand', 'quantity', 'hasWarranty', 'warrantyPeriodValue', 'warrantyPeriodUnit',
    'warrantyStartDate', 'warrantyExpiryDate', 'warrantyNotes', 'unitPrice', 'notes', 'sortOrder'] as const;

  const updateData: Record<string, unknown> = {};
  for (const col of allowedCols) {
    if (col in body) {
      let val = (body as Record<string, unknown>)[col];
      if (typeof val === 'string' && val.trim() === '') val = null;
      if (['warrantyStartDate', 'warrantyExpiryDate'].includes(col) && typeof val === 'number') {
        updateData[col] = new Date(val);
      } else {
        updateData[col] = val ?? null;
      }
    }
  }

  if (updateData.maintenanceRecordId) {
    const rec = await db.select({ id: maintenanceRecords.id }).from(maintenanceRecords).where(eq(maintenanceRecords.id, updateData.maintenanceRecordId as string)).get();
    if (!rec) return c.json({ error: 'maintenance record not found' }, 400);
  }
  if (updateData.partId) {
    const p = await db.select({ id: parts.id }).from(parts).where(eq(parts.id, updateData.partId as string)).get();
    if (!p) updateData.partId = null;
  }
  if (updateData.partNumberId) {
    const pn = await db.select({ id: partNumbers.id }).from(partNumbers).where(eq(partNumbers.id, updateData.partNumberId as string)).get();
    if (!pn) updateData.partNumberId = null;
  }

  updateData.updatedAt = new Date();

  const [row] = await db.update(maintenanceItems).set(updateData).where(eq(maintenanceItems.id, id)).returning();
  return c.json(row);
});

recordItemsRoute.delete('/:id', requireClerkWrite, async (c) => {
  const id = c.req.param('id');
  const db = getDb(c.env);
  const existing = await db.select({ id: maintenanceItems.id }).from(maintenanceItems).where(eq(maintenanceItems.id, id)).get();
  if (!existing) return c.json({ error: 'not found' }, 404);
  await db.update(maintenanceItems).set({ deletedAt: new Date() }).where(eq(maintenanceItems.id, id));
  return c.json({ ok: true });
});