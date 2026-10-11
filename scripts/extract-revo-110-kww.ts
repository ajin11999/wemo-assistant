import fs from 'fs';
import path from 'path';
import sharp from '../node_modules/.bun/sharp@0.35.2/node_modules/sharp';
import { createCanvas } from '../node_modules/.bun/@napi-rs+canvas@1.0.2/node_modules/@napi-rs/canvas';
import * as pdfjs from '../node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { validateBlobPackage } from '../apps/admin/src/ingest-helpers';
import type { BlobPackage, BlobAssemblyPage, ExtractedItem } from '../apps/admin/src/types';

const PDF_PATH = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/new-revo-kww.pdf';
const SOURCE_NAME = 'new-revo-kww.pdf';
const BLOB_OUT = 'apps/backend/backups/revo-110-kww-blob.json';
const DESKTOP_OUT = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/revo-110-kww-blob.json';

const wasmDir = path.resolve('node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/wasm') + '/';

function cleanText(str: string): string {
  return str.replace(/\.{2,}/g, '').replace(/\s+/g, ' ').trim();
}

function cleanDuplicateWords(s: string): string {
  const tokens = s.split(/\s+/);
  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const norm = tokens[i].replace(/[^\w]/g, '').toLowerCase();
    const prevNorm = result.length > 0 ? result[result.length - 1].replace(/[^\w]/g, '').toLowerCase() : '';
    if (norm && norm === prevNorm) {
      continue;
    }
    result.push(tokens[i]);
  }
  return result.join(' ');
}

function cleanAssemblyName(name: string): string {
  return cleanDuplicateWords(
    name
      .replace(/No\.?\s*Ref.*$/i, '')
      .replace(/L\.?O\.?N.*$/i, '')
      .replace(/Deskripsi.*$/i, '')
      .replace(/F\.?R\.?T.*$/i, '')
      .trim()
  );
}

