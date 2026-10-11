import fs from 'fs';
import path from 'path';
import sharp from '../node_modules/.bun/sharp@0.35.2/node_modules/sharp';
import * as pdfjs from '../node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { validateBlobPackage } from '../apps/admin/src/ingest-helpers';
import type { BlobPackage, BlobAssemblyPage, ExtractedItem } from '../apps/admin/src/types';

const wasmDir = path.resolve('node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/wasm') + '/';
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error('GEMINI_API_KEY environment variable is required.');
  process.exit(1);
}

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

interface VisionPageResult {
  assemblyCode: string;
  assemblyName: string;
  groupType: 'engine' | 'frame';
  isContinuation: boolean;
  diagramBox: { x: number; y: number; width: number; height: number } | null;
  items: {
    refNo: string;
    partNumbers: string[];
    description: string;
    qty: number;
    note?: string | null;
  }[];
}

async function callGeminiVision(jpegBase64: string, pageNo: number): Promise<VisionPageResult> {
  const prompt = `You are an expert motorcycle parts catalog data extraction system.
Analyze this scanned Honda motorcycle parts catalog page (Page ${pageNo}).
Extract:
1. "assemblyCode": string (e.g. "E-2", "E-10", "F-4", "F-14-10"). Look at the header/banner.
2. "assemblyName": string (e.g. "CYLINDER HEAD", "CAMSHAFT/VALVE", "THROTTLE BODY"). Clean name without code or prefixes.
3. "groupType": "engine" (if assemblyCode starts with E) or "frame" (if starts with F).
4. "isContinuation": boolean (true if this page continues a previous assembly without a new diagram illustration).
5. "diagramBox": { "x": number, "y": number, "width": number, "height": number } (pixel bounding box of the diagram illustration pane on this image), or null if isContinuation is true or no diagram is present.
6. "items": array of parts in the table. Each item:
   - "refNo": string (the callout number, e.g. "1", "2")
   - "partNumbers": [string] (canonical Honda part number e.g. "12310-K97-T00")
   - "description": string (part name in uppercase)
   - "qty": number (required quantity integer, default 1)
   - "note": string or null

Return ONLY valid JSON matching this schema:
{
  "assemblyCode": "E-2",
  "assemblyName": "CYLINDER HEAD COVER",
  "groupType": "engine",
  "isContinuation": false,
  "diagramBox": { "x": 100, "y": 100, "width": 500, "height": 350 },
  "items": [
    {
      "refNo": "1",
      "partNumbers": ["12310-K97-T00"],
      "description": "COVER COMP., HEAD",
      "qty": 1,
      "note": null
    }
  ]
}`;

  const models = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest'];

  for (let attempt = 0; attempt < 5; attempt++) {
    const model = models[attempt % models.length];
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
        console.warn(`[Page ${pageNo}] Attempt ${attempt + 1} with ${model} failed (${res.status}): ${errText.slice(0, 100)}`);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('No candidate content in response');
      const parsed: VisionPageResult = JSON.parse(text);
      if (!parsed.assemblyCode || !parsed.assemblyName) {
        throw new Error('Missing assemblyCode or assemblyName in extracted JSON');
      }
      return parsed;
    } catch (e: any) {
      console.warn(`[Page ${pageNo}] Attempt ${attempt + 1} error: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }

  throw new Error(`Failed to extract page ${pageNo} after multiple attempts.`);
}

export async function extractScannedCatalog(options: {
  pdfPath: string;
  sourceName: string;
  blobOut: string;
  desktopOut: string;
  machineHint: { brand: string; model: string; typeCode: string };
  startPage: number;
  endPage: number;
  cacheDirName: string;
}) {
  const { pdfPath, sourceName, blobOut, desktopOut, machineHint, startPage, endPage, cacheDirName } = options;

  console.log(`\n======================================================`);
  console.log(`EXTRACTING SCANNED CATALOG: ${machineHint.brand} ${machineHint.model} (${machineHint.typeCode})`);
  console.log(`Source: ${pdfPath}`);
  console.log(`Page range: ${startPage} .. ${endPage} (${endPage - startPage + 1} pages)`);
  console.log(`======================================================\n`);

  const cacheDir = `/tmp/extract_cache_${cacheDirName}`;
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, wasmUrl: wasmDir }).promise;

  const totalPages = endPage - startPage + 1;
  const pageNumbers: number[] = [];
  for (let p = startPage; p <= endPage; p++) {
    pageNumbers.push(p);
  }

  const pagesMap = new Map<number, BlobAssemblyPage>();
  const CONCURRENCY = 4;
  let running = 0;
  let nextIdx = 0;
  let processedCount = 0;

  async function processPage(pageNo: number): Promise<void> {
    const cacheFile = `${cacheDir}/page_${pageNo}.json`;
    if (fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        pagesMap.set(pageNo, cached);
        processedCount++;
        process.stdout.write(`\r[${processedCount}/${totalPages}] Cached page ${pageNo}: ${cached.extracted.assembly.code} - ${cached.extracted.assembly.name}`);
        return;
      } catch {}
    }

    const page = await doc.getPage(pageNo);
    const ops = await page.getOperatorList();
    const imgArg = ops.argsArray.find((a: any) => Array.isArray(a) && typeof a[0] === 'string' && a[0].startsWith('img_'));
    if (!imgArg) {
      console.warn(`\n[Page ${pageNo}] No image operator found. Skipping.`);
      return;
    }

    const imgObj = await getImageObj(page, imgArg[0]);
    if (!imgObj || !imgObj.data) {
      console.warn(`\n[Page ${pageNo}] Image data missing. Skipping.`);
      return;
    }

    const rawWidth = imgObj.width;
    const rawHeight = imgObj.height;
    const channels = imgObj.data.length / (rawWidth * rawHeight);

    // 1. Prepare raw buffer
    const rawSharp = sharp(Buffer.from(imgObj.data), {
      raw: { width: rawWidth, height: rawHeight, channels: (channels === 1 ? 1 : 3) as any },
    });

    // 2. Prepare JPEG for Gemini Vision
    const jpegBuf = await rawSharp.clone().resize({ width: 1000 }).jpeg({ quality: 80 }).toBuffer();
    const vision = await callGeminiVision(jpegBuf.toString('base64'), pageNo);

    // 3. Diagram Crop
    let diagramCropBase64: string | null = null;
    let thumbDataUrl: string | null = null;
    let cropW = 0;
    let cropH = 0;

    if (!vision.isContinuation) {
      // Default Honda illustration box: top-left quadrant (~52% width, ~48% height)
      let left = Math.round(rawWidth * 0.08);
      let top = Math.round(rawHeight * 0.10);
      let width = Math.round(rawWidth * 0.52);
      let height = Math.round(rawHeight * 0.48);

      if (vision.diagramBox && vision.diagramBox.width > 50 && vision.diagramBox.height > 50) {
        // Scale from resized (1000px) back to rawWidth if needed
        const scale = rawWidth / 1000;
        left = Math.max(0, Math.min(rawWidth - 50, Math.round(vision.diagramBox.x * scale)));
        top = Math.max(0, Math.min(rawHeight - 50, Math.round(vision.diagramBox.y * scale)));
        width = Math.min(rawWidth - left, Math.round(vision.diagramBox.width * scale));
        height = Math.min(rawHeight - top, Math.round(vision.diagramBox.height * scale));
      }

      cropW = width;
      cropH = height;

      const cropBuf = await rawSharp.clone().extract({ left, top, width, height }).png({ compressionLevel: 8 }).toBuffer();
      diagramCropBase64 = cropBuf.toString('base64');

      const thumbBuf = await sharp(cropBuf).resize({ width: 400, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
      thumbDataUrl = `data:image/jpeg;base64,${thumbBuf.toString('base64')}`;
    }

    // 4. Build Extracted Items
    const extractedItems: ExtractedItem[] = [];
    for (const it of vision.items || []) {
      const pns = (it.partNumbers || []).filter(Boolean).map((pn) => ({
        value: cleanText(pn).toUpperCase(),
        note: it.note ? cleanText(it.note) : null,
      }));
      if (pns.length === 0) continue;

      extractedItems.push({
        refNo: String(it.refNo || '').trim(),
        description: cleanText(it.description || '').toUpperCase(),
        qty: Number.isInteger(it.qty) && it.qty > 0 ? it.qty : 1,
        partNumbers: pns,
        dots: [],
      });
    }

    const groupType: 'engine' | 'frame' = vision.assemblyCode.toUpperCase().startsWith('E') ? 'engine' : 'frame';

    const pageObj: BlobAssemblyPage = {
      source: sourceName,
      pageNo,
      seq: pageNo - startPage + 1,
      type: 'assembly',
      groupType,
      extracted: {
        assembly: {
          code: vision.assemblyCode.toUpperCase().trim(),
          name: cleanAssemblyName(vision.assemblyName).toUpperCase(),
        },
        items: extractedItems,
        serviceItems: [],
      },
      diagramCropBase64,
      thumbDataUrl,
      width: cropW || null,
      height: cropH || null,
      mediaType: 'image/png',
    };

    fs.writeFileSync(cacheFile, JSON.stringify(pageObj));
    pagesMap.set(pageNo, pageObj);
    processedCount++;
    process.stdout.write(`\r[${processedCount}/${totalPages}] Done page ${pageNo}: ${pageObj.extracted.assembly.code} - ${pageObj.extracted.assembly.name} (${extractedItems.length} items)`);
  }

  await new Promise<void>((resolve) => {
    function launch() {
      if (nextIdx >= pageNumbers.length && running === 0) {
        return resolve();
      }
      while (running < CONCURRENCY && nextIdx < pageNumbers.length) {
        const p = pageNumbers[nextIdx++];
        running++;
        processPage(p)
          .catch((err) => {
            console.error(`\nError processing page ${p}:`, err.message);
          })
          .finally(() => {
            running--;
            launch();
          });
      }
    }
    launch();
  });

  console.log('\n\nAll pages extracted. Ordering and validating BlobPackage...');

  const orderedPages: BlobAssemblyPage[] = [];
  for (let seq = 1, p = startPage; p <= endPage; p++) {
    const page = pagesMap.get(p);
    if (page) {
      page.seq = seq++;
      orderedPages.push(page);
    }
  }

  const pkg: BlobPackage = {
    version: 1,
    exportedAt: Date.now(),
    sourcePdf: sourceName,
    machineHint,
    sources: [sourceName],
    pages: orderedPages,
  };

  validateBlobPackage(pkg);
  console.log('Blob package validated successfully!');

  const jsonStr = JSON.stringify(pkg);
  const outDir = path.dirname(blobOut);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(blobOut, jsonStr);
  console.log(`Saved blob to: ${blobOut} (${Math.round(jsonStr.length / 1024)} KB)`);

  const desktopDir = path.dirname(desktopOut);
  if (fs.existsSync(desktopDir)) {
    fs.writeFileSync(desktopOut, jsonStr);
    console.log(`Copied blob to Windows Desktop: ${desktopOut}`);
  }

  console.log(`\n🎉 EXTRACTION COMPLETE!`);
  console.log(`Total assembly pages: ${orderedPages.length}`);
  console.log(`Total items: ${orderedPages.reduce((acc, p) => acc + p.extracted.items.length, 0)}`);
}
