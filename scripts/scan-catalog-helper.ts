import fs from 'fs';
import path from 'path';
import sharp from '../node_modules/.bun/sharp@0.35.2/node_modules/sharp';
import * as pdfjs from '../node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/legacy/build/pdf.mjs';

const wasmDir = path.resolve('node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/wasm') + '/';
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('GEMINI_API_KEY environment variable is required.');
  process.exit(1);
}

function getImageObj(page: any, imgName: string): Promise<any> {
  const pool = imgName.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => pool.get(imgName, (data: any) => resolve(data)));
}

export interface PageScanResult {
  pageNo: number;
  code: string | null;
  name: string | null;
  isContinuation: boolean;
  hasDiagram: boolean;
  box: { x: number; y: number; width: number; height: number } | null;
}

const MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest'];

async function callGemini(jpegBase64: string, pageNo: number, catalogName: string): Promise<PageScanResult> {
  const prompt = `Analyze this scanned Honda motorcycle parts catalog page (${catalogName}, Page ${pageNo}).
Image width is 1000 pixels.
Extract:
1. "code": string (e.g. "E-19", "E-20", "E-23", "F-1", "F-14-20", "F-39") or null if table of contents or general text.
2. "name": string (e.g. "GEARSHIFT DRUM", "HEADLIGHT", "WIRE HARNESS").
3. "isContinuation": boolean (true ONLY if this page is a continuation parts table page with NO exploded diagram illustration).
4. "hasDiagram": boolean (true if an exploded diagram illustration pane is present).
5. "box": { "x": number, "y": number, "width": number, "height": number } (bounding box on this 1000px width image of the diagram illustration pane, including the top header bar with code and name, down to the horizontal dividing line above the parts table, and rightwards to the vertical divider before the labor table or right page margin. Typically x around 70-100, y around 35-55, width around 540-850, height around 420-470), or null if no diagram.

Return valid JSON:
{
  "code": "F-1",
  "name": "HEADLIGHT",
  "isContinuation": false,
  "hasDiagram": true,
  "box": { "x": 75, "y": 45, "width": 550, "height": 435 }
}`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const model = MODELS[attempt % MODELS.length];
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                { inline_data: { mime_type: 'image/jpeg', data: jpegBase64 } },
              ],
            },
          ],
          generationConfig: {
            response_mime_type: 'application/json',
            temperature: 0.1,
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.warn(`[${catalogName} p${pageNo}] Attempt ${attempt + 1} with ${model} failed (${res.status}): ${errText.slice(0, 80)}`);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.find((p: any) => typeof p.text === 'string')?.text;
      if (!text) throw new Error('No candidate content text found');
      const parsed = JSON.parse(text);
      return {
        pageNo,
        code: parsed.code ? String(parsed.code).toUpperCase().trim() : null,
        name: parsed.name ? String(parsed.name).toUpperCase().trim() : null,
        isContinuation: Boolean(parsed.isContinuation),
        hasDiagram: Boolean(parsed.hasDiagram),
        box: parsed.box || null,
      };
    } catch (e: any) {
      console.warn(`[${catalogName} p${pageNo}] Attempt ${attempt + 1} error: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }

  throw new Error(`Failed to scan ${catalogName} page ${pageNo} after 5 attempts.`);
}

export async function scanCatalog(
  pdfPath: string,
  startPage: number,
  endPage: number,
  cachePath: string,
  catalogName: string
): Promise<Map<number, PageScanResult>> {
  let cache: Record<number, PageScanResult> = {};
  if (fs.existsSync(cachePath)) {
    try {
      cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      console.log(`Loaded ${Object.keys(cache).length} cached pages from ${cachePath}`);
    } catch {}
  }

  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, wasmUrl: wasmDir }).promise;

  const pagesToScan: number[] = [];
  for (let p = startPage; p <= endPage; p++) {
    if (!cache[p]) pagesToScan.push(p);
  }

  console.log(`[${catalogName}] Scanning ${pagesToScan.length} new pages (range: ${startPage}..${endPage})...`);

  const CONCURRENCY = 3;
  let nextIdx = 0;
  let active = 0;

  await new Promise<void>((resolve, reject) => {
    function launch() {
      if (nextIdx >= pagesToScan.length && active === 0) return resolve();
      while (active < CONCURRENCY && nextIdx < pagesToScan.length) {
        const p = pagesToScan[nextIdx++];
        active++;
        (async () => {
          try {
            const page = await doc.getPage(p);
            const ops = await page.getOperatorList();
            const imgArg = ops.argsArray.find(
              (a: any) => Array.isArray(a) && typeof a[0] === 'string' && a[0].startsWith('img_')
            );
            if (!imgArg) {
              cache[p] = { pageNo: p, code: null, name: null, isContinuation: false, hasDiagram: false, box: null };
              return;
            }
            const img = await getImageObj(page, imgArg[0]);
            const rawSharp = sharp(Buffer.from(img.data), {
              raw: { width: img.width, height: img.height, channels: 3 },
            });
            const jpegBuf = await rawSharp.clone().resize({ width: 1000 }).jpeg({ quality: 75 }).toBuffer();
            const res = await callGemini(jpegBuf.toString('base64'), p, catalogName);
            cache[p] = res;
            fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
            console.log(`✓ [${catalogName} p${p}] Code: ${res.code} (${res.name}) diagram: ${res.hasDiagram}`);
          } catch (err: any) {
            console.error(`✗ [${catalogName} p${p}] Error:`, err.message);
            reject(err);
          } finally {
            active--;
            setTimeout(launch, 300);
          }
        })();
      }
    }
    launch();
  });

  const resMap = new Map<number, PageScanResult>();
  for (const [pStr, r] of Object.entries(cache)) {
    resMap.set(Number(pStr), r);
  }
  return resMap;
}
