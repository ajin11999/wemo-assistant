import fs from 'fs';
import * as pdfjs from '../node_modules/.bun/pdfjs-dist@6.1.200/node_modules/pdfjs-dist/legacy/build/pdf.mjs';

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error("Usage: bun run scripts/inspect-pdf.ts <pdf-path>");
  process.exit(1);
}

const data = new Uint8Array(fs.readFileSync(pdfPath));
const doc = await pdfjs.getDocument({ data }).promise;
console.log(`=== Inspecting ${pdfPath} (Total: ${doc.numPages} pages) ===`);

for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  const text = tc.items.map((i: any) => i.str).join(" ");
  const m = text.match(/\b([EF]-\d+(?:-\d+)?)\b/);
  if (m && !text.includes("DAFTAR ISI") && !text.includes("INDICE") && !text.includes("KELOMPOK") && !text.includes("GROUP")) {
    console.log(`p${p}: [${m[1]}] ${text.slice(0, 80)}...`);
  }
}
