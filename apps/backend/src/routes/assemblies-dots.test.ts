import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { assembliesRoute } from './assemblies';

describe('Assemblies Dots & Query Chunking', () => {
  function setupTestApp() {
    const sqlite = new Database(':memory:');
    sqlite.run('PRAGMA foreign_keys = ON;');
    sqlite.run(`
      CREATE TABLE machines (
        id TEXT PRIMARY KEY, brand TEXT NOT NULL, model TEXT NOT NULL,
        type_code TEXT, k_code TEXT, market TEXT, engine_series TEXT, frame_series TEXT,
        year_from INTEGER, year_to INTEGER, catalog_edition TEXT, catalog_date TEXT, notes TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE machine_variants (
        id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id),
        name TEXT NOT NULL, note TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE assemblies (
        id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id),
        group_type TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
        image_ref TEXT, image_code TEXT, width INTEGER, height INTEGER,
        page_no INTEGER, sort_order INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE parts (
        id TEXT PRIMARY KEY, name_raw TEXT NOT NULL, name_normalized TEXT,
        category TEXT, specs TEXT, notes TEXT, is_current_replacement INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE assembly_items (
        id TEXT PRIMARY KEY, assembly_id TEXT NOT NULL REFERENCES assemblies(id),
        ref_no TEXT NOT NULL, base_part_id TEXT REFERENCES parts(id), note TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE part_numbers (
        id TEXT PRIMARY KEY, part_id TEXT NOT NULL REFERENCES parts(id),
        value TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'oem', brand TEXT, note TEXT, is_primary INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE item_resolutions (
        id TEXT PRIMARY KEY, assembly_item_id TEXT NOT NULL REFERENCES assembly_items(id),
        part_number_id TEXT NOT NULL REFERENCES part_numbers(id),
        qty INTEGER NOT NULL DEFAULT 1, variant_id TEXT REFERENCES machine_variants(id),
        serial_from TEXT, serial_to TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE dots (
        id TEXT PRIMARY KEY NOT NULL, assembly_item_id TEXT NOT NULL REFERENCES assembly_items(id),
        x REAL NOT NULL, y REAL NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE service_items (
        id TEXT PRIMARY KEY, assembly_id TEXT NOT NULL REFERENCES assemblies(id),
        ref_no TEXT NOT NULL, description TEXT NOT NULL, frt REAL NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
    `);

    sqlite.run("INSERT INTO machines (id, brand, model, created_at, updated_at) VALUES ('m1', 'Honda', 'BeAT', 1, 1);");
    sqlite.run("INSERT INTO assemblies (id, machine_id, group_type, code, name, created_at, updated_at) VALUES ('asm1', 'm1', 'engine', 'E-1', 'Cylinder', 1, 1);");
    sqlite.run("INSERT INTO parts (id, name_raw, created_at, updated_at) VALUES ('p1', 'Gasket', 1, 1);");
    sqlite.run("INSERT INTO assembly_items (id, assembly_id, ref_no, base_part_id, created_at, updated_at) VALUES ('item1', 'asm1', '1', 'p1', 1, 1);");

    const createD1Stmt = (sql: string, params: any[] = []) => ({
      bind: (...newParams: any[]) => createD1Stmt(sql, newParams),
      get: async () => sqlite.prepare(sql).get(...params),
      all: async () => ({ success: true, results: sqlite.prepare(sql).all(...params) }),
      run: async () => {
        const res = sqlite.prepare(sql).run(...params);
        return { success: true, meta: { changes: res.changes } };
      },
      raw: async () => sqlite.prepare(sql).values(...params),
      first: async (colName?: string) => {
        const row = sqlite.prepare(sql).get(...params) as any;
        if (!row) return null;
        return colName ? row[colName] : Object.values(row)[0];
      },
    });

    const mockD1 = {
      prepare: (sql: string) => createD1Stmt(sql),
      batch: async (stmts: any[]) => {
        const res = [];
        for (const s of stmts) {
          res.push(await s.run());
        }
        return res;
      },
    };

    const app = new Hono<{ Bindings: any }>();
    app.onError((err, c) => c.json({ error: err.message }, 500));
    app.use('*', async (c, next) => {
      c.env = { DB: mockD1, ADMIN_TOKEN: 'secret' };
      await next();
    });
    app.route('/assemblies', assembliesRoute);

    return { app, sqlite };
  }

  test('saves initial dot and then saves second dot on already marked item', async () => {
    const { app, sqlite } = setupTestApp();

    // 1. Save 1 dot on item1
    let res = await app.request('/assemblies/asm1/dots', {
      method: 'PUT',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ dots: [{ assemblyItemId: 'item1', x: 0.1, y: 0.2 }] }),
    });
    expect(res.status).toBe(200);
    const body1 = await res.json();
    expect(body1).toEqual({ ok: true, count: 1 });

    // Verify 1 active dot
    let fullRes = await app.request('/assemblies/asm1/full');
    let full = await fullRes.json();
    expect(full.items[0].dots.length).toBe(1);
    expect(full.items[0].dots[0].x).toBe(0.1);

    // 2. Save 2 dots on the already marked item
    res = await app.request('/assemblies/asm1/dots', {
      method: 'PUT',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dots: [
          { assemblyItemId: 'item1', x: 0.1, y: 0.2 },
          { assemblyItemId: 'item1', x: 0.5, y: 0.6 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body2 = await res.json();
    expect(body2).toEqual({ ok: true, count: 2 });

    // Verify 2 active dots in full assembly query
    fullRes = await app.request('/assemblies/asm1/full');
    full = await fullRes.json();
    expect(full.items[0].dots.length).toBe(2);

    // Verify DB contains 1 soft-deleted and 2 active dots
    const allDots = sqlite.prepare('SELECT * FROM dots').all() as any[];
    expect(allDots.length).toBe(3);
    const activeDots = allDots.filter((d) => d.deleted_at === null);
    const deletedDots = allDots.filter((d) => d.deleted_at !== null);
    expect(activeDots.length).toBe(2);
    expect(deletedDots.length).toBe(1);
  });

  test('handles chunking for assembly with > 100 items without error', async () => {
    const { app, sqlite } = setupTestApp();

    // Insert 120 items into asm1
    for (let i = 2; i <= 120; i++) {
      sqlite.run(
        `INSERT INTO assembly_items (id, assembly_id, ref_no, created_at, updated_at) VALUES ('item${i}', 'asm1', '${i}', 1, 1);`,
      );
    }

    // Save dots for 25 items (tests multi-chunk update and insert)
    const dotsPayload = Array.from({ length: 25 }, (_, i) => ({
      assemblyItemId: `item${i + 1}`,
      x: 0.1,
      y: 0.1,
    }));

    const res = await app.request('/assemblies/asm1/dots', {
      method: 'PUT',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ dots: dotsPayload }),
    });
    expect(res.status).toBe(200);

    // Verify GET /full with 120 items chunks correctly
    const fullRes = await app.request('/assemblies/asm1/full');
    expect(fullRes.status).toBe(200);
    const full = await fullRes.json();
    expect(full.items.length).toBe(120);
  });

  test('returns 400 when dot references non-existent or soft-deleted item', async () => {
    const { app, sqlite } = setupTestApp();

    sqlite.run("INSERT INTO assembly_items (id, assembly_id, ref_no, created_at, updated_at, deleted_at) VALUES ('item-del', 'asm1', '99', 1, 1, 100);");

    const res = await app.request('/assemblies/asm1/dots', {
      method: 'PUT',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ dots: [{ assemblyItemId: 'item-del', x: 0.1, y: 0.2 }] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('dot references an item not in this assembly');
  });
});
