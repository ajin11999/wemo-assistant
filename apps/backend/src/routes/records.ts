import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import type { Bindings } from '../bindings';
import { getDb } from '../db/client';
import { customers, customerVehicles, maintenanceRecords, maintenanceItems, users } from '../db/schema';
import { requireClerkWrite, requireClerkRead } from '../middleware/auth';

export const recordsRoute = new Hono<{ Bindings: Bindings }>();

// --- Reads ---

recordsRoute.get('/', requireClerkRead, async (c) => {
  const db = getDb(c.env);
  const customerId = c.req.query('customerId');
  const vehicleId = c.req.query('vehicleId');
  const type = c.req.query('type');
  
  const conditions = [isNull(maintenanceRecords.deletedAt)];
  if (customerId) conditions.push(eq(maintenanceRecords.customerId as any, customerId));
  if (vehicleId) conditions.push(eq(maintenanceRecords.customerVehicleId as any, vehicleId));
  if (type && ['service', 'purchase'].includes(type)) {
    conditions.push(eq(maintenanceRecords.type as any, type));
  }
  
  const rows = await db.select().from(maintenanceRecords).where(and(...conditions));
  return c.json(rows);
});

recordsRoute.get('/:id', requireClerkRead, async (c) => {
  const db = getDb(c.env);
  const id = c.req.param('id');
  const record = await db
    .select()
    .from(maintenanceRecords)
    .where(eq(maintenanceRecords.id, id))
    .get();
  if (!record) return c.json({ error: 'not found' }, 404);
  return c.json(record);
});

recordsRoute.get('/:id/items', requireClerkRead, async (c) => {
  const db = getDb(c.env);
  const id = c.req.param('id');
  const items = await db
    .select()
    .from(maintenanceItems)
    .where(and(eq(maintenanceItems.maintenanceRecordId, id), isNull(maintenanceItems.deletedAt)));
  return c.json(items);
});

// --- Writes ---

recordsRoute.post('/', requireClerkWrite, async (c) => {
  const body = await c.req.json().catch(() => null);
  const customerId = typeof body?.customerId === 'string' ? body.customerId.trim() : null;
  const description = typeof body?.description === 'string' ? body.description.trim() : null;
  const type = body?.type;
  if (!customerId || !description || !type) {
    return c.json({ error: 'customerId, description, and type are required' }, 400);
  }
  if (!['service', 'purchase'].includes(type)) {
    return c.json({ error: 'type must be "service" or "purchase"' }, 400);
  }
  const db = getDb(c.env);

  const cust = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId)).get();
  if (!cust) return c.json({ error: 'customer not found' }, 400);

  let customerVehicleId = typeof body.customerVehicleId === 'string' && body.customerVehicleId.trim() ? body.customerVehicleId.trim() : null;
  if (customerVehicleId) {
    const veh = await db.select({ id: customerVehicles.id }).from(customerVehicles).where(eq(customerVehicles.id, customerVehicleId)).get();
    if (!veh) customerVehicleId = null;
  }

  let technicianId = typeof body.technicianId === 'string' && body.technicianId.trim() ? body.technicianId.trim() : null;
  if (technicianId) {
    const tech = await db.select({ id: users.id }).from(users).where(eq(users.id, technicianId)).get();
    if (!tech) technicianId = null;
  }

  let clerkId = typeof body.clerkId === 'string' && body.clerkId.trim() ? body.clerkId.trim() : null;
  if (clerkId) {
    const clk = await db.select({ id: users.id }).from(users).where(eq(users.id, clerkId)).get();
    if (!clk) clerkId = null;
  }

  // Normalize date: accept epoch ms number or ISO string
  const date = typeof body.date === 'number' ? new Date(body.date)
    : typeof body.date === 'string' ? new Date(body.date)
    : undefined;
  const [row] = await db.insert(maintenanceRecords).values({
    customerId,
    customerVehicleId,
    type,
    date: date instanceof Date && !isNaN(date.getTime()) ? date : undefined,
    description,
    technicianId,
    clerkId,
    invoiceNumber: typeof body.invoiceNumber === 'string' && body.invoiceNumber.trim() ? body.invoiceNumber.trim() : null,
    totalAmount: typeof body.totalAmount === 'number' ? body.totalAmount : null,
    notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null,
  }).returning();
  return c.json(row, 201);
});

recordsRoute.put('/:id', requireClerkWrite, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400);
  const db = getDb(c.env);
  const existing = await db.select({ id: maintenanceRecords.id }).from(maintenanceRecords).where(eq(maintenanceRecords.id, id)).get();
  if (!existing) return c.json({ error: 'not found' }, 404);
  // Only allow known columns — strip items, updatedAt, and other noise
  const allowedCols = ['customerId', 'customerVehicleId', 'type', 'date', 'description',
    'technicianId', 'clerkId', 'invoiceNumber', 'totalAmount', 'notes'] as const;
  const updateData: Record<string, unknown> = {};
  for (const col of allowedCols) {
    if (col in body) {
      let val = (body as Record<string, unknown>)[col];
      if (typeof val === 'string' && val.trim() === '') val = null;
      // Normalize date: accept epoch ms number or ISO string -> Date
      if (col === 'date' && val != null) {
        const d = typeof val === 'number' ? new Date(val)
          : typeof val === 'string' ? new Date(val)
          : null;
        if (d instanceof Date && !isNaN(d.getTime())) updateData[col] = d;
      } else {
        updateData[col] = val ?? null;
      }
    }
  }

  if (updateData.customerId) {
    const cust = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, updateData.customerId as string)).get();
    if (!cust) return c.json({ error: 'customer not found' }, 400);
  }
  if (updateData.customerVehicleId) {
    const veh = await db.select({ id: customerVehicles.id }).from(customerVehicles).where(eq(customerVehicles.id, updateData.customerVehicleId as string)).get();
    if (!veh) updateData.customerVehicleId = null;
  }
  if (updateData.technicianId) {
    const tech = await db.select({ id: users.id }).from(users).where(eq(users.id, updateData.technicianId as string)).get();
    if (!tech) updateData.technicianId = null;
  }
  if (updateData.clerkId) {
    const clk = await db.select({ id: users.id }).from(users).where(eq(users.id, updateData.clerkId as string)).get();
    if (!clk) updateData.clerkId = null;
  }

  updateData.updatedAt = new Date();

  const [row] = await db.update(maintenanceRecords).set(updateData).where(eq(maintenanceRecords.id, id)).returning();
  return c.json(row);
});

recordsRoute.delete('/:id', requireClerkWrite, async (c) => {
  const id = c.req.param('id');
  const db = getDb(c.env);
  const existing = await db.select({ id: maintenanceRecords.id }).from(maintenanceRecords).where(eq(maintenanceRecords.id, id)).get();
  if (!existing) return c.json({ error: 'not found' }, 404);
  await db.update(maintenanceRecords).set({ deletedAt: new Date() }).where(eq(maintenanceRecords.id, id));
  return c.json({ ok: true });
});