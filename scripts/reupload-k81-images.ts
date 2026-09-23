import fs from 'fs';
import { execSync } from 'child_process';

const BLOB_PATH = 'apps/backend/backups/beat-k81-blob.json';
const MACHINE_ID = 'be081000-0000-4000-8000-000000000081';

console.log('Fetching assemblies for K81 from D1...');
const out = execSync(`npx wrangler d1 execute wemo-assistant --remote --json --command "SELECT id, code FROM assemblies WHERE machine_id = '${MACHINE_ID}'"`, {
  cwd: 'apps/backend',
}).toString();
const assemblies = JSON.parse(out)[0]?.results ?? [];
console.log(`Found ${assemblies.length} assemblies in D1.`);

const idByCode = new Map(assemblies.map((a: any) => [a.code, a.id]));

const blob = JSON.parse(fs.readFileSync(BLOB_PATH, 'utf8'));

let uploaded = 0;
for (const p of blob.pages) {
  const code = p.extracted.assembly.code;
  const asmId = idByCode.get(code);
  if (!asmId || !p.diagramCropBase64) continue;

  const tmpPath = `/tmp/k81_${asmId}.png`;
  fs.writeFileSync(tmpPath, Buffer.from(p.diagramCropBase64, 'base64'));

  try {
    execSync(`npx wrangler r2 object put "wemo-assistant-catalog-images/assemblies/${asmId}" --file="${tmpPath}" --content-type="image/png" --remote`, {
      cwd: 'apps/backend',
      stdio: 'pipe',
    });
    uploaded++;
    process.stdout.write(`\rUploaded ${uploaded}/${assemblies.length}: ${code}`);
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

console.log(`\nAll ${uploaded} diagram images updated in Cloudflare R2 with corrected white background!`);
