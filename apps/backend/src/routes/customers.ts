import { Hono } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Bindings } from '../bindings';
import { getDb } from '../db/client';
import { colors, customers, customerVehicles, machines, maintenanceRecords } from '../db/schema';
import { requireClerkWrite, requireClerkRead } from '../middleware/auth';

export const customersRoute = new Hono<{ Bindings: Bindings }>();

// --- Reads ---

customersRoute.get('/', requireClerkRead, async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({
      customer: customers,
      vehiclesCount: sql<number>`(SELECT COUNT(*) FROM ${customerVehicles} WHERE ${customerVehicles.customerId} = ${customers.id} AND ${customerVehicles.deletedAt} IS NULL)`,
      recordsCount: sql<number>`(SELECT COUNT(*) FROM ${maintenanceRecords} WHERE ${maintenanceRecords.customerId} = ${customers.id} AND ${maintenanceRecords.deletedAt} IS NULL)`,
    })
    .from(customers)
    .where(isNull(customers.deletedAt));
  
  return c.json(
    rows.map((r) => ({
      ...r.customer,
      vehiclesCount: r.vehiclesCount,
      recordsCount: r.recordsCount,
    }))
  );
});

customersRoute.get('/:id', requireClerkRead, async (c) => {
  const db = getDb(c.env);
  const id = c.req.param('id');
  const row = await db.select().from(customers).where(eq(customers.id, id)).get();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(row);
});

customersRoute.get('/:id/vehicles', requireClerkRead, async (c) => {
  const db = getDb(c.env);
  const id = c.req.param('id');
  const rows = await db
    .select({
      vehicle: customerVehicles,
      recordsCount: sql<number>`(SELECT COUNT(*) FROM ${maintenanceRecords} WHERE ${maintenanceRecords.customerVehicleId} = ${customerVehicles.id} AND ${maintenanceRecords.deletedAt} IS NULL)`,
    })
    .from(customerVehicles)
    .where(and(eq(customerVehicles.customerId, id), isNull(customerVehicles.deletedAt)));
    
  return c.json(
    rows.map((r) => ({
      ...r.vehicle,
      recordsCount: r.recordsCount,
    }))
  );
});

customersRoute.get('/:id/records', requireClerkRead, async (c) => {
  const db = getDb(c.env);
  const id = c.req.param('id');
  const records = await db
    .select()
    .from(maintenanceRecords)
    .where(and(eq(maintenanceRecords.customerId, id), isNull(maintenanceRecords.deletedAt)));
  return c.json(records);
});

// --- Writes ---

customersRoute.post('/', requireClerkWrite, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.name) return c.json({ error: 'name is required' }, 400);
  const db = getDb(c.env);
  const [row] = await db.insert(customers).values({ name: body.name }).returning();
  return c.json(row, 201);
});

customersRoute.put('/:id', requireClerkWrite, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid body' }, 400);
  const db = getDb(c.env);
  const existing = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, id)).get();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const updateData = { ...body };
  delete updateData.id;
  delete updateData.createdAt;
  delete updateData.deletedAt;
  const [row] = await db.update(customers).set(updateData).where(eq(customers.id, id)).returning();
  return c.json(row);
});

customersRoute.delete('/:id', requireClerkWrite, async (c) => {
  const id = c.req.param('id');
  const db = getDb(c.env);
  const existing = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, id)).get();
  if (!existing) return c.json({ error: 'not found' }, 404);
  await db.update(customers).set({ deletedAt: new Date() }).where(eq(customers.id, id));
  return c.json({ ok: true });
});

// Vehicle CRUD
customersRoute.post('/:id/vehicles', requireClerkWrite, async (c) => {
  const customerId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const machineId = typeof body?.machineId === 'string' ? body.machineId.trim() : null;
  if (!machineId) return c.json({ error: 'machineId is required' }, 400);

  const db = getDb(c.env);
  const cust = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId)).get();
  if (!cust) return c.json({ error: 'customer not found' }, 404);

  const mach = await db.select({ id: machines.id }).from(machines).where(eq(machines.id, machineId)).get();
  if (!mach) return c.json({ error: 'machine not found' }, 400);

  let colorId: string | null = typeof body?.colorId === 'string' && body.colorId.trim() ? body.colorId.trim() : null;
  if (colorId) {
    const col = await db.select({ id: colors.id }).from(colors).where(eq(colors.id, colorId)).get();
    if (!col) colorId = null;
  }

  const [row] = await db
    .insert(customerVehicles)
    .values({
      customerId,
      machineId,
      colorId,
      licensePlate: typeof body?.licensePlate === 'string' && body.licensePlate.trim() ? body.licensePlate.trim() : null,
      frameNumber: typeof body?.frameNumber === 'string' && body.frameNumber.trim() ? body.frameNumber.trim() : null,
      year: typeof body?.year === 'number' ? body.year : null,
      nickname: typeof body?.nickname === 'string' && body.nickname.trim() ? body.nickname.trim() : null,
      notes: typeof body?.notes === 'string' && body.notes.trim() ? body.notes.trim() : null,
    })
    .returning();
  return c.json(row, 201);
});