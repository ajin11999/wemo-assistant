import fs from 'fs';
import { execSync } from 'child_process';

const blob = JSON.parse(fs.readFileSync('apps/backend/backups/beat-pgmfi-blob.json', 'utf8'));
const asmMap = [
  { code: 'F-35', id: '7b590410-51c7-418d-98b4-a8381f9ea013' },
  { code: 'F-36', id: '3cdbd077-022b-4d05-8cd0-8bcba43b048f' },
  { code: 'F-37-10', id: '921379c1-dc1f-41a4-96ed-1dab2f4a6f64' },
  { code: 'F-38-10', id: 'd1eadfa6-2baf-4611-a515-058be0b3018d' },
  { code: 'F-39', id: '3ed586b6-19c1-4e41-beb6-0351a1640d34' },
  { code: 'F-40', id: '24013ff6-f214-4044-867b-67c50f047b13' },
  { code: 'F-41', id: 'a274fb4c-ea55-4e41-b769-8d95797837c8' },
  { code: 'F-42', id: '07b21376-0408-42cf-b505-71c63dde3cf2' },
  { code: 'F-46', id: 'bed625fc-0804-499d-8f23-20ee47d92be9' },
];

for (const item of asmMap) {
  const page = blob.pages.find((p: any) => p.extracted?.assembly?.code === item.code);
  if (!page || !page.diagramCropBase64) {
    console.warn(`No crop found for ${item.code}`);
    continue;
  }
  const tmpPath = `/tmp/beat_fi_${item.code}.png`;
  fs.writeFileSync(tmpPath, Buffer.from(page.diagramCropBase64, 'base64'));
  console.log(`Uploading ${item.code} (${item.id})...`);
  execSync(`npx wrangler r2 object put "wemo-assistant-catalog-images/assemblies/${item.id}" --file="${tmpPath}" --content-type="image/png" --remote`, {
    cwd: 'apps/backend',
    stdio: 'inherit'
  });
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

  const w = page.width ?? 'NULL';
  const h = page.height ?? 'NULL';
  const sql = `UPDATE assemblies SET image_ref = id, width = ${w}, height = ${h}, updated_at = unixepoch() WHERE id = '${item.id}';`;
  execSync(`bunx wrangler d1 execute wemo-assistant --remote --command "${sql.replace(/"/g, '\\"')}"`, {
    cwd: 'apps/backend',
    stdio: 'inherit'
  });
  console.log(`Updated D1 for ${item.code}`);
}

console.log('All 9 Beat FI K25 images uploaded and updated in D1!');
