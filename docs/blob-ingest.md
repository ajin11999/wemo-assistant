# Ingest blob (multi-PDF → single file, single machine)

A manufacturer often splits one machine's catalog across several PDFs
(engine volume, frame volume, color supplement). A subscription model
(Claude Pro / Google AI Pro, on your own machine) reads those PDFs and
compacts them into **one JSON blob file** for **one machine**. The blob is
uploaded in the deployed admin app (**Blob file** tab): select machine →
upload → pages stage in state (no writes) → preview matches → commit all.

The extraction box needs **no DB access and no tokens**. All part-identity
decisions (create vs reuse by number) happen server-side at commit time via
the existing `POST /ingest/commit` dedup. Dots are keyed by `refNo` and
resolved to positions after each page commits.

## Hard caps (enforced at upload)

- **50 pages** per blob (`BLOB_MAX_PAGES`). Larger catalog → split by group
  (one blob engine `E-*`, one blob frame `F-*`).
- **80 MB** file (`BLOB_MAX_BYTES`). Past this the browser tab risks OOM on
  the base64 crops.
- Oversize files are **rejected outright** — shrink/split, don't retry.

## What to feed the model

1. The catalog PDFs for ONE machine, in reading order
   (e.g. `PCX160-engine.pdf`, `PCX160-frame.pdf`).
2. This doc + the extraction spec below.

## Per-page procedure

For each page, in global order across all PDFs:

1. **Classify:** `skip` (front matter, index grids, standard-parts reference)
   | `assembly` (exploded diagram and/or parts table) | `color` (color index).
   Skip front-matter/index pages entirely — they don't go in the blob.
2. **Assembly pages — transcribe the parts table first.** One item per table
   row: `refNo` (verbatim, e.g. `"11)"` stays `"11)"`), `description`
   (verbatim, comma-inverted English), `qty`, every listed `partNumbers[]`
   (value verbatim + brand/note + `serialFrom`/`serialTo` from the No. Seri
   cell + `variantQtys` per non-empty per-variant Jumlah cell). Returning
   zero items while a parts table is visible is ALWAYS a mistake — including
   table-only continuation pages (no drawing, same assembly code in the
   header: still extract every row).
3. **Service/FRT table** → `serviceItems[]` if present.
4. **Diagram bbox** → `diagram {x,y,width,height}` normalized 0..1 (drawing +
   balloons only, excluding table/header/margins; `{0,0,1,1}` when the page
   has no drawing or the drawing fills the page).
5. **Balloon dots** → per item, `dots[]` in **FULL-PAGE coords** (0..1,
   top-left origin), one entry per balloon; empty array when unlocatable.
   Never convert to crop space — the importer does that via the bbox.
6. **Crop the diagram** per the bbox → PNG `diagramCropBase64` (+ `width` /
   `height`). Table-only continuation pages carry NO image (merge-only).
   Also embed a ~400px JPEG `thumbDataUrl` for the review grid.
7. **Color pages** → `colors[]` legend + one item per row (`partName`,
   `baseNumber`, `blockCode`, `refNo`, one variant per non-empty color cell).
8. **Assign `seq`** incrementally in processing order (0, 1, 2, …) — this is
   the commit order. The first diagram page of an assembly owns the R2 image;
   later pages merge rows/dots into it.

## Blob JSON shape (version 1)

```json
{
  "version": 1,
  "machineHint": { "brand": "Honda", "model": "PCX160", "typeCode": "WW160As" },
  "sources": ["PCX160-engine.pdf", "PCX160-frame.pdf"],
  "pages": [
    {
      "source": "PCX160-engine.pdf", "pageNo": 58, "seq": 0,
      "type": "assembly", "groupType": "engine",
      "extracted": {
        "assembly": { "code": "E-4", "name": "Cylinder Head" },
        "diagram": { "x": 0.05, "y": 0.12, "width": 0.9, "height": 0.5 },
        "items": [{ "refNo": "1", "description": "GASKET, CYLINDER HEAD",
          "qty": 1, "partNumbers": [{ "value": "12251-KVY-901" }],
          "dots": [{ "x": 0.2, "y": 0.3 }] }],
        "serviceItems": []
      },
      "diagramCropBase64": "<png b64, no data-url prefix>",
      "mediaType": "image/png", "width": 1200, "height": 800,
      "thumbDataUrl": "data:image/jpeg;base64,..."
    },
    { "source": "PCX160-frame.pdf", "pageNo": 3, "seq": 27,
      "type": "color",
      "extracted": { "colors": [], "items": [] } }
  ]
}
```

Field rules: identity of a page is `(source, pageNo)` — `pageNo` restarts per
PDF, `seq` is globally unique. `machineHint` is display-only (the admin's
machine selection at upload wins). `mediaType` defaults to `image/png`.
`groupType` is `engine` for `E-*` codes, `frame` for `F-*`.

## Self-check before writing the file

- [ ] Every non-skip page is present, `seq` dense from 0, no dup `(source,pageNo)` or `seq`.
- [ ] No page exceeds its source PDF's page count; `sources` lists every file used.
- [ ] Table-only pages have rows and no `diagramCropBase64`.
- [ ] All dots/bbox values are finite 0..1; dot counts look plausible vs the drawing.
- [ ] Part numbers transcribed verbatim (never "corrected"); no invented suffixes.
- [ ] File ≤ 80 MB and ≤ 50 pages, else split by group.

## Import (deployed app)

Blob file tab → file is parsed + validated client-side (bad files fail here,
before any write) → **Preview matches** badges each number as exists/new →
**Commit all** replays pages in `seq` order through the standard commit
endpoints (dedup/merge, variant get-or-create, image + dots). Per-page status
is shown; failures retry without re-committing clean pages.
