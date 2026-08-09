import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import type { Bindings } from '../bindings';
import { getDb } from '../db/client';
import { colors, customerVehicles, customers, machines, maintenanceRecords } from '../db/schema';
import { requireClerkWrite, requireClerkRead } from '../middleware/auth';

export const vehiclesRoute = new Hono<{ Bindings: Bindings }>();

// --- Reads ---

// List all vehicles (across all customers), with customer + machine info joined
vehiclesRoute.get('/', requireClerkRead, async (c) => {
  const db = getDb(c.env);
  const search = c.req.query('search')?.toLowerCase() ?? '';

  const rows = await db
    .select({
      id: customerVehicles.id,
      customerId: customerVehicles.customerId,
      machineId: customerVehicles.machineId,
      licensePlate: customerVehicles.licensePlate,
      frameNumber: customerVehicles.frameNumber,
      colorId: customerVehicles.colorId,
      year: customerVehicles.year,
      nickname: customerVehicles.nickname,
      notes: customerVehicles.notes,
      createdAt: customerVehicles.createdAt,
      updatedAt: customerVehicles.updatedAt,
      deletedAt: customerVehicles.deletedAt,
      customerName: customers.name,
      machineBrand: machines.brand,
      machineModel: machines.model,
    })
    .from(customerVehicles)
    .innerJoin(customers, eq(customerVehicles.customerId, customers.id))
    .innerJoin(machines, eq(customerVehicles.machineId, machines.id))
    .where(and(isNull(customerVehicles.deletedAt), isNull(customers.deletedAt)));

  // Filter by search (client-side for simplicity — small shop datasets)
  const filtered = search
    ? rows.filter((r) => {
        const hay = `${r.customerName} ${r.machineBrand} ${r.machineModel} ${r.licensePlate ?? ''} ${r.frameNumber ?? ''} ${r.nickname ?? ''}`.toLowerCase();
        const terms = search.split(/\s+/).filter(Boolean);
        return terms.every(term => hay.includes(term));
      })
    : rows;

  return c.json(filtered);
});

vehiclesRoute.get('/:id', requireClerkRead, async (c) => {
  const db = getDb(c.env);
  const id = c.req.param('id');
  const vehicle = await db
    .select()
    .from(customerVehicles)
    .where(eq(customerVehicles.id, id))
    .get();
  if (!vehicle) return c.json({ error: 'not found' }, 404);
  return c.json(vehicle);
});

vehiclesRoute.get('/:id/records', requireClerkRead, async (c) => {
  const db = getDb(c.env);
  const id = c.req.param('id');
  const records = await db
    .select()
    .from(maintenanceRecords)
    .where(and(eq(maintenanceRecords.customerVehicleId, id), isNull(maintenanceRecords.deletedAt)));
  return c.json(records);
});

// --- Writes ---

vehiclesRoute.put('/:id', requireClerkWrite, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400);
  const db = getDb(c.env);
  const existing = await db.select({ id: customerVehicles.id }).from(customerVehicles).where(eq(customerVehicles.id, id)).get();
  if (!existing) return c.json({ error: 'not found' }, 404);

  const allowedCols = ['customerId', 'machineId', 'licensePlate', 'frameNumber', 'colorId', 'year', 'nickname', 'notes'] as const;
  const updateData: Record<string, unknown> = {};
  for (const col of allowedCols) {
    if (col in body) {
      let val = (body as Record<string, unknown>)[col];
      if (typeof val === 'string' && val.trim() === '') val = null;
      updateData[col] = val ?? null;
    }
  }

  if (updateData.customerId) {
    const cust = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, updateData.customerId as string)).get();
    if (!cust) return c.json({ error: 'customer not found' }, 400);
  }
  if (updateData.machineId) {
    const mach = await db.select({ id: machines.id }).from(machines).where(eq(machines.id, updateData.machineId as string)).get();
    if (!mach) return c.json({ error: 'machine not found' }, 400);
  }
  if (updateData.colorId) {
    const col = await db.select({ id: colors.id }).from(colors).where(eq(colors.id, updateData.colorId as string)).get();
    if (!col) updateData.colorId = null;
  }

  updateData.updatedAt = new Date();

  const [row] = await db.update(customerVehicles).set(updateData).where(eq(customerVehicles.id, id)).returning();
  return c.json(row);
});

vehiclesRoute.delete('/:id', requireClerkWrite, async (c) => {
  const id = c.req.param('id');
  const db = getDb(c.env);
  const existing = await db.select({ id: customerVehicles.id }).from(customerVehicles).where(eq(customerVehicles.id, id)).get();
  if (!existing) return c.json({ error: 'not found' }, 404);
  await db.update(customerVehicles).set({ deletedAt: new Date() }).where(eq(customerVehicles.id, id));
  return c.json({ ok: true });
});