async function extractRevo110Kww() {
  console.log('Loading PDF from:', PDF_PATH);
  const data = new Uint8Array(fs.readFileSync(PDF_PATH));
  const doc = await pdfjs.getDocument({ data, wasmUrl: wasmDir }).promise;
  console.log(`PDF loaded. Total pages: ${doc.numPages}`);

  const pages: BlobAssemblyPage[] = [];
  let seq = 0;

  // Pages 30 to 120 (91 assembly pages)
  for (let pageNo = 30; pageNo <= 120; pageNo++) {
    const page = await doc.getPage(pageNo);
    const vp = page.getViewport({ scale: 1.0 });
    const tc = await page.getTextContent();

    // Deduplicate overlapping items (pseudo-bold drop shadow in PDF export)
    const items = tc.items
      .map((it: any) => {
        const [vx, vy] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
        return {
          str: it.str.trim(),
          vx: Math.round(vx),
          vy: Math.round(vy),
        };
      })
      .filter((i: any) => i.str.length > 0);

    const deduped: typeof items = [];
    for (const it of items) {
      const dupIdx = deduped.findIndex((d) => Math.abs(d.vy - it.vy) <= 2 && Math.abs(d.vx - it.vx) <= 4);
      if (dupIdx !== -1) {
        if (it.str.length > deduped[dupIdx].str.length) {
          deduped[dupIdx] = it;
        }
      } else {
        deduped.push(it);
      }
    }

    // 1. Identify Assembly Code and Name (vy < 80)
    const codeItem = deduped.find((i) => /^[EF]\s*-\s*\d+(?:-\d+)?$/.test(i.str) && i.vy < 80);
    const code = codeItem ? codeItem.str.replace(/\s+/g, '') : `P-${pageNo}`;
    const groupType: 'engine' | 'frame' = code.startsWith('E') ? 'engine' : 'frame';

    const nameItems = deduped.filter(
      (i) => i.vy < 80 && i.str !== codeItem?.str && !/^\d+$/.test(i.str) && i.vx > 150 && i.vx < 600
    );
    const rawName = cleanText(nameItems.map((i) => i.str).join(' '));
    const name = cleanAssemblyName(rawName) || `Assembly ${code}`;

    // 2. Identify Table Rows (vy >= 295 && vy <= 570)
    const isOdd = pageNo % 2 !== 0;
    const refMinX = isOdd ? 95 : 85;
    const refMaxX = isOdd ? 130 : 115;
    const pnMinX = isOdd ? 130 : 115;
    const pnMaxX = isOdd ? 210 : 195;
    const descMinX = isOdd ? 205 : 190;
    const qtyMinX = isOdd ? 395 : 380;
    const qtyMaxX = isOdd ? 485 : 470;

    const tableItems = deduped.filter((i) => i.vy >= 295 && i.vy <= 570);
    const rows: { vy: number; items: typeof deduped }[] = [];

    for (const it of tableItems) {
      let row = rows.find((r) => Math.abs(r.vy - it.vy) <= 3);
      if (!row) {
        row = { vy: it.vy, items: [] };
        rows.push(row);
      }
      row.items.push(it);
    }
    rows.sort((a, b) => a.vy - b.vy);

    const extractedItems: ExtractedItem[] = [];
    let curItem: ExtractedItem | null = null;

    for (const row of rows) {
      row.items.sort((a, b) => a.vx - b.vx);

      const refItem = row.items.find((i) => i.vx >= refMinX && i.vx <= refMaxX && /^\d+[A-Z]?$/.test(i.str));
      const pnItem = row.items.find(
        (i) => i.vx >= pnMinX && i.vx <= pnMaxX && (i.str.includes('-') || /^\d{5}/.test(i.str))
      );
      const qtyItems = row.items.filter((i) => i.vx >= qtyMinX && i.vx <= qtyMaxX && /^\d+$/.test(i.str));
      const descItems = row.items.filter((i) => i.vx >= descMinX && i.vx < qtyMinX);
      const noteItems = row.items.filter((i) => i.vx > qtyMaxX);

      const descText = cleanDuplicateWords(cleanText(descItems.map((i) => i.str).join(' ')));
      const noteText = cleanText(noteItems.map((i) => i.str).join(' '));
      const qty = qtyItems.length > 0 ? Math.max(...qtyItems.map((q) => parseInt(q.str, 10))) : 1;

      if (pnItem) {
        let pnVal = pnItem.str;
        if (refItem) {
          const item: ExtractedItem = {
            refNo: refItem.str,
            description: descText || 'PARTS',
            qty,
            partNumbers: [
              {
                value: pnVal,
                note: noteText || null,
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
          });
        }
      } else if (descText && curItem) {
        curItem.description = cleanDuplicateWords(cleanText(curItem.description + ' ' + descText));
      }
    }

    // 3. Diagram Crop Extraction via Canvas
    let diagramCropBase64: string | null = null;
    let thumbDataUrl: string | null = null;
    let imgW = 0;
    let imgH = 0;

    try {
      const renderVp = page.getViewport({ scale: 1.5 });
      const canvas = createCanvas(renderVp.width, renderVp.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx as any, viewport: renderVp }).promise;
      const fullPagePng = canvas.toBuffer('image/png');

      const meta = await sharp(fullPagePng).metadata();
      if (meta.width && meta.height) {
        const left = Math.round(meta.width * (isOdd ? 0.13 : 0.11));
        const top = Math.round(meta.height * 0.13);
        const cropW = Math.round(meta.width * 0.46);
        const cropH = Math.round(meta.height * 0.33);

        const cropBuf = await sharp(fullPagePng)
          .extract({ left, top, width: cropW, height: cropH })
          .png({ compressionLevel: 9 })
          .toBuffer();

        imgW = cropW;
        imgH = cropH;
        diagramCropBase64 = cropBuf.toString('base64');

        const thumbBuf = await sharp(cropBuf)
          .resize({ width: 400, withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        thumbDataUrl = `data:image/jpeg;base64,${thumbBuf.toString('base64')}`;
      }
    } catch (e) {
      // Fallback
    }

    if (!diagramCropBase64) {
      const prevPage = pages.slice().reverse().find((p) => p.extracted.assembly.code === code && p.diagramCropBase64);
      if (prevPage) {
        diagramCropBase64 = prevPage.diagramCropBase64;
        imgW = prevPage.width ?? 0;
        imgH = prevPage.height ?? 0;
        thumbDataUrl = prevPage.thumbDataUrl;
      }
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
    console.log(`[${seq}/91] ${code} · ${name} (p${pageNo}): ${extractedItems.length} items`);
  }

  const finalPackage: BlobPackage = {
    version: 1,
    machineHint: {
      brand: 'Honda',
      model: 'Revo 110',
      typeCode: 'KWW',
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

extractRevo110Kww().catch(console.error);
