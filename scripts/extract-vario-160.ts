import fs from 'fs';
import path from 'path';
import sharp from '../node_modules/.bun/sharp@0.35.2/node_modules/sharp';
import * as pdfjs from '../node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { validateBlobPackage } from '../apps/admin/src/ingest-helpers';
import type { BlobPackage, BlobAssemblyPage, ExtractedItem } from '../apps/admin/src/types';

const PDF_PATH = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/PC-_Vario-Evo-160.pdf';
const SOURCE_NAME = 'PC-_Vario-Evo-160.pdf';
const BLOB_OUT = 'apps/backend/backups/vario-160-blob.json';
const DESKTOP_OUT = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/vario-160-blob.json';
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

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });

      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 4000 * attempt));
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
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return [];
}

async function extractVario160() {
  console.log('Loading PDF from:', PDF_PATH);
  const data = new Uint8Array(fs.readFileSync(PDF_PATH));
  const doc = await pdfjs.getDocument({
    data,
    wasmUrl: wasmDir,
  }).promise;
  console.log(`PDF loaded. Total pages: ${doc.numPages}`);

  const pages: BlobAssemblyPage[] = [];
  let seq = 0;

  // Pages 54 to 154 (101 assembly pages)
  for (let pageNo = 54; pageNo <= 154; pageNo++) {
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

    // 1. Identify Assembly Code and Name (vy < 80)
    const codeItem = allItems.find((i) => /^[EF]-\d+(?:-\d+)?$/.test(i.str) && i.vy < 80);
    const code = codeItem?.str ?? `P-${pageNo}`;
    const groupType: 'engine' | 'frame' = code.startsWith('E') ? 'engine' : 'frame';

    const nameItems = allItems.filter((i) => i.vy < 80 && i.vx < 450 && i.str !== code && !/^\d+$/.test(i.str));
    const name = cleanAssemblyName(cleanText(nameItems.map((i) => i.str).join(' '))) || `Assembly ${code}`;

    // 2. Identify Table Rows (vy >= 320 && vy <= 570)
    const tableItems = allItems.filter((i) => i.vy >= 320 && i.vy <= 570);
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

      // Ref No: vx around 75..125
      const refItem = row.items.find((i) => i.vx >= 75 && i.vx <= 125 && /^\d+[A-Z]?\)?$/.test(i.str));

      // Part Number item: vx around 105..190
      const pnItem = row.items.find((i) => i.vx >= 105 && i.vx <= 190 && (i.str.includes('-') || /^\d{5}/.test(i.str)));

      // Quantities for 6 columns:
      // ABS-2022 (320..343), ABS-2024 (344..366), ABS-2026 (367..389)
      // CBS-2022 (390..412), CBS-2024 (413..435), CBS-2026 (436..465)
      const abs22Qty = row.items.find((i) => i.vx >= 320 && i.vx <= 343 && /^\d+$/.test(i.str))?.str;
      const abs24Qty = row.items.find((i) => i.vx >= 344 && i.vx <= 366 && /^\d+$/.test(i.str))?.str;
      const abs26Qty = row.items.find((i) => i.vx >= 367 && i.vx <= 389 && /^\d+$/.test(i.str))?.str;
      const cbs22Qty = row.items.find((i) => i.vx >= 390 && i.vx <= 412 && /^\d+$/.test(i.str))?.str;
      const cbs24Qty = row.items.find((i) => i.vx >= 413 && i.vx <= 435 && /^\d+$/.test(i.str))?.str;
      const cbs26Qty = row.items.find((i) => i.vx >= 436 && i.vx <= 465 && /^\d+$/.test(i.str))?.str;

      const variantQtys: { variantCode: string; qty: number }[] = [];
      if (abs22Qty) variantQtys.push({ variantCode: 'ABS-2022', qty: parseInt(abs22Qty, 10) || 1 });
      if (abs24Qty) variantQtys.push({ variantCode: 'ABS-2024', qty: parseInt(abs24Qty, 10) || 1 });
      if (abs26Qty) variantQtys.push({ variantCode: 'ABS-2026', qty: parseInt(abs26Qty, 10) || 1 });
      if (cbs22Qty) variantQtys.push({ variantCode: 'CBS-2022', qty: parseInt(cbs22Qty, 10) || 1 });
      if (cbs24Qty) variantQtys.push({ variantCode: 'CBS-2024', qty: parseInt(cbs24Qty, 10) || 1 });
      if (cbs26Qty) variantQtys.push({ variantCode: 'CBS-2026', qty: parseInt(cbs26Qty, 10) || 1 });

      const totalQty = Math.max(...variantQtys.map((v) => v.qty), 1);

      // Description items: vx between 170 and 320
      const descItems = row.items.filter((i) => i !== refItem && i !== pnItem && i.vx >= 170 && i.vx < 320);
      let descText = cleanText(descItems.map((i) => i.str).join(' '));

      // Note / serial items (vx >= 465)
      const noteItems = row.items.filter((i) => i.vx >= 465);
      const noteText = cleanText(noteItems.map((i) => i.str).join(' '));

      if (refItem || pnItem) {
        const refNo = refItem ? refItem.str.replace(/[^\w]/g, '') : (curItem ? curItem.refNo : '');
        const pnVal = pnItem ? pnItem.str.replace(/\s+/g, '') : '';

        if (refItem && pnItem) {
          const item: ExtractedItem = {
            refNo,
            description: descText || `Part ${refNo}`,
            qty: totalQty,
            partNumbers: [
              {
                value: pnVal,
                note: noteText || null,
                variantQtys: variantQtys.length > 0 ? variantQtys : undefined,
              },
            ],
            dots: [],
          };
          extractedItems.push(item);
          curItem = item;
        } else if (curItem) {
          curItem.partNumbers.push({
            value: pnVal,
            note: noteText || null,
            variantQtys: variantQtys.length > 0 ? variantQtys : undefined,
          });
        }
      } else if (descText && curItem) {
        curItem.description = cleanText(curItem.description + ' ' + descText);
      }
    }

    // 3. Diagram Image Extraction (Mask or XObject)
    const ops = await page.getOperatorList();
    let diagramCropBase64: string | null = null;
    let thumbDataUrl: string | null = null;
    let imgW = 0;
    let imgH = 0;

    const maskIdx = ops.fnArray.indexOf(pdfjs.OPS.paintImageMaskXObject);
    const imgIdx = ops.fnArray.indexOf(pdfjs.OPS.paintImageXObject);

    if (maskIdx !== -1) {
      const arg = ops.argsArray[maskIdx][0];
      const imgName = typeof arg === 'string' ? arg : arg.data;
      const obj = await getImageObj(page, imgName);
      if (obj && obj.data) {
        imgW = obj.width;
        imgH = obj.height;
        const rowBytes = Math.ceil(imgW / 8);
        const gray = Buffer.alloc(imgW * imgH);
        for (let y = 0; y < imgH; y++) {
          const rowOffset = y * rowBytes;
          for (let x = 0; x < imgW; x++) {
            const byte = obj.data[rowOffset + (x >> 3)];
            const bit = (byte >> (7 - (x & 7))) & 1;
            gray[y * imgW + x] = bit ? 255 : 0;
          }
        }
        const pngBuf = await sharp(gray, { raw: { width: imgW, height: imgH, channels: 1 } })
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
    } else if (imgIdx !== -1) {
      const arg = ops.argsArray[imgIdx][0];
      const imgName = typeof arg === 'string' ? arg : arg.data;
      const obj = await getImageObj(page, imgName);
      if (obj && obj.data) {
        imgW = obj.width;
        imgH = obj.height;
        let pngBuf: Buffer;
        if (obj.data.length === imgW * imgH * 4) {
          pngBuf = await sharp(obj.data, { raw: { width: imgW, height: imgH, channels: 4 } })
            .resize({ width: 2000, withoutEnlargement: true })
            .png({ compressionLevel: 9 })
            .toBuffer();
        } else if (obj.data.length === imgW * imgH * 3) {
          pngBuf = await sharp(obj.data, { raw: { width: imgW, height: imgH, channels: 3 } })
            .resize({ width: 2000, withoutEnlargement: true })
            .png({ compressionLevel: 9 })
            .toBuffer();
        } else {
          pngBuf = await sharp(obj.data, { raw: { width: imgW, height: imgH, channels: 1 } })
            .resize({ width: 2000, withoutEnlargement: true })
            .png({ compressionLevel: 9 })
            .toBuffer();
        }
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

    // If pure FRT overflow page with 0 parts, skip it
    if (extractedItems.length === 0 && !maskIdx && !imgIdx) {
      console.log(`[p${pageNo}] Skipping FRT overflow page for ${code}`);
      continue;
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
      `[${seq}/${154 - 54 + 1}] ${code} · ${name} (p${pageNo}): ${extractedItems.length} items, ${detectedDots.length} dots detected`
    );

    // Write checkpoint every 10 pages
    if (seq % 10 === 0) {
      const partialPkg: BlobPackage = {
        catalogMeta: {
          machineId: 'va160000-0000-4000-8000-000000000160',
          machineName: 'Honda Vario 160 / Vario Evo 160',
          brand: 'Honda',
          modelYear: '2022-2026',
          typeCode: 'ACB160 / K2S',
          sourceFile: SOURCE_NAME,
          pageRange: '54-154',
          variants: ['ABS-2022', 'ABS-2024', 'ABS-2026', 'CBS-2022', 'CBS-2024', 'CBS-2026'],
        },
        pages,
      };
      fs.writeFileSync(BLOB_OUT, JSON.stringify(partialPkg, null, 2));
    }
  }

  const finalPkg: BlobPackage = {
    catalogMeta: {
      machineId: 'va160000-0000-4000-8000-000000000160',
      machineName: 'Honda Vario 160 / Vario Evo 160',
      brand: 'Honda',
      modelYear: '2022-2026',
      typeCode: 'ACB160 / K2S',
      sourceFile: SOURCE_NAME,
      pageRange: '54-154',
      variants: ['ABS-2022', 'ABS-2024', 'ABS-2026', 'CBS-2022', 'CBS-2024', 'CBS-2026'],
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

extractVario160().catch((err) => {
  console.error('Fatal error during Vario 160 extraction:', err);
  process.exit(1);
});
