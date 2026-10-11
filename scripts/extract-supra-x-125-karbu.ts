import fs from 'fs';
import path from 'path';
import sharp from '../node_modules/.bun/sharp@0.35.2/node_modules/sharp';
import * as pdfjs from '../node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { validateBlobPackage } from '../apps/admin/src/ingest-helpers';
import type { BlobPackage, BlobAssemblyPage, ExtractedItem } from '../apps/admin/src/types';

const PDF_PATH = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/Katalog-Suku-Cadang-Honda-Supra-X-125-2.pdf';
const SOURCE_NAME = 'Katalog-Suku-Cadang-Honda-Supra-X-125-2.pdf';
const BLOB_OUT = 'apps/backend/backups/supra-x-125-karbu-blob.json';
const DESKTOP_OUT = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/supra-x-125-karbu-blob.json';
const API_KEY = process.env.GEMINI_API_KEY;

const wasmDir = path.resolve('node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/wasm') + '/';

function getImageObj(page: any, imgName: string): Promise<any> {
  const pool = imgName.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    pool.get(imgName, (data: any) => resolve(data));
  });
}

function cleanText(str: string): string {
  return str.replace(/\.{2,}/g, '').replace(/\s+/g, ' ').trim();
}

function cleanAssemblyName(name: string): string {
  return name
    .replace(/No\.?\s*Ref.*$/i, '')
    .replace(/L\.?O\.?N.*$/i, '')
    .replace(/Deskripsi.*$/i, '')
    .replace(/F\.?R\.?T.*$/i, '')
    .replace(/Service\s*item.*$/i, '')
    .trim();
}

async function locateDots(
  code: string,
  name: string,
  refs: string[],
  cropBase64: string,
  imgW: number,
  imgH: number
): Promise<{ refNo: string; x: number; y: number }[]> {
  if (!API_KEY) return [];
  const refList = [...new Set(refs)].join(', ');
  const prompt = `This is an exploded diagram from a vehicle parts catalog for assembly ${code} (${name}).
On the drawing, parts are labeled with numbered balloon callout circles: ${refList}.
For each numbered balloon callout visible on the diagram, identify its normalized (x, y) center coordinates where:
- x is a decimal number between 0.0 (left) and 1.0 (right)
- y is a decimal number between 0.0 (top) and 1.0 (bottom)
DO NOT return pixel coordinates. Strictly return normalized floats between 0.0 and 1.0.

Return a pure JSON array in this exact format with NO extra text or markdown:
[
  { "refNo": "1", "x": 0.25, "y": 0.35 }
]`;

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/png', data: cropBase64 } },
        ],
      },
    ],
    generationConfig: {
      response_mime_type: 'application/json',
      temperature: 0.1,
    },
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }

      if (!res.ok) return [];
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return [];

      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((d) => typeof d.refNo === 'string' && typeof d.x === 'number' && typeof d.y === 'number')
          .map((d) => {
            let x = d.x > 1 ? d.x / imgW : d.x;
            let y = d.y > 1 ? d.y / imgH : d.y;
            return {
              refNo: String(d.refNo),
              x: Math.round(Math.max(0, Math.min(1, x)) * 1000) / 1000,
              y: Math.round(Math.max(0, Math.min(1, y)) * 1000) / 1000,
            };
          });
      }
      return [];
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return [];
}

