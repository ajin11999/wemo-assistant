import { commitBlob } from './commit-catalog-blob';

const CATALOGS_TO_COMMIT = [
  {
    name: 'Honda Supra X 125 Karburator',
    file: 'apps/backend/backups/supra-x-125-karbu-blob.json',
    machineId: '96811071-5dd7-4a4c-b2d0-b124acd758d9',
  },
  {
    name: 'Honda Tiger Revo',
    file: 'apps/backend/backups/tiger-revo-blob.json',
    machineId: 'e796996f-857d-4542-80a1-050728b45fd6',
  },
  {
    name: 'Honda Mega Pro 160',
    file: 'apps/backend/backups/megapro-160-blob.json',
    machineId: 'fd052166-bff4-4c68-8fc3-cfa8e922c64b',
  },
  {
    name: 'Honda Revo 110 KWW',
    file: 'apps/backend/backups/revo-110-kww-blob.json',
    machineId: '641a47e1-1c27-4857-8c5e-24c6bbe819cf',
  },
  {
    name: 'Honda PCX 160 2024',
    file: 'apps/backend/backups/pcx-160-2024-blob.json',
    machineId: '33337d6f-221a-481f-bafc-c74662521bcb',
  },
  {
    name: 'Honda Vario 160',
    file: 'apps/backend/backups/vario-160-blob.json',
    machineId: 'df585db7-872e-49b9-89ae-bef1b26ad7cf',
  },
  {
    name: 'Honda ADV 160',
    file: 'apps/backend/backups/adv-160-blob.json',
    machineId: 'ad160000-0000-4000-8000-000000000160',
  },
];

async function main() {
  console.log(`====================================================`);
  console.log(`Starting Batch Commit for ${CATALOGS_TO_COMMIT.length} Remaining Catalogs`);
  console.log(`====================================================\n`);

  const results: { name: string; success: boolean; error?: string; durationSec: number }[] = [];

  for (let i = 0; i < CATALOGS_TO_COMMIT.length; i++) {
    const item = CATALOGS_TO_COMMIT[i];
    console.log(`\n>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
    console.log(`[${i + 1}/${CATALOGS_TO_COMMIT.length}] Committing: ${item.name}`);
    console.log(`Blob: ${item.file}`);
    console.log(`Machine ID: ${item.machineId}`);
    console.log(`>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>\n`);

    const start = Date.now();
    try {
      await commitBlob(item.file, item.machineId);
      const durationSec = Math.round((Date.now() - start) / 1000);
      results.push({ name: item.name, success: true, durationSec });
      console.log(`\n✅ ${item.name} completed successfully in ${durationSec}s`);
    } catch (err: any) {
      const durationSec = Math.round((Date.now() - start) / 1000);
      console.error(`\n❌ Failed to commit ${item.name}:`, err.message || err);
      results.push({ name: item.name, success: false, error: err.message || String(err), durationSec });
    }
  }

  console.log(`\n\n====================================================`);
  console.log(`BATCH COMMIT SUMMARY`);
  console.log(`====================================================`);
  for (const r of results) {
    console.log(`${r.success ? '✅ PASS' : '❌ FAIL'} | ${r.name} (${r.durationSec}s)${r.error ? ` - ${r.error}` : ''}`);
  }
}

main().catch((err) => {
  console.error('Fatal error in batch runner:', err);
  process.exit(1);
});
