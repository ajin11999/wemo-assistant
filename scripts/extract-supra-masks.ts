import * as pdfjs from '../node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';
import path from 'path';
import sharp from '../node_modules/.bun/sharp@0.35.2/node_modules/sharp';
import { execSync } from 'child_process';

const wasmDir = path.resolve('node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/wasm') + '/';
const PDF_PATH = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/Katalog-Suku-Cadang-Honda-Supra-X-125-2.pdf';

const TARGETS = [
  { pageNo: 53, code: 'P-53', id: '01ec5a28-5df1-4b5a-8a29-fc545402aaf2', name: 'Front Wheel F-11-2' },
  { pageNo: 60, code: 'P-60', id: '0b3259a3-c64c-47a7-9a40-f26e27bcdf9f', name: 'Rear Wheel F-15-1' },
  { pageNo: 64, code: 'P-64', id: '06ab41d1-951e-4dec-adef-99a81eb2c5af', name: 'Fuel Tank F-16-1' },
  { pageNo: 77, code: 'F-26', id: '6e715b68-1294-4647-879a-65ea10b15cf2', name: 'Rear Fender F-26' },
  { pageNo: 83, code: 'P-83', id: '04ef4472-0ac6-4d9a-818c-2751653c91af', name: 'Wire Harness F-30-1' },
  { pageNo: 84, code: 'P-84', id: '1296dd21-29ce-4c3e-868a-5f8b768ddf09', name: 'Wire Harness F-30-1' },
];

async function main() {
  const data = new Uint8Array(fs.readFileSync(PDF_PATH));
  const doc = await pdfjs.getDocument({ data, wasmUrl: wasmDir }).promise;

  for (const t of TARGETS) {
    console.log(`\nProcessing page ${t.pageNo} for ${t.code} (${t.name})...`);
    const page = await doc.getPage(t.pageNo);
    const ops = await page.getOperatorList();
    const maskIdx = ops.fnArray.indexOf(pdfjs.OPS.paintImageMaskXObject);
    if (maskIdx === -1) {
      console.error(`No mask found on page ${t.pageNo}!`);
      continue;
    }
    const argObj = ops.argsArray[maskIdx][0];
    const imgName = typeof argObj === 'string' ? argObj : argObj.data;
    const imgObj: any = await new Promise((resolve) => page.objs.get(imgName, resolve));

    const w = imgObj.width;
    const h = imgObj.height;
    const rowBytes = Math.ceil(w / 8);
    const outBuf = Buffer.alloc(w * h);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const byteIdx = y * rowBytes + Math.floor(x / 8);
        const bitIdx = 7 - (x % 8);
        const bit = (imgObj.data[byteIdx] >> bitIdx) & 1;
        outBuf[y * w + x] = bit ? 255 : 0;
      }
    }

    const tmpPath = `/tmp/supra_karbu_${t.code}.png`;
    await sharp(outBuf, { raw: { width: w, height: h, channels: 1 } })
      .png({ compressionLevel: 8 })
      .toFile(tmpPath);

    console.log(`Saved ${tmpPath} (${w}x${h}). Uploading to R2...`);
    execSync(`npx wrangler r2 object put "wemo-assistant-catalog-images/assemblies/${t.id}" --file="${tmpPath}" --content-type="image/png" --remote`, {
      cwd: 'apps/backend',
      stdio: 'inherit',
    });
    fs.unlinkSync(tmpPath);

    // Update dimensions in D1
    const sql = `UPDATE assemblies SET width = ${w}, height = ${h}, updated_at = unixepoch() WHERE id = '${t.id}';`;
    execSync(`bunx wrangler d1 execute wemo-assistant --remote --command "${sql.replace(/"/g, '\\"')}"`, {
      cwd: 'apps/backend',
      stdio: 'inherit',
    });
    console.log(`Updated D1 dimensions for ${t.code}`);
  }

  console.log('\nAll 6 Supra X 125 Karburator missing images extracted, uploaded to R2, and updated in D1!');
}

main().catch(console.error);