async function extractSupraX125Karbu() {
  console.log('Loading PDF from:', PDF_PATH);
  const data = new Uint8Array(fs.readFileSync(PDF_PATH));
  const doc = await pdfjs.getDocument({
    data,
    wasmUrl: wasmDir,
  }).promise;
  console.log(`PDF loaded. Total pages: ${doc.numPages}`);

  const pages: BlobAssemblyPage[] = [];
  let seq = 0;

  // Pages 15 to 90 (76 pages)
  for (let pageNo = 15; pageNo <= 90; pageNo++) {
    const page = await doc.getPage(pageNo);
    const vp = page.getViewport({ scale: 1.0 });
    const tc = await page.getTextContent();
    const allItems = tc.items
      .map((it: any) => {
        const [vx, vy] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
        return {
          str: it.str.trim(),
          vx: Math.round(vx),
          vy: Math.round(vy),
        };
      })
      .filter((i: any) => i.str.length > 0);

    // 1. Identify Assembly Code and Name
    const codeItem = allItems.find((i) => /^[EF]\s*-\s*\d+(?:-\s*\d+)?$/.test(i.str) && i.vy < 200);
    const rawCode = codeItem?.str ?? `P-${pageNo}`;
    const code = rawCode.replace(/\s+/g, '');
    const groupType: 'engine' | 'frame' = code.startsWith('E') ? 'engine' : 'frame';

    const nameItems = allItems.filter(
      (i) => i.vy < 200 && i.str !== rawCode && !/^\d+$/.test(i.str) && !i.str.includes('Service') && !i.str.includes('F.R.T')
    );
    const name = cleanAssemblyName(cleanText(nameItems.map((i) => i.str).join(' '))) || `Assembly ${code}`;

    // 2. Identify Table Rows (vy >= 290 && vy <= 560)
    const tableItems = allItems.filter((i) => i.vy >= 290 && i.vy <= 560 && i.vx >= 250);
    const rows: { vy: number; items: typeof allItems }[] = [];
    tableItems.sort((a, b) => a.vy - b.vy || a.vx - b.vx);

    for (const it of tableItems) {
      let row = rows.find((r) => Math.abs(r.vy - it.vy) <= 3);
      if (!row) {
        row = { vy: it.vy, items: [] };
        rows.push(row);
      }
      row.items.push(it);
    }

    const extractedItems: ExtractedItem[] = [];
    let curItem: ExtractedItem | null = null;

    for (const row of rows) {
      row.items.sort((a, b) => a.vx - b.vx);

      // Ref No: vx 270..315
      const refItem = row.items.find((i) => i.vx >= 270 && i.vx <= 315 && /^\d+[A-Z]?\)?$/.test(i.str));

      // Part Number: vx 305..365
      const pnItem = row.items.find((i) => i.vx >= 305 && i.vx <= 365 && (i.str.includes('-') || /^\d{5}/.test(i.str)));

      // Qty: vx 590..645
      const qtyStrRaw = row.items.find((i) => i.vx >= 590 && i.vx <= 645 && (/^\d+$/.test(i.str) || /^\(\d+\)$/.test(i.str)))?.str;
      const cleanQtyStr = qtyStrRaw ? qtyStrRaw.replace(/[^\d]/g, '') : '1';
      const parsedQty = parseInt(cleanQtyStr, 10) || 1;

      // Note: vx >= 640
      const noteItem = row.items.find((i) => i.vx >= 640);
      const noteText = noteItem ? cleanText(noteItem.str) : null;

      // Variants resolution based on note
      const isFi = noteText && noteText.includes('PGM-FI');
      const variantQtys = isFi
        ? [{ variantCode: 'PGM-FI', qty: parsedQty }]
        : [{ variantCode: 'Standard', qty: parsedQty }];

      // Description: vx between 370 and 590
      const descItems = row.items.filter((i) => i !== refItem && i !== pnItem && i.vx >= 370 && i.vx < 590);
      let descText = cleanText(descItems.map((i) => i.str).join(' '));

      if (refItem || pnItem) {
        const refNo = refItem ? refItem.str.replace(/[^\w]/g, '') : (curItem ? curItem.refNo : '');
        const pnVal = pnItem ? pnItem.str.replace(/\s+/g, '') : '';

        if (refItem && pnItem) {
          const item: ExtractedItem = {
            refNo,
            description: descText || `Part ${refNo}`,
            qty: parsedQty,
            partNumbers: [
              {
                value: pnVal,
                note: noteText,
                variantQtys,
              },
            ],
            dots: [],
          };
          extractedItems.push(item);
          curItem = item;
        } else if (curItem) {
          curItem.partNumbers.push({
            value: pnVal,
            note: noteText,
            variantQtys,
          });
        }
      } else if (descText && curItem) {
        curItem.description = cleanText(curItem.description + ' ' + descText);
      }
    }

    // 3. Image Extraction
    const ops = await page.getOperatorList();
    let diagramCropBase64: string | null = null;
    let thumbDataUrl: string | null = null;
    let imgW = 0;
    let imgH = 0;

    const imgIdx = ops.fnArray.indexOf(pdfjs.OPS.paintImageXObject);
    if (imgIdx !== -1) {
      const arg = ops.argsArray[imgIdx][0];
      const imgName = typeof arg === 'string' ? arg : arg.data;
      const obj = await getImageObj(page, imgName);
      if (obj && obj.data) {
        imgW = obj.width;
        imgH = obj.height;
        const pngBuf = await sharp(obj.data, {
          raw: { width: imgW, height: imgH, channels: (obj.data.length / (imgW * imgH)) as 1 | 3 | 4 },
        })
          .resize({ width: 2000, withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer();
        diagramCropBase64 = pngBuf.toString('base64');
        const thumbBuf = await sharp(pngBuf)
          .resize({ width: 400, withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        thumbDataUrl = `data:image/jpeg;base64,${thumbBuf.toString('base64')}`;
      }
    }

    // Continuation page image fallback
    if (!diagramCropBase64) {
      const prevSame = [...pages].reverse().find((p) => p.code === code && p.diagramCropBase64);
      if (prevSame) {
        diagramCropBase64 = prevSame.diagramCropBase64;
        thumbDataUrl = prevSame.thumbDataUrl;
        imgW = prevSame.width;
        imgH = prevSame.height;
      }
    }

    // 4. Dot Detection with Gemini Vision
    const allRefs = extractedItems.map((i) => i.refNo).filter(Boolean);
    let detectedDots: { refNo: string; x: number; y: number }[] = [];
    if (diagramCropBase64 && allRefs.length > 0) {
      detectedDots = await locateDots(code, name, allRefs, diagramCropBase64, imgW || 1000, imgH || 800);
      for (const item of extractedItems) {
        item.dots = detectedDots
          .filter((d) => d.refNo === item.refNo)
          .map((d) => ({ x: d.x, y: d.y }));
      }
    }

    seq++;
    pages.push({
      pageNumber: pageNo,
      sequence: seq,
      code,
      name,
      groupType,
      items: extractedItems,
      diagramCropBase64: diagramCropBase64 ?? undefined,
      thumbDataUrl: thumbDataUrl ?? undefined,
      width: imgW || 1000,
      height: imgH || 800,
    });

    console.log(
      `[${seq}/${90 - 15 + 1}] ${code} · ${name} (p${pageNo}): ${extractedItems.length} items, ${detectedDots.length} dots detected`
    );

    // Checkpoint every 10 pages
    if (seq % 10 === 0) {
      const partialPkg: BlobPackage = {
        catalogMeta: {
          machineId: 'sp125000-0000-4000-8000-000000000001',
          machineName: 'Honda Supra X 125 Karburator',
          brand: 'Honda',
          modelYear: '2005-2013',
          typeCode: 'KPH',
          sourceFile: SOURCE_NAME,
          pageRange: '15-90',
          variants: ['Standard', 'PGM-FI'],
        },
        pages,
      };
      fs.writeFileSync(BLOB_OUT, JSON.stringify(partialPkg, null, 2));
    }
  }

  const finalPkg: BlobPackage = {
    catalogMeta: {
      machineId: 'sp125000-0000-4000-8000-000000000001',
      machineName: 'Honda Supra X 125 Karburator',
      brand: 'Honda',
      modelYear: '2005-2013',
      typeCode: 'KPH',
      sourceFile: SOURCE_NAME,
      pageRange: '15-90',
      variants: ['Standard', 'PGM-FI'],
    },
    pages,
  };

  const validation = validateBlobPackage(finalPkg);
  if (!validation.valid) {
    console.error('Validation errors:', validation.errors);
  } else {
    console.log('\nFinal validation passed! Writing final blob...');
  }

  fs.writeFileSync(BLOB_OUT, JSON.stringify(finalPkg, null, 2));
  fs.copyFileSync(BLOB_OUT, DESKTOP_OUT);
  console.log('Saved to:', BLOB_OUT);
  console.log('Copied to Windows desktop:', DESKTOP_OUT);
}

extractSupraX125Karbu().catch((err) => {
  console.error('Fatal error during Supra X 125 Karbu extraction:', err);
  process.exit(1);
});
