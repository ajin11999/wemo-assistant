import fs from 'fs';
import { execSync } from 'child_process';
import crypto from 'crypto';
import path from 'path';

interface GeminiDot {
  refNo: string;
  x: number;
  y: number;
}

const BLOB_PATH = 'apps/backend/backups/beat-kvy-blob.json';
const SQL_PATH = 'apps/backend/backups/insert-dots.sql';
const MACHINE_ID = '07640200-970c-4cbc-aa83-776a3fcfbaa0';
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('GEMINI_API_KEY not found in environment.');
  process.exit(1);
}

// Locate balloon callout coordinates using Gemini Vision with timeout & retry
async function locateDotsForCrop(code: string, name: string, items: { refNo: string }[], cropBase64: string): Promise<GeminiDot[]> {
  const refList = [...new Set(items.map((i) => i.refNo))].join(', ');
  const prompt = `This is an exploded diagram from a Honda parts catalog for assembly ${code} (${name}).
On the drawing, parts are labeled with numbered balloon callout circles with numbers: ${refList}.
For each numbered balloon callout visible on the diagram, identify its normalized (x, y) center coordinates where:
- x is between 0.0 (left edge) and 1.0 (right edge)
- y is between 0.0 (top edge) and 1.0 (bottom edge)

Return a pure JSON array in this exact format with NO extra text or markdown:
[
  { "refNo": "1", "x": 0.25, "y": 0.35 }
]`;

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inline_data: {
              mime_type: 'image/png',
              data: cropBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.1,
    },
  };

  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const model = attempt % 2 === 0 ? 'gemini-3.1-flash-lite' : 'gemini-3.5-flash-lite';
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000), // 20-second timeout prevents indefinite hangs
      });

      if (res.status === 429 || res.status >= 500) {
        const waitSec = Math.min(30, 3 * attempt);
        console.warn(`  [Status ${res.status} for ${code}] Waiting ${waitSec}s before retry (attempt ${attempt}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }

      if (!res.ok) {
        console.error(`Gemini API error for ${code}:`, res.status, await res.text());
        return [];
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return [];

      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.filter((d) => typeof d.refNo === 'string' && typeof d.x === 'number' && typeof d.y === 'number');
      }
      return [];
    } catch (err: any) {
      console.warn(`  [Attempt ${attempt} ${err.name || 'error'} for ${code}]: ${err.message}`);
      if (attempt < maxRetries) {
        const waitSec = Math.min(20, 2 * attempt);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
      }
    }
  }

  return [];
}

async function main() {
  console.log('1. Loading blob from:', BLOB_PATH);
  const blob = JSON.parse(fs.readFileSync(BLOB_PATH, 'utf8'));

  console.log('2. Fetching remote assembly_items mapping from D1...');
  const out = execSync(`npx wrangler d1 execute wemo-assistant --remote --json --command "SELECT a.code as asm_code, ai.id as item_id, ai.ref_no FROM assembly_items ai JOIN assemblies a ON a.id = ai.assembly_id WHERE a.machine_id = '${MACHINE_ID}'"`, {
    cwd: 'apps/backend',
  }).toString();
  const parsedOut = JSON.parse(out);
  const rows: { asm_code: string; item_id: string; ref_no: string }[] = parsedOut[0]?.results ?? [];
  const itemIdByAsmAndRef = new Map<string, string>();
  for (const r of rows) {
    itemIdByAsmAndRef.set(`${r.asm_code}:${r.ref_no}`, r.item_id);
  }
  console.log(`Mapped ${itemIdByAsmAndRef.size} assembly items.`);

  console.log('3. Detecting balloon callouts via Gemini 3.6 Flash...');
  for (let i = 0; i < blob.pages.length; i++) {
    const page = blob.pages[i];
    const { code, name } = page.extracted.assembly;

    if (!page.diagramCropBase64) {
      console.log(`[${i + 1}/${blob.pages.length}] Assembly ${code} has no diagram crop, skipping.`);
      continue;
    }

    const existingDotsCount = page.extracted.items.reduce((sum: number, it: any) => sum + (it.dots?.length ?? 0), 0);
    if (existingDotsCount > 0) {
      console.log(`[${i + 1}/${blob.pages.length}] Assembly ${code} · ${name} already has ${existingDotsCount} dots, skipping.`);
      continue;
    }

    console.log(`[${i + 1}/${blob.pages.length}] Detecting dots for ${code} · ${name} (${page.extracted.items.length} items)...`);
    const dots = await locateDotsForCrop(code, name, page.extracted.items, page.diagramCropBase64);
    console.log(`  -> Found ${dots.length} dots.`);

    // Update blob item dots
    for (const item of page.extracted.items) {
      const itemDots = dots.filter((d) => d.refNo === item.refNo);
      item.dots = itemDots.map((d) => ({
        x: Math.round(d.x * 1000) / 1000,
        y: Math.round(d.y * 1000) / 1000,
      }));
    }

    // Save incrementally so progress is preserved
    fs.writeFileSync(BLOB_PATH, JSON.stringify(blob, null, 2));

    // Throttle to respect rate limits
    await new Promise((r) => setTimeout(r, 2000));
  }

  // 4. Gather ALL dots across the blob
  console.log('\n4. Consolidating all detected dots across catalog...');
  const sqlValues: string[] = [];
  const now = new Date().toISOString();
  let totalDots = 0;

  for (const page of blob.pages) {
    const { code } = page.extracted.assembly;
    for (const item of page.extracted.items) {
      if (!item.dots || item.dots.length === 0) continue;
      const itemId = itemIdByAsmAndRef.get(`${code}:${item.refNo}`);
      if (!itemId) continue;
      for (const d of item.dots) {
        const dotId = crypto.randomUUID();
        sqlValues.push(`('${dotId}', '${itemId}', ${d.x}, ${d.y}, '${now}', '${now}')`);
        totalDots++;
      }
    }
  }

  console.log(`Total dots consolidated: ${totalDots}`);

  // Copy to Windows Desktop
  const destDesktop = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/beat-kvy-blob.json';
  if (fs.existsSync('/mnt/c/Users/frans/OneDrive/Desktop/catalog honda')) {
    fs.copyFileSync(BLOB_PATH, destDesktop);
    console.log('Copied updated blob to Windows desktop:', destDesktop);
  }

  if (sqlValues.length > 0) {
    console.log(`5. Generating SQL to sync ${sqlValues.length} dots to remote D1...`);
    const deleteSql = `UPDATE dots SET deleted_at = CURRENT_TIMESTAMP WHERE assembly_item_id IN (SELECT ai.id FROM assembly_items ai JOIN assemblies a ON a.id = ai.assembly_id WHERE a.machine_id = '${MACHINE_ID}') AND deleted_at IS NULL;`;

    // Write in chunks of 500 rows per INSERT
    const CHUNK = 500;
    const statements: string[] = [deleteSql];
    for (let i = 0; i < sqlValues.length; i += CHUNK) {
      const chunk = sqlValues.slice(i, i + CHUNK);
      statements.push(`INSERT INTO dots (id, assembly_item_id, x, y, created_at, updated_at) VALUES\n${chunk.join(',\n')};`);
    }

    const fullSqlPath = path.resolve(SQL_PATH);
    fs.writeFileSync(fullSqlPath, statements.join('\n\n'));
    console.log('Wrote SQL file to:', fullSqlPath);

    console.log('6. Executing SQL against remote D1...');
    execSync(`npx wrangler d1 execute wemo-assistant --remote --yes --file=${fullSqlPath}`, {
      cwd: 'apps/backend',
      stdio: 'inherit',
    });
    console.log('Remote D1 updated successfully!');
  }
}

main().catch(console.error);
