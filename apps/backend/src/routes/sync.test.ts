import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle as drizzleBun } from 'drizzle-orm/bun-sqlite';
import { syncRoute } from './sync';
import { Hono } from 'hono';
import * as schema from '../db/schema';

// Create in-memory sqlite database and drizzle instance
function createTestDb() {
  const sqlite = new Database(':memory:');
  
  // Enable foreign keys
  sqlite.run('PRAGMA foreign_keys = ON;');

  // Create tables in sqlite
  sqlite.run(`
    CREATE TABLE machines (
      id TEXT PRIMARY KEY,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      type_code TEXT,
      k_code TEXT,
      market TEXT,
      engine_series TEXT,
      frame_series TEXT,
      year_from INTEGER,
      year_to INTEGER,
      catalog_edition TEXT,
      catalog_date TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE machine_variants (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL REFERENCES machines(id),
      name TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'clerk',
      display_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE colors (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL REFERENCES machines(id),
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE assemblies (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL REFERENCES machines(id),
      group_type TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      image_ref TEXT,
      image_code TEXT,
      width INTEGER,
      height INTEGER,
      page_no INTEGER,
      sort_order INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE parts (
      id TEXT PRIMARY KEY,
      name_raw TEXT NOT NULL,
      name_normalized TEXT,
      category TEXT,
      specs TEXT,
      notes TEXT,
      is_current_replacement INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE assembly_items (
      id TEXT PRIMARY KEY,
      assembly_id TEXT NOT NULL REFERENCES assemblies(id),
      ref_no TEXT NOT NULL,
      base_part_id TEXT REFERENCES parts(id),
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE part_numbers (
      id TEXT PRIMARY KEY,
      part_id TEXT NOT NULL REFERENCES parts(id),
      value TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'oem',
      brand TEXT,
      note TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE item_resolutions (
      id TEXT PRIMARY KEY,
      assembly_item_id TEXT NOT NULL REFERENCES assembly_items(id),
      part_number_id TEXT NOT NULL REFERENCES part_numbers(id),
      qty INTEGER NOT NULL DEFAULT 1,
      variant_id TEXT REFERENCES machine_variants(id),
      serial_from TEXT,
      serial_to TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE dots (
      id TEXT PRIMARY KEY,
      assembly_item_id TEXT NOT NULL REFERENCES assembly_items(id),
      x REAL NOT NULL,
      y REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE assembly_links (
      id TEXT PRIMARY KEY,
      from_assembly_id TEXT NOT NULL REFERENCES assemblies(id),
      to_code TEXT NOT NULL,
      to_assembly_id TEXT REFERENCES assemblies(id),
      x REAL,
      y REAL,
      label TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE part_color_variants (
      id TEXT PRIMARY KEY,
      part_id TEXT NOT NULL REFERENCES parts(id),
      color_id TEXT NOT NULL REFERENCES colors(id),
      suffix_code TEXT,
      full_number TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE aliases (
      id TEXT PRIMARY KEY,
      part_id TEXT NOT NULL REFERENCES parts(id),
      term TEXT NOT NULL,
      lang TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE part_substitutes (
      id TEXT PRIMARY KEY,
      part_id TEXT NOT NULL REFERENCES parts(id),
      substitute_part_id TEXT NOT NULL REFERENCES parts(id),
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE service_items (
      id TEXT PRIMARY KEY,
      assembly_id TEXT NOT NULL REFERENCES assemblies(id),
      ref_no TEXT,
      name TEXT NOT NULL,
      frt_hours REAL,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      phone_alt TEXT,
      email TEXT,
      address TEXT,
      notes TEXT,
      tag TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE customer_vehicles (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      machine_id TEXT NOT NULL REFERENCES machines(id),
      license_plate TEXT,
      frame_number TEXT,
      color_id TEXT REFERENCES colors(id),
      year INTEGER,
      nickname TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE maintenance_records (
      id TEXT PRIMARY KEY,
      customer_vehicle_id TEXT REFERENCES customer_vehicles(id),
      customer_id TEXT NOT NULL REFERENCES customers(id),
      type TEXT NOT NULL,
      date INTEGER NOT NULL,
      description TEXT NOT NULL,
      technician_id TEXT REFERENCES users(id),
      clerk_id TEXT REFERENCES users(id),
      invoice_number TEXT,
      total_amount INTEGER,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE maintenance_items (
      id TEXT PRIMARY KEY,
      maintenance_record_id TEXT NOT NULL REFERENCES maintenance_records(id),
      category TEXT NOT NULL,
      part_id TEXT REFERENCES parts(id),
      part_number_id TEXT REFERENCES part_numbers(id),
      part_number TEXT,
      brand TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      has_warranty INTEGER NOT NULL DEFAULT 0,
      warranty_period_value INTEGER,
      warranty_period_unit TEXT,
      warranty_start_date INTEGER,
      warranty_expiry_date INTEGER,
      warranty_notes TEXT,
      unit_price INTEGER,
      notes TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `);

  const db = drizzleBun(sqlite, { schema });

  return { sqlite, db };
}

