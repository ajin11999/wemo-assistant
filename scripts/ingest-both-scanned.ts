import { extractScannedCatalog } from './extract-scanned-catalog';
import { commitBlob } from './commit-catalog-blob';

async function main() {
  console.log('======================================================');
  console.log('STARTING INGESTION & COMMIT OF 2 SCANNED HONDA CATALOGS');
  console.log('======================================================\n');

  // 1. All New PCX 150 (K97)
  const pcx150Blob = 'apps/backend/backups/pcx-150-k97-blob.json';
  const pcx150Desktop = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/pcx-150-k97-blob.json';
  const pcx150MachineId = 'pc150000-0000-4000-8000-000000000097';

  console.log('\n>>> STEP 1: EXTRACTING ALL NEW PCX 150 (K97) <<<');
  await extractScannedCatalog({
    pdfPath: '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/Katalog-Suku-Cadang-All-New-PCX-150-K97.pdf',
    sourceName: 'Katalog-Suku-Cadang-All-New-PCX-150-K97.pdf',
    blobOut: pcx150Blob,
    desktopOut: pcx150Desktop,
    machineHint: {
      brand: 'Honda',
      model: 'All New PCX 150',
      typeCode: 'K97',
    },
    startPage: 30,
    endPage: 98,
    cacheDirName: 'pcx150_k97',
  });

  console.log('\n>>> STEP 2: COMMITTING ALL NEW PCX 150 TO D1 & R2 <<<');
  await commitBlob(pcx150Blob, pcx150MachineId);

  // 2. New Vario 150 (K59J)
  const vario150Blob = 'apps/backend/backups/vario-150-k59j-blob.json';
  const vario150Desktop = '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/vario-150-k59j-blob.json';
  const vario150MachineId = 'va150000-0000-4000-8000-000000000590';

  console.log('\n>>> STEP 3: EXTRACTING NEW VARIO 150 (K59J) <<<');
  await extractScannedCatalog({
    pdfPath: '/mnt/c/Users/frans/OneDrive/Desktop/catalog honda/Katalog-Suku-Cadang-Honda-New-Vario-150-K59J.pdf',
    sourceName: 'Katalog-Suku-Cadang-Honda-New-Vario-150-K59J.pdf',
    blobOut: vario150Blob,
    desktopOut: vario150Desktop,
    machineHint: {
      brand: 'Honda',
      model: 'New Vario 150',
      typeCode: 'K59J',
    },
    startPage: 27,
    endPage: 88,
    cacheDirName: 'vario150_k59j',
  });

  console.log('\n>>> STEP 4: COMMITTING NEW VARIO 150 TO D1 & R2 <<<');
  await commitBlob(vario150Blob, vario150MachineId);

  console.log('\n\n======================================================');
  console.log('🎉 ALL 2 SCANNED CATALOGS INGESTED AND COMMITTED SUCCESSFULLY!');
  console.log('======================================================');
}

main().catch((err) => {
  console.error('\nFatal error during scanned catalog ingestion:', err);
  process.exit(1);
});
