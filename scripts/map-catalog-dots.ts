import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';

interface GeminiDot {
  refNo: string;
  x: number;
  y: number;
}

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('ERROR: GEMINI_API_KEY not found in environment.');
  process.exit(1);
}

function runD1Sql(sql: string) {
  const tmpFile = `/tmp/d1_dots_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`;
  fs.writeFileSync(tmpFile, sql);
  try {
    execSync(`npx wrangler d1 execute wemo-assistant --remote --file="${tmpFile}"`, {
      cwd: 'apps/backend',
      stdio: 'pipe',
    });
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

function queryD1Json(command: string): any[] {
  try {
    const out = execSync(`npx wrangler d1 execute wemo-assistant --remote --json --command "${command.replace(/"/g, '\\"')}"`, {
      cwd: 'apps/backend',
    }).toString();
    const parsed = JSON.parse(out);
    return parsed[0]?.results ?? [];
  } catch (err: any) {
    console.error('D1 query failed:', err.message);
    return [];
  }
}

function normalizeCoordinate(val: any): number | null {
  if (typeof val !== 'number' || isNaN(val)) return null;
  let num = val;
  // If model missed the decimal point (e.g. 745 instead of 0.745 or 499 instead of 0.499)
  if (num > 1.0 && num <= 1000.0) {
    num = num / 1000.0;
  }
  if (num >= 0.0 && num <= 1.0) {
    return Math.round(num * 10000) / 10000;
  }
  return null;
}

async function detectBalloonDots(
  code: string,
  name: string,
  validRefNos: string[],
  cropBase64: string
): Promise<{ dots: GeminiDot[]; rejected: any[] }> {
  const refList = validRefNos.join(', ');
  const prompt = `This is an exploded diagram from a vehicle parts catalog for assembly ${code} (${name}).
On the drawing, parts are labeled with numbered balloon callout circles with numbers: ${refList}.
For each numbered balloon callout visible on the diagram, identify its normalized (x, y) center coordinates where:
- x is a decimal number between 0.0 (left edge) and 1.0 (right edge)
- y is a decimal number between 0.0 (top edge) and 1.0 (bottom edge)

Return a pure JSON array in this exact format with NO markdown:
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

  const models = ['gemini-3.1-flash-lite', 'gemini-flash-latest'];
  const maxRetries = 4;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const model = models[(attempt - 1) % models.length];
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });

      if (res.status === 429 || res.status === 503 || res.status >= 500) {
        const waitSec = Math.min(45, 5 * attempt);
        console.warn(`    ⚠️ [${model} status ${res.status}] Backing off ${waitSec}s (attempt ${attempt}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }

      if (!res.ok) {
        console.error(`    ❌ API error ${res.status}:`, (await res.text()).slice(0, 150));
        return { dots: [], rejected: [] };
      }

      const data = await res.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) return { dots: [], rejected: [] };

      let parsed: any[] = [];
      try {
        const cleanedText = rawText.replace(/,\s*([\]}])/g, '$1');
        parsed = JSON.parse(cleanedText);
      } catch (err: any) {
        console.warn(`    ⚠️ JSON parse error on response: ${err.message}`);
        return { dots: [], rejected: [] };
      }

      if (!Array.isArray(parsed)) return { dots: [], rejected: [] };

      // Normalization & Strict Catalog Rechecking:
      const validRefSet = new Set(validRefNos.map((r) => r.trim().toLowerCase()));
      const validNumericMap = new Map<number, string>();
      for (const r of validRefNos) {
        const n = parseInt(r, 10);
        if (!isNaN(n)) validNumericMap.set(n, r);
      }

      const acceptedDots: GeminiDot[] = [];
      const rejectedDots: any[] = [];

      for (const item of parsed) {
        const rawRef = String(item.refNo ?? '').trim();
        const rawRefLower = rawRef.toLowerCase();

        // 1. Resolve refNo against catalog
        let matchedRef: string | null = null;
        if (validRefSet.has(rawRefLower)) {
          matchedRef = validRefNos.find((r) => r.trim().toLowerCase() === rawRefLower) ?? rawRef;
        } else {
          const num = parseInt(rawRef, 10);
          if (!isNaN(num) && validNumericMap.has(num)) {
            matchedRef = validNumericMap.get(num)!;
          }
        }

        if (!matchedRef) {
          rejectedDots.push({ reason: 'refNo not in catalog table', item });
          continue;
        }

        // 2. Validate coordinates
        const normX = normalizeCoordinate(item.x);
        const normY = normalizeCoordinate(item.y);

        if (normX === null || normY === null) {
          rejectedDots.push({ reason: 'invalid coordinates', item });
          continue;
        }

        acceptedDots.push({
          refNo: matchedRef,
          x: normX,
          y: normY,
        });
      }

      return { dots: acceptedDots, rejected: rejectedDots };
    } catch (err: any) {
      console.warn(`    ⚠️ [Attempt ${attempt} error]: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }

  return { dots: [], rejected: [] };
}

export async function mapCatalogDots(blobPath: string, machineId: string, options: { force?: boolean } = {}) {
  console.log(`\n======================================================`);
  console.log(`STARTING DOT MAPPING & CATALOG RECHECK`);
  console.log(`Blob: ${blobPath}`);
  console.log(`Machine ID: ${machineId}`);
  console.log(`======================================================\n`);

  if (!fs.existsSync(blobPath)) {
    throw new Error(`Blob file not found: ${blobPath}`);
  }

  const pkg = JSON.parse(fs.readFileSync(blobPath, 'utf8'));
  const machineModel = pkg.machineHint?.model ?? 'Unknown';

  console.log(`1. Fetching assembly items from D1 for ${machineModel}...`);
  const rows = queryD1Json(`
    SELECT a.code as asm_code, a.id as asm_id, ai.id as item_id, ai.ref_no
    FROM assembly_items ai
    JOIN assemblies a ON a.id = ai.assembly_id
    WHERE a.machine_id = '${machineId}' AND a.deleted_at IS NULL AND ai.deleted_at IS NULL;
  `);

  const itemIdByAsmAndRef = new Map<string, string>();
  for (const r of rows) {
    itemIdByAsmAndRef.set(`${r.asm_code}:${r.ref_no}`, r.item_id);
  }
  console.log(`Found ${rows.length} assembly items in D1 across ${new Set(rows.map((r) => r.asm_code)).size} assemblies.`);

  let totalCatalogItems = 0;
  let totalMappedDots = 0;
  let totalRejectedDots = 0;
  let assembliesProcessed = 0;

  for (let i = 0; i < pkg.pages.length; i++) {
    const page = pkg.pages[i];
    const { code, name } = page.extracted.assembly;
    const items = page.extracted.items || [];
    totalCatalogItems += items.length;

    if (!page.diagramCropBase64) {
      console.log(`[${i + 1}/${pkg.pages.length}] ${code} · ${name}: No diagram crop, skipping.`);
      continue;
    }

    const existingDots = items.reduce((acc: number, it: any) => acc + (it.dots?.length || 0), 0);
    if (existingDots > 0 && !options.force) {
      console.log(`[${i + 1}/${pkg.pages.length}] ${code} · ${name}: Already has ${existingDots} dots, skipping.`);
      totalMappedDots += existingDots;
      continue;
    }

    const validRefs = [...new Set(items.map((it: any) => String(it.refNo).trim()))].filter(Boolean);
    if (validRefs.length === 0) {
      console.log(`[${i + 1}/${pkg.pages.length}] ${code} · ${name}: 0 catalog items, skipping.`);
      continue;
    }

    process.stdout.write(`[${i + 1}/${pkg.pages.length}] ${code} · ${name} (${validRefs.length} items)... `);

    const { dots, rejected } = await detectBalloonDots(code, name, validRefs as string[], page.diagramCropBase64);

    // Map dots back to catalog items
    let pageMapped = 0;
    for (const item of items) {
      const matched = dots.filter((d) => d.refNo === item.refNo);
      item.dots = matched.map((d) => ({ x: d.x, y: d.y }));
      pageMapped += matched.length;
    }

    totalMappedDots += pageMapped;
    totalRejectedDots += rejected.length;
    assembliesProcessed++;

    const unmappedCount = items.filter((it: any) => !it.dots || it.dots.length === 0).length;
    console.log(`Mapped: ${pageMapped}/${validRefs.length} | Unmapped parts: ${unmappedCount}${rejected.length > 0 ? ` | Rejected: ${rejected.length}` : ''}`);

    // Incremental save of blob to persist progress
    fs.writeFileSync(blobPath, JSON.stringify(pkg, null, 2));

    // Polite delay for Gemini API rate limit (stay under 15 RPM)
    await new Promise((r) => setTimeout(r, 4000));
  }

  // Copy updated blob to desktop if available
  const desktopOut = path.join('/mnt/c/Users/frans/OneDrive/Desktop/catalog honda', path.basename(blobPath));
  try {
    fs.copyFileSync(blobPath, desktopOut);
    console.log(`\nUpdated blob saved and copied to: ${desktopOut}`);
  } catch {}

  // 2. Commit dots to D1
  console.log(`\n2. Consolidating dots and syncing to remote Cloudflare D1...`);
  const dotInserts: string[] = [];
  for (const page of pkg.pages) {
    const { code } = page.extracted.assembly;
    for (const item of page.extracted.items || []) {
      if (!Array.isArray(item.dots) || item.dots.length === 0) continue;
      const itemId = itemIdByAsmAndRef.get(`${code}:${item.refNo}`);
      if (!itemId) continue;

      for (const d of item.dots) {
        const dotId = crypto.randomUUID();
        dotInserts.push(`INSERT INTO dots (id, assembly_item_id, x, y, created_at, updated_at) VALUES ('${dotId}', '${itemId}', ${d.x}, ${d.y}, unixepoch(), unixepoch());`);
      }
    }
  }

  console.log(`Total valid dots ready to insert: ${dotInserts.length}`);

  if (dotInserts.length > 0) {
    console.log('Clearing existing dots for machine in D1 to replace cleanly...');
    runD1Sql(`
      UPDATE dots SET deleted_at = unixepoch() WHERE assembly_item_id IN (
        SELECT ai.id FROM assembly_items ai
        JOIN assemblies a ON a.id = ai.assembly_id
        WHERE a.machine_id = '${machineId}'
      ) AND deleted_at IS NULL;
    `);

    const BATCH_SIZE = 250;
    for (let i = 0; i < dotInserts.length; i += BATCH_SIZE) {
      const chunk = dotInserts.slice(i, i + BATCH_SIZE);
      runD1Sql(chunk.join('\n'));
      process.stdout.write(`\rInserted dots to D1: ${Math.min(i + BATCH_SIZE, dotInserts.length)} / ${dotInserts.length}`);
    }
    console.log('\nAll dots committed to Cloudflare D1 successfully!');
  }

  console.log(`\n======================================================`);
  console.log(`🎉 DOT MAPPING & CATALOG RECHECK SUMMARY: ${machineModel}`);
  console.log(`======================================================`);
  console.log(`Total assemblies processed: ${assembliesProcessed}`);
  console.log(`Total catalog items: ${totalCatalogItems}`);
  console.log(`Total dots mapped to valid parts: ${totalMappedDots}`);
  console.log(`Total rejected phantom callouts: ${totalRejectedDots}`);
}

if (process.argv.slice(2).length >= 2) {
  const args = process.argv.slice(2);
  mapCatalogDots(args[0], args[1], { force: args.includes('--force') }).catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
