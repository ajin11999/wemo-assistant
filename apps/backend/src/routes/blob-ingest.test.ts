import { describe, test, expect } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { Database } from 'bun:sqlite';
import { drizzle as drizzleBun } from 'drizzle-orm/bun-sqlite';
import { ingestRoute } from './ingest';
import { assembliesRoute } from './assemblies';
import { Hono } from 'hono';
import * as schema from '../db/schema';

describe('Blob Ingest End-to-End Integration', () => {
  const blobPath = path.resolve(__dirname, '../../backups/beat-kvy-blob.json');

  test('validates and ingests Honda BeAT KVY 50-page blob', async () => {
    expect(fs.existsSync(blobPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(blobPath, 'utf8'));

    expect(raw.version).toBe(1);
    expect(raw.pages.length).toBe(50);
    expect(raw.machineHint.model).toBe('BeAT');

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
      CREATE TABLE colors (
        id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id),
        code TEXT NOT NULL, name TEXT NOT NULL,
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
        id TEXT PRIMARY KEY, assembly_item_id TEXT NOT NULL REFERENCES assembly_items(id),
        x REAL NOT NULL, y REAL NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE service_items (
        id TEXT PRIMARY KEY, assembly_id TEXT NOT NULL REFERENCES assemblies(id),
        ref_no TEXT, name TEXT NOT NULL, frt_hours REAL, note TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);

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

    const r2Store = new Map<string, any>();
    const mockR2 = {
      put: async (key: string, val: any) => {
        r2Store.set(key, val);
        return {};
      },
      get: async (key: string) => (r2Store.get(key) ? { body: r2Store.get(key) } : null),
    };

    const app = new Hono<{ Bindings: any }>();
    app.use('*', async (c, next) => {
      c.env = {
        ADMIN_TOKEN: 'test-token',
        DB: { prepare: (sql: string) => createD1Stmt(sql) },
        IMAGES: mockR2,
      };
      await next();
    });
    app.route('/ingest', ingestRoute);
    app.route('/assemblies', assembliesRoute);

    // 1. Seed machine
    sqlite.run(`INSERT INTO machines (id, brand, model, created_at, updated_at) VALUES ("m-beat", "Honda", "BeAT KVY", 1000, 1000);`);

    // 2. Extract distinct numbers from blob
    const numberSet = new Set<string>();
    for (const p of raw.pages) {
      for (const it of p.extracted.items) {
        for (const pn of it.partNumbers) {
          if (pn.value.trim()) numberSet.add(pn.value.trim());
        }
      }
    }
    const distinctNumbers = [...numberSet];
    expect(distinctNumbers.length).toBeGreaterThan(500);

    // 3. Test Preview endpoint with 560+ numbers (tests D1 chunking!)
    const prevRes = await app.request('/ingest/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ numbers: distinctNumbers }),
    });
    expect(prevRes.status).toBe(200);
    const prevJson = (await prevRes.json()) as any;
    expect(prevJson.results.length).toBe(distinctNumbers.length);
    expect(prevJson.results.every((r: any) => !r.found)).toBe(true);

    // 4. Commit all 50 pages sequentially
    for (const p of raw.pages) {
      const commitRes = await app.request('/ingest/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: JSON.stringify({
          machineId: 'm-beat',
          groupType: p.groupType,
          extracted: p.extracted,
        }),
      });
      expect(commitRes.status).toBe(201);
      const commitJson = (await commitRes.json()) as any;
      expect(commitJson.ok).toBe(true);

      // Upload image
      if (p.diagramCropBase64 && p.width && p.height) {
        const imgRes = await app.request(`/assemblies/${commitJson.summary.assemblyId}/image`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
          body: JSON.stringify({
            imageBase64: p.diagramCropBase64,
            mediaType: p.mediaType,
            width: p.width,
            height: p.height,
          }),
        });
        expect(imgRes.status).toBe(200);
      }
    }

    // 5. Verify database records
    const rowCounts = {
      assemblies: (sqlite.prepare('SELECT count(*) as c FROM assemblies').get() as any).c,
      assemblyItems: (sqlite.prepare('SELECT count(*) as c FROM assembly_items').get() as any).c,
      parts: (sqlite.prepare('SELECT count(*) as c FROM parts').get() as any).c,
      partNumbers: (sqlite.prepare('SELECT count(*) as c FROM part_numbers').get() as any).c,
      resolutions: (sqlite.prepare('SELECT count(*) as c FROM item_resolutions').get() as any).c,
      serviceItems: (sqlite.prepare('SELECT count(*) as c FROM service_items').get() as any).c,
      images: r2Store.size,
    };

    expect(rowCounts.assemblies).toBe(47); // 50 pages: 17 engine + 29 frame + 1 sub-assembly (F-17-1) = 47 assemblies
    expect(rowCounts.parts).toBeGreaterThan(500);
    expect(rowCounts.partNumbers).toBe(distinctNumbers.length);
    expect(rowCounts.images).toBe(47);

    // 6. Verify second preview (all numbers should now be found)
    const prevRes2 = await app.request('/ingest/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ numbers: distinctNumbers }),
    });
    expect(prevRes2.status).toBe(200);
    const prevJson2 = (await prevRes2.json()) as any;
    expect(prevJson2.results.every((r: any) => r.found)).toBe(true);
  });
});