// Build a test app wrapping syncRoute
function createTestApp(testDb: { sqlite: Database; db: any }) {
  const app = new Hono<{ Bindings: any }>();
  
  // Inject mock env.DB
  app.use('*', async (c, next) => {
    const createD1Stmt = (sql: string, params: any[] = []) => {
      const statement = {
        bind: (...newParams: any[]) => createD1Stmt(sql, newParams),
        get: async () => testDb.sqlite.prepare(sql).get(...params),
        all: async () => ({ success: true, results: testDb.sqlite.prepare(sql).all(...params) }),
        run: async () => {
          const res = testDb.sqlite.prepare(sql).run(...params);
          return { success: true, meta: { changes: res.changes } };
        },
        raw: async () => testDb.sqlite.prepare(sql).values(...params),
        first: async (colName?: string) => {
          const row = testDb.sqlite.prepare(sql).get(...params) as any;
          if (!row) return null;
          if (colName) return row[colName];
          return Object.values(row)[0];
        },
      };
      return statement;
    };

    c.env = {
      ...c.env,
      CLERK_TOKEN: 'test-clerk-token',
      DB: {
        prepare: (sql: string) => createD1Stmt(sql),
      },
    };
    await next();
  });

  app.route('/sync', syncRoute);
  return app;
}

