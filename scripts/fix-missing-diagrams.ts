import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import sharp from '../node_modules/.bun/sharp@0.35.2/node_modules/sharp';
import * as pdfjs from '../node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { scanCatalog, PageScanResult } from './scan-catalog-helper';

const wasmDir = path.resolve('node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/wasm') + '/';

interface AssemblyRow {
  id: string;
  machine_id: string;
  code: string;
  name: string;
}

function getImageObj(page: any, imgName: string): Promise<any> {
  const pool = imgName.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => pool.get(imgName, (data: any) => resolve(data)));
}

function normalizeCode(c: string): string {
  return c.toUpperCase().replace(/\s+/g, '').replace(/_/g, '-').trim();
}

async function main() {
  console.log('================================================================');
  console.log('STARTING DIAGRAM EXTRACTION & DEPLOYMENT FOR VERZA & SUPRA GTR');
  console.log('================================================================\n');

  const outDir = '/tmp/extracted_diagrams';
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // 1. Fetch missing assemblies from D1
  console.log('>>> Fetching missing assemblies from D1...');
  const d1Cmd = `npx wrangler d1 execute wemo-assistant --remote --command="SELECT id, machine_id, code, name FROM assemblies WHERE machine_id IN ('bba8ad17-87db-4490-a72a-ca29cd0b8911', '083d1a6d-4fd9-49a8-a326-4f28c4b9c5c8') AND image_ref IS NULL ORDER BY machine_id, code" --json --yes`;
  const d1Out = execSync(d1Cmd, { cwd: 'apps/backend', encoding: 'utf8' });
  const d1Parsed = JSON.parse(d1Out);
  const missingRows: AssemblyRow[] = d1Parsed[0]?.results || [];

  const verzaMissing = missingRows.filter((r) => r.machine_id === 'bba8ad17-87db-4490-a72a-ca29cd0b8911');
  const gtrMissing = missingRows.filter((r) => r.machine_id === '083d1a6d-4fd9-49a8-a326-4f28c4b9c5c8');

  console.log(`Found ${verzaMissing.length} missing assemblies for Honda CB150 Verza`);
  console.log(`Found ${gtrMissing.length} missing assemblies for Honda Supra GTR 150`);

  // 2. Scan CB150 Verza pages
  const verzaPdf = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/Katalog-Suku-Cadang-Honda-CB150-Verza-K18H.pdf';
  console.log('\n>>> Scanning CB150 Verza catalog...');
  const verzaScan = await scanCatalog(verzaPdf, 46, 89, '/tmp/verza_pages_cache.json', 'CB150 Verza');

  // 3. Scan Supra GTR pages
  const gtrPdf = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/Katalog-Suku-Cadang-Honda-Supra-GTR-K56W.pdf';
  console.log('\n>>> Scanning Supra GTR catalog...');
  const gtrScan = await scanCatalog(gtrPdf, 85, 115, '/tmp/gtr_pages_cache.json', 'Supra GTR');

  // 4. Map assemblies to pages
  interface CropPlan {
    assembly: AssemblyRow;
    pdfPath: string;
    pageNo: number;
    scan: PageScanResult;
    isGtr: boolean;
  }

  const plans: CropPlan[] = [];

  function mapAssemblies(
    missingList: AssemblyRow[],
    scanMap: Map<number, PageScanResult>,
    pdfPath: string,
    isGtr: boolean
  ) {
    for (const asm of missingList) {
      const targetCode = normalizeCode(asm.code);
      let matchedPage: PageScanResult | null = null;

      // Look for exact code match on a diagram page
      for (const page of scanMap.values()) {
        if (!page.code) continue;
        const pageCode = normalizeCode(page.code);
        if (pageCode === targetCode && page.hasDiagram && !page.isContinuation) {
          matchedPage = page;
          break;
        }
      }

      // Fallback: match without prefix/suffix or match by code prefix
      if (!matchedPage) {
        for (const page of scanMap.values()) {
          if (!page.code) continue;
          const pageCode = normalizeCode(page.code);
          if (pageCode === targetCode && page.hasDiagram) {
            matchedPage = page;
            break;
          }
        }
      }

      if (matchedPage) {
        plans.push({
          assembly: asm,
          pdfPath,
          pageNo: matchedPage.pageNo,
          scan: matchedPage,
          isGtr,
        });
        console.log(`Matched ${asm.code} (${asm.name}) -> Page ${matchedPage.pageNo} [${matchedPage.code}]`);
      } else {
        console.error(`❌ NO MATCH FOUND for ${asm.code} (${asm.name})!`);
      }
    }
  }

  console.log('\n>>> Mapping Verza assemblies...');
  mapAssemblies(verzaMissing, verzaScan, verzaPdf, false);

  console.log('\n>>> Mapping Supra GTR assemblies...');
  mapAssemblies(gtrMissing, gtrScan, gtrPdf, true);

  if (plans.length < missingRows.length) {
    console.error(`\n⚠️ Warning: only matched ${plans.length} of ${missingRows.length} assemblies!`);
  }

  // 5. Open PDFs and perform crops
  console.log('\n>>> Extracting and cropping diagrams...');
  const verzaDoc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(verzaPdf)),
    wasmUrl: wasmDir,
  }).promise;
  const gtrDoc = await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(gtrPdf)),
    wasmUrl: wasmDir,
  }).promise;

  const croppedFiles: { id: string; code: string; filePath: string; width: number; height: number }[] = [];

  for (const plan of plans) {
    const doc = plan.isGtr ? gtrDoc : verzaDoc;
    const page = await doc.getPage(plan.pageNo);
    const ops = await page.getOperatorList();
    const imgArg = ops.argsArray.find(
      (a: any) => Array.isArray(a) && typeof a[0] === 'string' && a[0].startsWith('img_')
    );
    if (!imgArg) {
      console.error(`No image found on page ${plan.pageNo}`);
      continue;
    }
    const img = await getImageObj(page, imgArg[0]);
    const rawW = img.width;
    const rawH = img.height;

    const scale = rawW / 1000;
    let left: number;
    let top: number;
    let width: number;
    let height: number;

    if (plan.scan.box && plan.scan.box.width >= 300 && plan.scan.box.height >= 250) {
      left = Math.round(plan.scan.box.x * scale);
      top = Math.round(plan.scan.box.y * scale);
      width = Math.round(plan.scan.box.width * scale);
      height = Math.round(plan.scan.box.height * scale);
    } else {
      // Default coordinates
      left = plan.isGtr ? 159 : 118;
      top = plan.isGtr ? 75 : 55;
      width = plan.isGtr ? 1027 : 884;
      height = plan.isGtr ? 495 : 485;
    }

    // Snap / clamp
    left = Math.max(0, Math.min(rawW - 200, left));
    top = Math.max(0, Math.min(rawH - 200, top));
    width = Math.min(rawW - left, Math.max(500, width));
    height = Math.min(rawH - top, Math.max(350, height));

    const outPath = `${outDir}/${plan.assembly.id}.png`;
    await sharp(Buffer.from(img.data), {
      raw: { width: rawW, height: rawH, channels: 3 },
    })
      .extract({ left, top, width, height })
      .png({ compressionLevel: 8 })
      .toFile(outPath);

    croppedFiles.push({
      id: plan.assembly.id,
      code: plan.assembly.code,
      filePath: outPath,
      width,
      height,
    });
    console.log(`Cropped [${plan.assembly.code}] ${plan.assembly.name}: ${width}x${height} -> ${outPath}`);
  }

  // 6. Upload to R2 and update D1
  console.log(`\n>>> Uploading ${croppedFiles.length} images to R2 and updating D1...`);
  const d1Updates: string[] = [];

  for (let i = 0; i < croppedFiles.length; i++) {
    const item = croppedFiles[i];
    console.log(`[${i + 1}/${croppedFiles.length}] Uploading R2 assemblies/${item.id} (${item.code})...`);

    const r2Cmd = `npx wrangler r2 object put "wemo-assistant-catalog-images/assemblies/${item.id}" --file="${item.filePath}" --content-type="image/png" --remote`;
    execSync(r2Cmd, { cwd: 'apps/backend', stdio: 'pipe' });

    d1Updates.push(
      `UPDATE assemblies SET image_ref = 'assemblies/' || '${item.id}', width = ${item.width}, height = ${item.height}, updated_at = unixepoch() WHERE id = '${item.id}';`
    );
  }

  console.log('\n>>> Executing D1 updates batch...');
  const sqlBatch = d1Updates.join('\n');
  const tempSql = '/tmp/update_diagrams.sql';
  fs.writeFileSync(tempSql, sqlBatch);

  const d1UpdateCmd = `npx wrangler d1 execute wemo-assistant --remote --file="${tempSql}" --yes`;
  execSync(d1UpdateCmd, { cwd: 'apps/backend', stdio: 'inherit' });

  // 7. Verification
  console.log('\n>>> Verifying production endpoints...');
  let successCount = 0;
  for (const item of croppedFiles) {
    const url = `https://wemo-assistant-backend.bidipeppercrap.workers.dev/assemblies/${item.id}/image`;
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.status === 200) {
        successCount++;
        process.stdout.write(`\rVerified: ${successCount}/${croppedFiles.length} live (200 OK)`);
      } else {
        console.error(`\n❌ Failed HEAD for ${item.code} (${url}): ${res.status}`);
      }
    } catch (e: any) {
      console.error(`\n❌ Error HEAD for ${item.code} (${url}): ${e.message}`);
    }
  }

  console.log(`\n\n🎉 ALL DONE! Successfully processed, uploaded, and verified ${successCount}/${croppedFiles.length} diagram images.`);
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
