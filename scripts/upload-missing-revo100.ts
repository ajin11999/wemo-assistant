import fs from 'fs';
import { execSync } from 'child_process';

const blob = JSON.parse(fs.readFileSync('apps/backend/backups/revo-100-blob.json', 'utf8'));
const asmMap = [
  { code: 'E-1', id: '226936a6-e415-44d1-ac15-93ccc699122d' },
  { code: 'E-2', id: '03286a0c-d9f2-4dab-9dfc-5d06e1fa59a9' },
  { code: 'E-3', id: 'ae568a2a-625b-4951-8e62-386b73d107d4' },
  { code: 'E-4', id: '48755809-4ca0-4e90-8ef3-a52ca6d9c572' },
  { code: 'E-5', id: '8e09b879-bb6a-4e19-8d0b-d5d73a4c2bd7' },
  { code: 'E-6', id: '99840701-e727-43df-930a-c3f08a94bedb' },
  { code: 'E-7', id: '196c1e92-396a-4d49-b652-dcab8a3fdf04' },
  { code: 'E-8', id: '748d3ed0-2735-40a7-8b14-10aea5f6ae59' },
  { code: 'E-9', id: '1addbe87-4e78-436d-b230-a269fb09c572' },
];

for (const item of asmMap) {
  const page = blob.pages.find((p: any) => p.extracted?.assembly?.code === item.code);
  if (!page || !page.diagramCropBase64) continue;
  const tmpPath = `/tmp/revo100_${item.code}.png`;
  fs.writeFileSync(tmpPath, Buffer.from(page.diagramCropBase64, 'base64'));
  console.log(`Uploading ${item.code} (${item.id})...`);
  execSync(`npx wrangler r2 object put "wemo-assistant-catalog-images/assemblies/${item.id}" --file="${tmpPath}" --content-type="image/png" --remote`, {
    cwd: 'apps/backend',
    stdio: 'inherit'
  });
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
}

const ids = asmMap.map(a => `'${a.id}'`).join(', ');
const sql = `UPDATE assemblies SET image_ref = id, updated_at = unixepoch() WHERE id IN (${ids});`;
fs.writeFileSync('/tmp/update_revo100.sql', sql);
execSync(`bunx wrangler d1 execute wemo-assistant --remote --file="/tmp/update_revo100.sql"`, {
  cwd: 'apps/backend',
  stdio: 'inherit'
});
if (fs.existsSync('/tmp/update_revo100.sql')) fs.unlinkSync('/tmp/update_revo100.sql');
console.log('All 9 Revo 100 images uploaded and updated in D1!');
