import fs from 'fs';
import path from 'path';
import sharp from '../node_modules/.bun/sharp@0.35.2/node_modules/sharp';
import * as pdfjs from '../node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { validateBlobPackage } from '../apps/admin/src/ingest-helpers';
import type { BlobPackage, BlobAssemblyPage, ExtractedItem, ExtractedServiceItem } from '../apps/admin/src/types';

const PDF_PATH = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/Katalog-Suku-Cadang-Honda-BeAT.pdf';
const SOURCE_NAME = 'Katalog-Suku-Cadang-Honda-BeAT.pdf';

// Helper to get image object asynchronously (handling both page.objs and page.commonObjs)
function getImageObj(page: any, imgName: string): Promise<any> {
  const pool = imgName.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    pool.get(imgName, (data: any) => {
      resolve(data);
    });
  });
}

// Cleans dots/leaders and extra spaces from strings
function cleanText(str: string): string {
  return str.replace(/\.{2,}/g, '').replace(/\s+/g, ' ').trim();
}

async function extractBeatCatalog() {
  console.log('Loading PDF from:', PDF_PATH);
  const data = new Uint8Array(fs.readFileSync(PDF_PATH));
  const doc = await pdfjs.getDocument({ data }).promise;
  console.log(`PDF loaded. Total pages: ${doc.numPages}`);

  const pages: BlobAssemblyPage[] = [];
  let seq = 0;

  // Pages 13 to 62 are the 50 assembly detail pages
  for (let pageNo = 13; pageNo <= 62; pageNo++) {
    const page = await doc.getPage(pageNo);
    const tc = await page.getTextContent();
    const items = tc.items.map((it: any) => ({
      str: it.str.trim(),
      x: Math.round(it.transform[4]),
      y: Math.round(it.transform[5]),
      w: it.width,
      h: it.height,
    })).filter((it: any) => it.str.length > 0);

    // Sort items top-to-bottom, left-to-right
    items.sort((a: any, b: any) => b.y - a.y || a.x - b.x);

    // Group items into horizontal lines (within 3pt Y tolerance)
    type Line = { y: number; items: typeof items };
    const lines: Line[] = [];
    let curLine: typeof items = [];
    let curY: number | null = null;
    for (const it of items) {
      if (curY === null || Math.abs(it.y - curY) > 3) {
        if (curLine.length) lines.push({ y: curY, items: curLine });
        curLine = [it];
        curY = it.y;
      } else {
        curLine.push(it);
      }
    }
    if (curLine.length) lines.push({ y: curY, items: curLine });

    // 1. Identify Assembly Code & Name
    // Search for code matching E-1 or F-1 or F-17-1
    let code: string = '';
    let name: string = '';
    for (const l of lines) {
      const codeItem = l.items.find((i: any) => /^[EF]\s*-\s*\d+(?:\s*-\s*\d+)?$/i.test(i.str));
      if (codeItem) {
        code = codeItem.str.replace(/\s+/g, '');
        // Usually assembly name is on the line right before or after the code
        const nameCandidates = lines
          .filter((line) => Math.abs(line.y - l.y) <= 30 && line !== l)
          .flatMap((line) => line.items)
          .filter((it) => it.x <= 260 && !/^(TST|06|Service|F\.R\.T|No\.|[0-9]+$)/.test(it.str) && it.str.length > 2);
        if (nameCandidates.length > 0) {
          name = nameCandidates.map((i) => i.str).join(' ');
        }
        break;
      }
    }

    if (!code) {
      // Fallback search across all items
      const codeItem = items.find((i: any) => /^[EF]\s*-\s*\d+(?:\s*-\s*\d+)?$/i.test(i.str));
      if (codeItem) code = codeItem.str.replace(/\s+/g, '');
    }

    const groupType: 'engine' | 'frame' = code.startsWith('E') ? 'engine' : 'frame';

    // 2. Parse Service Items (FRT)
    // Located on left side: x < 275, below header
    const serviceItems: ExtractedServiceItem[] = [];
    let curSvcRef: string | null = null;
    let curSvcName: string = '';
    let curFrt: number | null = null;

    // Header index
    const headerLineIdx = lines.findIndex((l) => l.items.some((i) => /Part Number/i.test(i.str)));
    const contentLines = headerLineIdx !== -1 ? lines.slice(headerLineIdx + 1) : lines;

    for (const l of contentLines) {
      if (l.y < 45) continue; // skip footer
      const leftItems = l.items.filter((i) => i.x < 275);
      if (leftItems.length === 0) continue;

      // Look for FRT number (e.g. 0.2, 1.1, 2.7)
      const frtItem = leftItems.find((i) => /^\d+\.\d+$/.test(i.str));
      // Look for ref number (e.g. "1", "2", "(3)")
      const refItem = leftItems.find((i) => /^\(?\d+\)?$/.test(i.str) && i.x <= 85);
      // Other text is description
      const descItems = leftItems.filter((i) => i !== frtItem && i !== refItem);
      const descText = descItems.map((i) => i.str).join(' ');

      if (frtItem) {
        const frtVal = parseFloat(frtItem.str);
        if (refItem || descText) {
          if (curSvcName && curFrt !== null) {
            serviceItems.push({
              refNo: curSvcRef,
              name: cleanText(curSvcName),
              frtHours: curFrt,
            });
          }
          curSvcRef = refItem ? refItem.str : null;
          curSvcName = descText;
          curFrt = frtVal;
        } else if (curSvcName) {
          curFrt = frtVal;
        }
      } else if (descText) {
        if (curSvcName) {
          curSvcName += ' ' + descText;
        }
      }
    }
    if (curSvcName && curFrt !== null) {
      serviceItems.push({
        refNo: curSvcRef,
        name: cleanText(curSvcName),
        frtHours: curFrt,
      });
    }

    // 3. Parse Parts Table
    // Located on right side: x >= 275
    const extractedItems: ExtractedItem[] = [];
    let curItem: ExtractedItem | null = null;

    for (const l of contentLines) {
      if (l.y < 45) continue; // skip footer
      const rightItems = l.items.filter((i) => i.x >= 275);
      if (rightItems.length === 0) continue;

      // Ref number column: 275 <= x <= 305
      const refItem = rightItems.find((i) => /^\d+\)?$/.test(i.str) && i.x <= 305);
      // Part number column: 305 <= x <= 398
      // Matches standard Honda format: 12200-KVY-900, 871X0-KVY-960ZA, 96001-0602500, etc.
      const pnItem = rightItems.find((i) =>
        /^[A-Z0-9]{4,5}-[A-Z0-9]{3,5}(?:-[A-Z0-9]{2,7})?$/i.test(i.str) && i.x >= 305 && i.x <= 398
      );
      // Quantity column: 590 <= x <= 645
      const qtyItem = rightItems.find((i) => /^\(?\d+\)?$/.test(i.str) && i.x >= 590 && i.x <= 645);
      const qtyVal = qtyItem ? parseInt(qtyItem.str.replace(/[()]/g, ''), 10) : 1;

      // Description items: between part number (or 398) and quantity (or 590)
      const descItems = rightItems.filter((i) =>
        i !== refItem && i !== pnItem && i !== qtyItem && i.x >= 398 && i.x < 590
      );
      const descText = descItems.map((i) => i.str).join(' ');

      // Notes items: x >= 645
      const notesItems = rightItems.filter((i) => i !== refItem && i !== pnItem && i !== qtyItem && i.x >= 645);
      const noteText = notesItems.map((i) => i.str).join(' ');

      if (pnItem) {
        const pnVal = pnItem.str;
        if (refItem) {
          // New position row
          const item: ExtractedItem = {
            refNo: refItem.str,
            description: cleanText(descText) || 'PARTS',
            qty: qtyVal,
            partNumbers: [{
              value: pnVal,
              note: noteText || null,
            }],
            dots: [],
          };
          extractedItems.push(item);
          curItem = item;
        } else if (curItem) {
          // Alternate part number for the same ref!
          curItem.partNumbers.push({
            value: pnVal,
            note: noteText || null,
          });
        }
      } else if (descText && curItem) {
        // Multi-line description continuation
        curItem.description = cleanText(curItem.description + ' ' + descText);
      }
    }

    // 4. Diagram Crop Extraction
    const ops = await page.getOperatorList();
    const imgIdx = ops.fnArray.indexOf(pdfjs.OPS.paintImageXObject);
    let diagramCropBase64: string | null = null;
    let thumbDataUrl: string | null = null;
    let imgW: number | null = null;
    let imgH: number | null = null;

    if (imgIdx !== -1) {
      const imgName = ops.argsArray[imgIdx][0];
      const imgObj = await getImageObj(page, imgName);
      if (imgObj && imgObj.data) {
        imgW = imgObj.width;
        imgH = imgObj.height;

        // Process full diagram PNG
        const pngBuf = await sharp(Buffer.from(imgObj.data), {
          raw: { width: imgW, height: imgH, channels: 3 },
        }).png({ compressionLevel: 9 }).toBuffer();
        diagramCropBase64 = pngBuf.toString('base64');

        // Process thumbnail JPEG (~400px wide)
        const thumbBuf = await sharp(pngBuf)
          .resize({ width: 400, withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();
        thumbDataUrl = `data:image/jpeg;base64,${thumbBuf.toString('base64')}`;
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
        serviceItems,
      },
      diagramCropBase64,
      mediaType: 'image/png',
      width: imgW,
      height: imgH,
      thumbDataUrl,
    };

    pages.push(blobPage);
    seq++;
    console.log(`Extracted [seq ${seq - 1}] P${pageNo}: ${code} "${blobPage.extracted.assembly.name}" — ${extractedItems.length} items, ${serviceItems.length} svc, img: ${imgW}x${imgH}`);
  }

  const pkg: BlobPackage = {
    version: 1,
    exportedAt: Date.now(),
    sources: [SOURCE_NAME],
    machineHint: {
      brand: 'Honda',
      model: 'BeAT',
      typeCode: 'KVY',
    },
    pages,
  };

  console.log('\nValidating package structure with validateBlobPackage()...');
  validateBlobPackage(pkg);
  console.log('Package validation PASSED!');

  const jsonStr = JSON.stringify(pkg, null, 2);
  const sizeMb = (Buffer.byteLength(jsonStr, 'utf8') / 1024 / 1024).toFixed(2);
  console.log(`Blob JSON size: ${sizeMb} MB (Hard cap: 80 MB, Pages: ${pkg.pages.length}/50)`);

  // Write outputs
  const destDesktop = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/beat-kvy-blob.json';
  const destBackend = './apps/backend/backups/beat-kvy-blob.json';
  fs.mkdirSync(path.dirname(destBackend), { recursive: true });

  fs.writeFileSync(destDesktop, jsonStr);
  console.log('Saved to Desktop:', destDesktop);
  fs.writeFileSync(destBackend, jsonStr);
  console.log('Saved to Backend backups:', destBackend);
}

extractBeatCatalog().catch((e) => {
  console.error('Extraction failed:', e);
  process.exit(1);
});
