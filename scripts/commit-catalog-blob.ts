import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync, exec } from 'child_process';
import type { BlobPackage } from '../apps/admin/src/types';

function runD1Sql(sql: string) {
  const tmpFile = `/tmp/d1_exec_${Date.now()}_${Math.random().toString(36).slice(2)}.sql`;
  fs.writeFileSync(tmpFile, sql);
  try {
    execSync(`npx wrangler d1 execute wemo-assistant --remote --file="${tmpFile}"`, {
      cwd: 'apps/backend',
      stdio: 'pipe',
    });
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

function queryD1Json(command: string): any[] {
  const out = execSync(`npx wrangler d1 execute wemo-assistant --remote --json --command "${command.replace(/"/g, '\\"')}"`, {
    cwd: 'apps/backend',
  }).toString();
  try {
    const parsed = JSON.parse(out);
    return parsed[0]?.results ?? [];
  } catch {
    return [];
  }
}

function esc(str: string | null | undefined): string {
  if (str === null || str === undefined) return 'NULL';
  return `'${String(str).replace(/'/g, "''")}'`;
}

async function commitBlob(blobPath: string, machineId: string) {
  console.log(`\n=== COMMITTING CATALOG BLOB ===`);
  console.log(`Blob: ${blobPath}`);
  console.log(`Machine ID: ${machineId}`);

  if (!fs.existsSync(blobPath)) {
    throw new Error(`Blob file not found: ${blobPath}`);
  }

  const pkg: BlobPackage = JSON.parse(fs.readFileSync(blobPath, 'utf8'));
  const machineHint = pkg.machineHint || { brand: 'Honda', model: 'Unknown', typeCode: null };

  // 1. Upsert machine
  console.log(`\n1. Upserting machine [${machineHint.brand} ${machineHint.model}]...`);
  runD1Sql(`
    INSERT INTO machines (id, brand, model, type_code, created_at, updated_at)
    VALUES (${esc(machineId)}, ${esc(machineHint.brand)}, ${esc(machineHint.model)}, ${esc(machineHint.typeCode)}, unixepoch(), unixepoch())
    ON CONFLICT (id) DO UPDATE SET
      brand = excluded.brand,
      model = excluded.model,
      type_code = excluded.type_code,
      updated_at = unixepoch();
  `);

  // 2. Machine variants
  console.log('2. Syncing machine variants...');
  const variantSet = new Set<string>();
  for (const page of pkg.pages) {
    for (const item of page.extracted.items) {
      for (const pn of item.partNumbers) {
        if (pn.variantQtys) {
          for (const vq of pn.variantQtys) {
            if (vq.variant?.trim()) variantSet.add(vq.variant.trim());
          }
        }
      }
    }
  }

  const existingVariants = queryD1Json(`SELECT id, name FROM machine_variants WHERE machine_id = '${machineId}' AND deleted_at IS NULL;`);
  const variantIdByName = new Map<string, string>();
  for (const ev of existingVariants) {
    variantIdByName.set(ev.name.toLowerCase().trim(), ev.id);
  }

  const missingVariants = [...variantSet].filter((v) => !variantIdByName.has(v.toLowerCase().trim()));
  if (missingVariants.length > 0) {
    const varSqls = missingVariants.map((v) => {
      const vId = crypto.randomUUID();
      variantIdByName.set(v.toLowerCase().trim(), vId);
      return `INSERT INTO machine_variants (id, machine_id, name, created_at, updated_at) VALUES (${esc(vId)}, ${esc(machineId)}, ${esc(v)}, unixepoch(), unixepoch());`;
    });
    runD1Sql(varSqls.join('\n'));
    console.log(`Created ${missingVariants.length} new variants:`, missingVariants);
  }

  // 3. Pre-fetch existing part numbers
  console.log('3. Checking canonical parts in remote D1...');
  const allNumbers = [...new Set(pkg.pages.flatMap((p) => p.extracted.items.flatMap((it) => it.partNumbers.map((pn) => pn.value.trim()))).filter(Boolean))];
  console.log(`Distinct part numbers in catalog: ${allNumbers.length}`);

  const partIdByNumber = new Map<string, string>();
  const partNumberIdByNumber = new Map<string, string>();
  const CHUNK_SIZE = 80;

  for (let i = 0; i < allNumbers.length; i += CHUNK_SIZE) {
    const chunk = allNumbers.slice(i, i + CHUNK_SIZE);
    const inList = chunk.map((n) => esc(n)).join(',');
    const rows = queryD1Json(`SELECT id, value, part_id FROM part_numbers WHERE value IN (${inList}) AND deleted_at IS NULL;`);
    for (const r of rows) {
      partIdByNumber.set(r.value, r.part_id);
      partNumberIdByNumber.set(r.value, r.id);
    }
  }
  console.log(`Found ${partIdByNumber.size} existing canonical parts in D1.`);

  // 4. Pre-fetch or create assemblies
  console.log('4. Syncing assemblies...');
  const existingAsms = queryD1Json(`SELECT id, code FROM assemblies WHERE machine_id = '${machineId}' AND deleted_at IS NULL;`);
  const asmIdByCode = new Map<string, string>();
  for (const ea of existingAsms) {
    asmIdByCode.set(ea.code, ea.id);
  }

  // Merge pages by assembly code
  const codeToPages = new Map<string, typeof pkg.pages>();
  for (const p of pkg.pages) {
    const code = p.extracted.assembly.code;
    const arr = codeToPages.get(code) ?? [];
    arr.push(p);
    codeToPages.set(code, arr);
  }

  // Soft-delete existing assembly items and dots for this machine before repopulating
  console.log('Clearing existing positions for clean replace...');
  runD1Sql(`
    UPDATE dots SET deleted_at = unixepoch() WHERE assembly_item_id IN (
      SELECT ai.id FROM assembly_items ai
      JOIN assemblies a ON a.id = ai.assembly_id
      WHERE a.machine_id = ${esc(machineId)}
    ) AND deleted_at IS NULL;
    UPDATE item_resolutions SET deleted_at = unixepoch() WHERE assembly_item_id IN (
      SELECT ai.id FROM assembly_items ai
      JOIN assemblies a ON a.id = ai.assembly_id
      WHERE a.machine_id = ${esc(machineId)}
    ) AND deleted_at IS NULL;
    UPDATE assembly_items SET deleted_at = unixepoch() WHERE assembly_id IN (
      SELECT a.id FROM assemblies a WHERE a.machine_id = ${esc(machineId)}
    ) AND deleted_at IS NULL;
  `);

  const asmInserts: string[] = [];
  const partInserts: string[] = [];
  const pnInserts: string[] = [];
  const itemInserts: string[] = [];
  const resInserts: string[] = [];
  const dotInserts: string[] = [];

  let sortOrder = 1;
  let totalDotsCount = 0;
  let totalItemsCount = 0;

  for (const [code, pages] of codeToPages.entries()) {
    let asmId = asmIdByCode.get(code);
    if (!asmId) {
      asmId = crypto.randomUUID();
      asmIdByCode.set(code, asmId);
    }

    const firstPage = pages[0];
    const groupType = firstPage.groupType || (code.startsWith('E') ? 'engine' : 'frame');
    const name = firstPage.extracted.assembly.name;
    const width = firstPage.width ?? null;
    const height = firstPage.height ?? null;

    asmInserts.push(`
      INSERT INTO assemblies (id, machine_id, group_type, code, name, image_ref, width, height, sort_order, created_at, updated_at)
      VALUES (${esc(asmId)}, ${esc(machineId)}, ${esc(groupType)}, ${esc(code)}, ${esc(name)}, ${esc(asmId)}, ${width ?? 'NULL'}, ${height ?? 'NULL'}, ${sortOrder++}, unixepoch(), unixepoch())
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name,
        group_type = excluded.group_type,
        image_ref = excluded.image_ref,
        width = excluded.width,
        height = excluded.height,
        sort_order = excluded.sort_order,
        deleted_at = NULL,
        updated_at = unixepoch();
    `);

    // Process all items across pages for this assembly
    const seenRefs = new Set<string>();
    for (const page of pages) {
      for (const it of page.extracted.items) {
        if (seenRefs.has(it.refNo)) continue;
        seenRefs.add(it.refNo);

        // Canonical Part
        let partId: string | null = null;
        for (const pn of it.partNumbers) {
          const found = partIdByNumber.get(pn.value);
          if (found) {
            partId = found;
            break;
          }
        }
        if (!partId) {
          partId = crypto.randomUUID();
          partInserts.push(`INSERT INTO parts (id, name_raw, created_at, updated_at) VALUES (${esc(partId)}, ${esc(it.description)}, unixepoch(), unixepoch());`);
        }

        // Assembly Item
        const itemId = crypto.randomUUID();
        itemInserts.push(`INSERT INTO assembly_items (id, assembly_id, ref_no, base_part_id, created_at, updated_at) VALUES (${esc(itemId)}, ${esc(asmId)}, ${esc(it.refNo)}, ${esc(partId)}, unixepoch(), unixepoch());`);
        totalItemsCount++;

        // Part numbers and resolutions
        let isPrimary = true;
        for (const pn of it.partNumbers) {
          let pnId = partNumberIdByNumber.get(pn.value);
          if (!pnId) {
            pnId = crypto.randomUUID();
            partNumberIdByNumber.set(pn.value, pnId);
            partIdByNumber.set(pn.value, partId);
            pnInserts.push(`INSERT INTO part_numbers (id, part_id, value, note, is_primary, created_at, updated_at) VALUES (${esc(pnId)}, ${esc(partId)}, ${esc(pn.value)}, ${esc(pn.note)}, ${isPrimary ? 1 : 0}, unixepoch(), unixepoch());`);
          }

          if (pn.variantQtys && pn.variantQtys.length > 0) {
            for (const vq of pn.variantQtys) {
              const varId = variantIdByName.get(vq.variant?.toLowerCase().trim()) ?? null;
              const resId = crypto.randomUUID();
              resInserts.push(`INSERT INTO item_resolutions (id, assembly_item_id, part_number_id, qty, variant_id, created_at, updated_at) VALUES (${esc(resId)}, ${esc(itemId)}, ${esc(pnId)}, ${vq.qty || 1}, ${esc(varId)}, unixepoch(), unixepoch());`);
            }
          } else {
            const resId = crypto.randomUUID();
            resInserts.push(`INSERT INTO item_resolutions (id, assembly_item_id, part_number_id, qty, variant_id, created_at, updated_at) VALUES (${esc(resId)}, ${esc(itemId)}, ${esc(pnId)}, ${it.qty || 1}, NULL, unixepoch(), unixepoch());`);
          }
          isPrimary = false;
        }

        // Dots
        if (Array.isArray(it.dots) && it.dots.length > 0) {
          for (const d of it.dots) {
            if (typeof d.x === 'number' && typeof d.y === 'number') {
              const dotId = crypto.randomUUID();
              dotInserts.push(`INSERT INTO dots (id, assembly_item_id, x, y, created_at, updated_at) VALUES (${esc(dotId)}, ${esc(itemId)}, ${d.x}, ${d.y}, unixepoch(), unixepoch());`);
              totalDotsCount++;
            }
          }
        }
      }
    }
  }

  // 5. Execute SQL in batches
  console.log(`\n5. Executing batch inserts to remote D1...`);
  console.log(`Assemblies: ${asmInserts.length}`);
  console.log(`Parts to create: ${partInserts.length}`);
  console.log(`Part numbers to create: ${pnInserts.length}`);
  console.log(`Assembly items: ${itemInserts.length}`);
  console.log(`Item resolutions: ${resInserts.length}`);
  console.log(`Dots to insert: ${dotInserts.length}`);

  const allSqls = [...asmInserts, ...partInserts, ...pnInserts, ...itemInserts, ...resInserts, ...dotInserts];
  const BATCH_SIZE = 250;
  for (let i = 0; i < allSqls.length; i += BATCH_SIZE) {
    const chunk = allSqls.slice(i, i + BATCH_SIZE);
    runD1Sql(chunk.join('\n'));
    process.stdout.write(`\rInserted SQL statements: ${Math.min(i + BATCH_SIZE, allSqls.length)} / ${allSqls.length}`);
  }
  console.log('\nAll D1 rows committed successfully!');

  // 6. Upload diagram images to Cloudflare R2 concurrently
  console.log('\n6. Uploading diagram images to Cloudflare R2 (concurrency: 6)...');
  const uploadTasks: { code: string; asmId: string; base64: string }[] = [];
  for (const [code, pages] of codeToPages.entries()) {
    const asmId = asmIdByCode.get(code);
    const pageWithImg = pages.find((p) => p.diagramCropBase64);
    if (asmId && pageWithImg?.diagramCropBase64) {
      uploadTasks.push({ code, asmId, base64: pageWithImg.diagramCropBase64 });
    }
  }

  const CONCURRENCY = 6;
  let running = 0;
  let index = 0;
  let imagesUploaded = 0;

  await new Promise<void>((resolve) => {
    function launch() {
      if (index >= uploadTasks.length && running === 0) {
        return resolve();
      }
      while (running < CONCURRENCY && index < uploadTasks.length) {
        const item = uploadTasks[index++];
        running++;
        const tmpPath = `/tmp/r2_img_${item.asmId}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
        fs.writeFileSync(tmpPath, Buffer.from(item.base64, 'base64'));

        exec(
          `npx wrangler r2 object put "wemo-assistant-catalog-images/assemblies/${item.asmId}" --file="${tmpPath}" --content-type="image/png" --remote`,
          { cwd: 'apps/backend' },
          (err) => {
            if (fs.existsSync(tmpPath)) {
              try { fs.unlinkSync(tmpPath); } catch {}
            }
            running--;
            if (err) {
              console.error(`\nFailed to upload image for ${item.code} (${item.asmId}):`, err.message);
            } else {
              imagesUploaded++;
              process.stdout.write(`\rUploaded images: ${imagesUploaded} / ${uploadTasks.length} (latest: ${item.code})`);
            }
            launch();
          }
        );
      }
    }
    launch();
  });

  console.log(`\n\n🎉 CATALOG COMMITTED SUCCESSFULLY!`);
  console.log(`Machine: ${machineHint.brand} ${machineHint.model} (${machineId})`);
  console.log(`Assemblies: ${codeToPages.size}`);
  console.log(`Items: ${totalItemsCount}`);
  console.log(`Dots: ${totalDotsCount}`);
  console.log(`Images: ${imagesUploaded}`);
}

export { commitBlob };

if (process.argv.slice(2).length >= 2) {
  const args = process.argv.slice(2);
  commitBlob(args[0], args[1]).catch((err) => {
    console.error('\nCommit failed:', err);
    process.exit(1);
  });
}

