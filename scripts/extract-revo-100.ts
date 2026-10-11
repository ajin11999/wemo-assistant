import fs from 'fs';
import path from 'path';
import sharp from '../node_modules/.bun/sharp@0.35.2/node_modules/sharp';
import * as pdfjs from '../node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { validateBlobPackage } from '../apps/admin/src/ingest-helpers';
import type { BlobPackage, BlobAssemblyPage, ExtractedItem } from '../apps/admin/src/types';

const PDF_PATH = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/Katalog-Suku-Cadang-Honda-Revo-100-2007-2010.pdf';
const SOURCE_NAME = 'Katalog-Suku-Cadang-Honda-Revo-100-2007-2010.pdf';
const BLOB_OUT = 'apps/backend/backups/revo-100-blob.json';
const DESKTOP_OUT = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/revo-100-blob.json';

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

async function extractRevo100() {
  console.log('Loading PDF from:', PDF_PATH);
  const data = new Uint8Array(fs.readFileSync(PDF_PATH));
  const doc = await pdfjs.getDocument({ data, wasmUrl: wasmDir }).promise;
  console.log(`PDF loaded. Total pages: ${doc.numPages}`);

  const pages: BlobAssemblyPage[] = [];
  let seq = 0;

  // Pages 14 to 77 (64 assembly pages, p78..87 are index pages)
  for (let pageNo = 14; pageNo <= 77; pageNo++) {
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

    // 1. Identify Assembly Code and Name (vy < 200)
    const codeItem = allItems.find((i) => /^[EF]\s*-\s*\d+(?:-\d+)?$/.test(i.str) && i.vy < 200);
    const code = codeItem ? codeItem.str.replace(/\s+/g, '') : `P-${pageNo}`;
    const groupType: 'engine' | 'frame' = code.startsWith('E') ? 'engine' : 'frame';

    const nameItems = allItems.filter(
      (i) => i.vy < 200 && i.vy > (codeItem?.vy || 0) && i.vx < 350 && i.str !== codeItem?.str && !/^\d+$/.test(i.str)
    );
    const name = cleanAssemblyName(cleanText(nameItems.map((i) => i.str).join(' '))) || `Assembly ${code}`;

    // 2. Identify Table Headers (vy between 240 and 315)
    const headerRef = allItems.find((i) => /^No\.?$/i.test(i.str) && i.vy >= 240 && i.vy <= 315 && i.vx > 250);
    const headerPn = allItems.find((i) => /Part\s*Number|Nomor\s*Part/i.test(i.str) && i.vy >= 240 && i.vy <= 315);
    const headerDesc = allItems.find((i) => /Description|Deskripsi|Uraian/i.test(i.str) && i.vy >= 240 && i.vy <= 315);
    const headerQty = allItems.find((i) => /QTY|Jumlah/i.test(i.str) && i.vy >= 240 && i.vy <= 315);
    const headerNotes = allItems.find((i) => /Notes|Catatan/i.test(i.str) && i.vy >= 240 && i.vy <= 315);

    const refX = headerRef ? headerRef.vx : (pageNo % 2 === 0 ? 275 : 300);
    const pnX = headerPn ? headerPn.vx : (pageNo % 2 === 0 ? 305 : 330);
    const descX = headerDesc ? headerDesc.vx : (pageNo % 2 === 0 ? 400 : 425);
    const qtyX = headerQty ? headerQty.vx : (pageNo % 2 === 0 ? 595 : 615);
    const notesX = headerNotes ? headerNotes.vx : (pageNo % 2 === 0 ? 670 : 695);

    const headerVy = headerRef?.vy || headerPn?.vy || 295;

    // 3. Identify Table Rows (vy > headerVy + 8 && vy <= 570)
    const tableItems = allItems.filter((i) => i.vy > headerVy + 8 && i.vy <= 570);
    const rows: { vy: number; items: typeof allItems }[] = [];

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

      const refItem = row.items.find((i) => i.vx >= refX - 15 && i.vx < pnX - 5 && /^\d+[A-Z]?$/.test(i.str));
      const pnItem = row.items.find((i) => i.vx >= pnX - 15 && i.vx < descX - 15 && (i.str.includes('-') || /^\d{5}/.test(i.str)));
      const qtyItem = row.items.find((i) => i.vx >= qtyX - 15 && i.vx < notesX - 10 && /^\d+$/.test(i.str));
      const descItems = row.items.filter((i) => i.vx >= descX - 15 && i.vx < qtyX - 15);
      const noteItems = row.items.filter((i) => i.vx >= notesX - 15);

      const descText = cleanText(descItems.map((i) => i.str).join(' '));
      const noteText = cleanText(noteItems.map((i) => i.str).join(' '));
      const qty = qtyItem ? parseInt(qtyItem.str, 10) : 1;

      if (pnItem) {
        let pnVal = pnItem.str;
        if (refItem) {
          const item: ExtractedItem = {
            refNo: refItem.str,
            description: cleanText(descText) || 'PARTS',
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
        curItem.description = cleanText(curItem.description + ' ' + descText);
      }
    }

    // 4. Diagram Image Extraction
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
        })
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
    console.log(`[${seq}/64] ${code} · ${name} (p${pageNo}): ${extractedItems.length} items`);
  }

  const finalPackage: BlobPackage = {
    version: 1,
    machineHint: {
      brand: 'Honda',
      model: 'Revo 100',
      typeCode: 'KVR',
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

extractRevo100().catch(console.error);
