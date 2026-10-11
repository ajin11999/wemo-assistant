import fs from 'fs';
import path from 'path';
import sharp from '../node_modules/.bun/sharp@0.35.2/node_modules/sharp';
import * as pdfjs from '../node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { validateBlobPackage } from '../apps/admin/src/ingest-helpers';
import type { BlobPackage, BlobAssemblyPage, ExtractedItem } from '../apps/admin/src/types';

const PDF_PATH = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/Katalog-Suku-Cadang-All-New-Vario-125-eSP.pdf';
const SOURCE_NAME = 'Katalog-Suku-Cadang-All-New-Vario-125-eSP.pdf';
const BLOB_OUT = 'apps/backend/backups/vario-125-esp-blob.json';
const DESKTOP_OUT = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/vario-125-esp-blob.json';
const API_KEY = process.env.GEMINI_API_KEY;

const wasmDir = path.resolve('node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/wasm');

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

async function extractVario125Esp() {
  console.log('Loading PDF from:', PDF_PATH);
  const data = new Uint8Array(fs.readFileSync(PDF_PATH));
  const doc = await pdfjs.getDocument({ data, wasmUrl: wasmDir + '/' }).promise;
  console.log(`PDF loaded. Total pages: ${doc.numPages}`);

  const pages: BlobAssemblyPage[] = [];
  let seq = 0;

  // Pages 29 to 85 (57 assembly pages)
  for (let pageNo = 29; pageNo <= 85; pageNo++) {
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

    // Find table column headers dynamically
    const cbsH = allItems.find((i) => i.str.includes('CBS') && i.vy >= 280 && i.vy <= 325);
    const issH = allItems.find((i) => i.str.includes('ISS') && i.vy >= 280 && i.vy <= 325);

    const cbsX = cbsH?.vx ?? 339;
    const issX = issH?.vx ?? 366;

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

      // Ref No: vx around 80..115
      const refItem = row.items.find((i) => i.vx >= 80 && i.vx <= 115 && /^\d+[A-Z]?\)?$/.test(i.str));

      // Part Number item: vx around 110..180
      const pnItem = row.items.find((i) => i.vx >= 110 && i.vx <= 180 && (i.str.includes('-') || /^\d{5}/.test(i.str)));

      // Quantities: CBS and ISS
      const qty1 = row.items.find((i) => Math.abs(i.vx - cbsX) <= 12 && (/^\d+$/.test(i.str) || i.str === '-'))?.str;
      const qty2 = row.items.find((i) => Math.abs(i.vx - issX) <= 12 && (/^\d+$/.test(i.str) || i.str === '-'))?.str;

      const variantQtys: { variant: string; qty: number }[] = [];
      if (qty1 && qty1 !== '-') variantQtys.push({ variant: 'CBS', qty: parseInt(qty1, 10) || 1 });
      if (qty2 && qty2 !== '-') variantQtys.push({ variant: 'ISS', qty: parseInt(qty2, 10) || 1 });

      const totalQty = variantQtys.length > 0 ? Math.max(...variantQtys.map((v) => v.qty)) : 1;

      // Description items: vx between 165 and the first quantity column
      const firstQtyX = Math.min(cbsX, issX);
      const descItems = row.items.filter((i) => i !== refItem && i !== pnItem && i.vx >= 165 && i.vx < firstQtyX - 10);
      let descText = cleanText(descItems.map((i) => i.str).join(' '));

      // Notes / Serial items: vx >= last quantity column + 20
      const lastQtyX = Math.max(cbsX, issX);
      const noteItems = row.items.filter((i) => i.vx >= lastQtyX + 20);
      const noteText = cleanText(noteItems.map((i) => i.str).join(' '));

      if (pnItem) {
        let pnVal = pnItem.str;
        if (pnVal.includes(' ')) {
          const parts = pnVal.split(/\s+/);
          pnVal = parts[0];
          descText = parts.slice(1).join(' ') + (descText ? ' ' + descText : '');
        }

        if (refItem) {
          const item: ExtractedItem = {
            refNo: refItem.str.replace(')', ''),
            description: cleanText(descText) || 'PARTS',
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
            // 1-bit monochrome mask: bit 1 = white background (255), bit 0 = black line art (0)
            gray[y * imgW + x] = bit ? 255 : 0;
          }
        }
        const pngBuf = await sharp(gray, { raw: { width: imgW, height: imgH, channels: 1 } })
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
        const pngBuf = await sharp(Buffer.from(obj.data), {
          raw: { width: imgW, height: imgH, channels: 3 },
        }).png({ compressionLevel: 9 }).toBuffer();
        diagramCropBase64 = pngBuf.toString('base64');
        const thumbBuf = await sharp(pngBuf)
          .resize({ width: 400, withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        thumbDataUrl = `data:image/jpeg;base64,${thumbBuf.toString('base64')}`;
      }
    }

    // Multi-page assembly fallback
    if (!diagramCropBase64) {
      const prevPage = pages.slice().reverse().find((p) => p.extracted.assembly.code === code && p.diagramCropBase64);
      if (prevPage) {
        diagramCropBase64 = prevPage.diagramCropBase64;
        imgW = prevPage.width ?? 0;
        imgH = prevPage.height ?? 0;
        thumbDataUrl = prevPage.thumbDataUrl;
      }
    }

    // 4. Locate Balloon Dots via Gemini Vision
    if (diagramCropBase64 && extractedItems.length > 0) {
      const refList = extractedItems.map((i) => i.refNo);
      const dots = await locateDots(code, name, refList, diagramCropBase64, imgW, imgH);
      for (const item of extractedItems) {
        const itemDots = dots.filter((d) => d.refNo === item.refNo);
        item.dots = itemDots.map((d) => ({ x: d.x, y: d.y }));
      }
      console.log(`[${seq + 1}/57] ${code} · ${name} (p${pageNo}): ${extractedItems.length} items, ${dots.length} dots detected`);
    } else {
      console.log(`[${seq + 1}/57] ${code} · ${name} (p${pageNo}): ${extractedItems.length} items (no image)`);
    }

    const blobPage: BlobAssemblyPage = {
      source: SOURCE_NAME,
      pageNo,
      seq,
      type: 'assembly',
      groupType,
      extracted: {
        assembly: {
          code,
          name: cleanText(name) || `Assembly ${code}`,
        },
        diagram: { x: 0, y: 0, width: 1, height: 1 },
        items: extractedItems,
        serviceItems: [],
      },
      diagramCropBase64,
      mediaType: 'image/png',
      width: imgW || null,
      height: imgH || null,
      thumbDataUrl,
    };

    pages.push(blobPage);
    seq++;

    // Incremental progress save
    const partialPackage: BlobPackage = {
      version: 1,
      machineHint: {
        brand: 'Honda',
        model: 'All New Vario 125 eSP',
        typeCode: 'K59',
      },
      sources: [SOURCE_NAME],
      pages,
    };
    fs.writeFileSync(BLOB_OUT, JSON.stringify(partialPackage, null, 2));

    // Throttle Gemini slightly
    await new Promise((r) => setTimeout(r, 1200));
  }

  const finalPackage: BlobPackage = {
    version: 1,
    machineHint: {
      brand: 'Honda',
      model: 'All New Vario 125 eSP',
      typeCode: 'K59',
    },
    sources: [SOURCE_NAME],
    pages,
  };

  validateBlobPackage(finalPackage);
  console.log('\nFinal validation passed! Writing final blob...');
  fs.writeFileSync(BLOB_OUT, JSON.stringify(finalPackage, null, 2));
  console.log('Saved to:', BLOB_OUT);

  if (fs.existsSync('/mnt/c/Users/frans/OneDrive/Desktop/catalog honda')) {
    fs.copyFileSync(BLOB_OUT, DESKTOP_OUT);
    console.log('Copied to Windows desktop:', DESKTOP_OUT);
  }
}

extractVario125Esp().catch(console.error);
