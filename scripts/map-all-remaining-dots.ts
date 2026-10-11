import { mapCatalogDots } from './map-catalog-dots';

const CATALOGS_TO_MAP = [
  {
    name: 'Honda Tiger Revo',
    blobPath: 'apps/backend/backups/tiger-revo-blob.json',
    machineId: 'e796996f-857d-4542-80a1-050728b45fd6',
    force: false,
  },
  {
    name: 'Honda Revo 100',
    blobPath: 'apps/backend/backups/revo-100-blob.json',
    machineId: '92888649-7f09-4703-a11c-facb1bad69bd',
    force: false,
  },
  {
    name: 'Honda Revo 110 KWW',
    blobPath: 'apps/backend/backups/revo-110-kww-blob.json',
    machineId: '641a47e1-1c27-4857-8c5e-24c6bbe819cf',
    force: false,
  },
  {
    name: 'Honda Supra X 125 FI',
    blobPath: 'apps/backend/backups/supra-x-125-fi-blob.json',
    machineId: 'dc83e93e-a50c-4c25-b05f-90865e76e7f3',
    force: false,
  },
  {
    name: 'Honda All New PCX 150 K97',
    blobPath: 'apps/backend/backups/pcx-150-k97-blob.json',
    machineId: 'pc150000-0000-4000-8000-000000000097',
    force: false,
  },
  {
    name: 'Honda New Vario 150 K59J',
    blobPath: 'apps/backend/backups/vario-150-k59j-blob.json',
    machineId: 'va150000-0000-4000-8000-000000000590',
    force: false,
  },
  {
    name: 'Honda Supra X 125 Karburator',
    blobPath: 'apps/backend/backups/supra-x-125-karbu-blob.json',
    machineId: '96811071-5dd7-4a4c-b2d0-b124acd758d9',
    force: true, // re-map to get complete coverage beyond the 35 initial dots
  },
  {
    name: 'Honda ADV 160',
    blobPath: 'apps/backend/backups/adv-160-blob.json',
    machineId: 'ad160000-0000-4000-8000-000000000160',
    force: true, // re-map to get complete coverage beyond the 56 initial dots
  },
  {
    name: 'Honda Vario 160',
    blobPath: 'apps/backend/backups/vario-160-blob.json',
    machineId: 'df585db7-872e-49b9-89ae-bef1b26ad7cf',
    force: true, // re-map to get complete coverage beyond the 172 initial dots
  },
];

async function main() {
  console.log(`======================================================`);
  console.log(`BATCH DOT MAPPING FOR ${CATALOGS_TO_MAP.length} REMAINING CATALOGS`);
  console.log(`======================================================\n`);

  for (let i = 0; i < CATALOGS_TO_MAP.length; i++) {
    const c = CATALOGS_TO_MAP[i];
    console.log(`\n>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
    console.log(`[${i + 1}/${CATALOGS_TO_MAP.length}] STARTING: ${c.name}`);
    console.log(`>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>\n`);

    const start = Date.now();
    try {
      await mapCatalogDots(c.blobPath, c.machineId, { force: c.force });
      const dur = Math.round((Date.now() - start) / 1000);
      console.log(`\n✅ ${c.name} dot mapping finished in ${dur}s.`);
    } catch (err: any) {
      console.error(`\n❌ Failed to process ${c.name}:`, err.message || err);
    }
  }

  console.log(`\n\n======================================================`);
  console.log(`🎉 ALL REMAINING CATALOGS BATCH DOT MAPPING COMPLETED!`);
  console.log(`======================================================`);
}

main().catch((err) => {
  console.error('Fatal batch runner error:', err);
  process.exit(1);
});
