import { Hono } from 'hono';
import type { Bindings } from './bindings';
import { requireAdmin, requireClerkRead } from './middleware/auth';
import { machinesRoute } from './routes/machines';
import { assembliesRoute } from './routes/assemblies';
import { partsRoute } from './routes/parts';
import { ingestRoute } from './routes/ingest';
import { syncRoute } from './routes/sync';
import { chatRoute } from './routes/chat';
import { adminRoute } from './routes/admin';
import { settingsRoute } from './routes/settings';
import { customersRoute } from './routes/customers';
import { vehiclesRoute } from './routes/vehicles';
import { recordsRoute } from './routes/records';
import { recordItemsRoute } from './routes/record-items';
import { statsRoute } from './routes/stats';

const app = new Hono<{ Bindings: Bindings }>();

app.onError((err, c) => {
  console.error('Unhandled server error:', err);
  return c.json({ error: err.message || 'Internal Server Error' }, 500);
});

app.get('/', (c) => c.json({ name: 'wemo-backend', status: 'ok' }));

// DB connectivity check that does not depend on migrations having run.
app.get('/health', async (c) => {
  const row = await c.env.DB.prepare('select 1 as ok').first<{ ok: number }>();
  return c.json({ ok: row?.ok === 1 });
});

// Admin-token check (no side effects) — used by the admin Settings "Test connection".
app.get('/auth/check', requireAdmin, (c) => c.json({ ok: true }));

// Clerk-token check (no side effects) — used by the mobile app to validate the key on save.
app.get('/auth/clerk-check', requireClerkRead, (c) => c.json({ ok: true }));

app.route('/machines', machinesRoute);
app.route('/assemblies', assembliesRoute);
app.route('/parts', partsRoute);
app.route('/ingest', ingestRoute);
app.route('/sync', syncRoute);
app.route('/chat', chatRoute);
app.route('/admin', adminRoute);
app.route('/settings', settingsRoute);

// CRM Routes
app.route('/customers', customersRoute);
app.route('/vehicles', vehiclesRoute);
app.route('/records', recordsRoute);
app.route('/record-items', recordItemsRoute);
app.route('/stats', statsRoute);

export default app;
export type { Bindings };