describe('Sync Route Integration Tests', () => {
  let testDb: ReturnType<typeof createTestDb>;
  let app: ReturnType<typeof createTestApp>;
  const headers = {
    'Authorization': 'Bearer test-clerk-token',
    'Content-Type': 'application/json',
  };

  beforeEach(() => {
    testDb = createTestDb();
    app = createTestApp(testDb);

    // Seed machine row for customer_vehicles foreign key constraint
    testDb.sqlite.run(`
      INSERT INTO machines (id, brand, model, created_at, updated_at)
      VALUES ('m1', 'Honda', 'BeAT', 1000, 1000);
    `);
  });

  test('POST /sync/push handles out-of-order payload (children before parents) without FK errors', async () => {
    // Payload sends maintenanceItems -> maintenanceRecords -> customerVehicles -> customers
    const payload = {
      tables: {
        maintenanceItems: [
          {
            id: 'item-1',
            maintenanceRecordId: 'rec-1',
            category: 'oil',
            quantity: 1,
            unitPrice: 50000,
          },
        ],
        maintenanceRecords: [
          {
            id: 'rec-1',
            customerId: 'cust-1',
            customerVehicleId: 'veh-1',
            type: 'service',
            description: 'Standard Service',
          },
        ],
        customerVehicles: [
          {
            id: 'veh-1',
            customerId: 'cust-1',
            machineId: 'm1',
            licensePlate: 'B 1234 ABC',
          },
        ],
        customers: [
          {
            id: 'cust-1',
            name: 'Budi Santoso',
            phone: '08123456789',
          },
        ],
      },
    };

    const res = await app.request('/sync/push', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.processed.customers).toEqual({ inserted: 1, updated: 0, deleted: 0 });
    expect(body.processed.customerVehicles).toEqual({ inserted: 1, updated: 0, deleted: 0 });
    expect(body.processed.maintenanceRecords).toEqual({ inserted: 1, updated: 0, deleted: 0 });
    expect(body.processed.maintenanceItems).toEqual({ inserted: 1, updated: 0, deleted: 0 });

    // Verify database contents
    const cust = testDb.sqlite.prepare('SELECT * FROM customers WHERE id = ?').get('cust-1');
    expect(cust).not.toBeNull();
    const veh = testDb.sqlite.prepare('SELECT * FROM customer_vehicles WHERE id = ?').get('veh-1');
    expect(veh).not.toBeNull();
    const rec = testDb.sqlite.prepare('SELECT * FROM maintenance_records WHERE id = ?').get('rec-1');
    expect(rec).not.toBeNull();
    const item = testDb.sqlite.prepare('SELECT * FROM maintenance_items WHERE id = ?').get('item-1');
    expect(item).not.toBeNull();
  });

  test('POST /sync/push converts empty strings "" for optional FK fields to null', async () => {
    const payload = {
      tables: {
        customers: [{ id: 'cust-2', name: 'Siti' }],
        customerVehicles: [
          {
            id: 'veh-2',
            customerId: 'cust-2',
            machineId: 'm1',
            colorId: '   ', // empty string with spaces
          },
        ],
        maintenanceRecords: [
          {
            id: 'rec-2',
            customerId: 'cust-2',
            customerVehicleId: '', // empty string
            type: 'service',
            description: 'Checkup',
            technicianId: '', // empty string
            clerkId: '', // empty string
          },
        ],
      },
    };

    const res = await app.request('/sync/push', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);

    const rec = testDb.sqlite.prepare('SELECT * FROM maintenance_records WHERE id = ?').get('rec-2') as any;
    expect(rec.customer_vehicle_id).toBeNull();
    expect(rec.technician_id).toBeNull();
    expect(rec.clerk_id).toBeNull();
  });

  test('POST /sync/push sanitizes non-existent optional FK references without failing FK constraints', async () => {
    const payload = {
      tables: {
        customers: [{ id: 'cust-3', name: 'Andi' }],
        maintenanceRecords: [
          {
            id: 'rec-3',
            customerId: 'cust-3',
            type: 'purchase',
            description: 'Part Purchase',
            technicianId: 'user-does-not-exist',
            clerkId: 'user-does-not-exist-2',
          },
        ],
        maintenanceItems: [
          {
            id: 'item-3',
            maintenanceRecordId: 'rec-3',
            category: 'sprocket',
            partId: 'part-does-not-exist',
            partNumberId: 'pn-does-not-exist',
            quantity: 2,
          },
        ],
      },
    };

    const res = await app.request('/sync/push', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);

    const rec = testDb.sqlite.prepare('SELECT * FROM maintenance_records WHERE id = ?').get('rec-3') as any;
    expect(rec.technician_id).toBeNull();
    expect(rec.clerk_id).toBeNull();

    const item = testDb.sqlite.prepare('SELECT * FROM maintenance_items WHERE id = ?').get('item-3') as any;
    expect(item.part_id).toBeNull();
    expect(item.part_number_id).toBeNull();
  });

  test('POST /sync/push updates existing records and handles soft-deletes correctly', async () => {
    // 1. Initial push
    const initialPayload = {
      tables: {
        customers: [{ id: 'cust-4', name: 'Dewi' }],
      },
    };

    await app.request('/sync/push', {
      method: 'POST',
      headers,
      body: JSON.stringify(initialPayload),
    });

    // 2. Update push
    const updatePayload = {
      tables: {
        customers: [{ id: 'cust-4', name: 'Dewi Maharani', phone: '0899999999' }],
      },
    };

    const updateRes = await app.request('/sync/push', {
      method: 'POST',
      headers,
      body: JSON.stringify(updatePayload),
    });

    expect(updateRes.status).toBe(200);
    const updateBody: any = await updateRes.json();
    expect(updateBody.processed.customers).toEqual({ inserted: 0, updated: 1, deleted: 0 });

    const updatedCust = testDb.sqlite.prepare('SELECT * FROM customers WHERE id = ?').get('cust-4') as any;
    expect(updatedCust.name).toBe('Dewi Maharani');

    // 3. Soft-delete push
    const deletePayload = {
      tables: {
        customers: [{ id: 'cust-4', name: 'Dewi Maharani', deletedAt: new Date().toISOString() }],
      },
    };

    const deleteRes = await app.request('/sync/push', {
      method: 'POST',
      headers,
      body: JSON.stringify(deletePayload),
    });

    expect(deleteRes.status).toBe(200);
    const deleteBody: any = await deleteRes.json();
    expect(deleteBody.processed.customers).toEqual({ inserted: 0, updated: 0, deleted: 1 });

    const deletedCust = testDb.sqlite.prepare('SELECT * FROM customers WHERE id = ?').get('cust-4') as any;
    expect(deletedCust.deleted_at).not.toBeNull();
  });

  test('POST /sync/push skips rows with invalid required FK references without returning 500 error', async () => {
    const payload = {
      tables: {
        customerVehicles: [
          {
            id: 'veh-bad-machine',
            customerId: 'cust-1', // valid if cust-1 is pushed
            machineId: 'non-existent-machine', // INVALID
            licensePlate: 'B 9999 ERR',
          },
        ],
        maintenanceRecords: [
          {
            id: 'rec-bad-cust',
            customerId: 'non-existent-customer', // INVALID
            type: 'service',
            description: 'Invalid Customer Test',
          },
        ],
        maintenanceItems: [
          {
            id: 'item-bad-rec',
            maintenanceRecordId: 'non-existent-record', // INVALID
            category: 'oil',
            quantity: 1,
          },
        ],
      },
    };

    const res = await app.request('/sync/push', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
    expect(body.processed.customerVehicles).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(body.processed.maintenanceRecords).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(body.processed.maintenanceItems).toEqual({ inserted: 0, updated: 0, deleted: 0 });
  });

  test('GET /sync returns synced tables and pagination delta cursor', async () => {
    // Seed database
    testDb.sqlite.run(`
      INSERT INTO customers (id, name, created_at, updated_at)
      VALUES ('cust-10', 'Test Customer', 5000, 5000);
    `);

    const res = await app.request('/sync?since=0', {
      method: 'GET',
      headers,
    });

    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.since).toBe(0);
    expect(body.tables.customers).toBeDefined();
    expect(body.tables.customers.length).toBe(1);
    expect(body.tables.customers[0].id).toBe('cust-10');
  });
});
