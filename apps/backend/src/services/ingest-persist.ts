import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  assemblies,
  assemblyItems,
  dots,
  itemResolutions,
  machineVariants,
  partNumbers,
  parts,
  serviceItems,
} from '../db/schema';
import type { ExtractedPage } from '../ai/types';

export type PersistInput = {
  machineId: string;
  groupType: 'engine' | 'frame';
  extracted: ExtractedPage;
};

export type PersistSummary = {
  assemblyId: string;
  itemsCreated: number;
  partsCreated: number;
  partsReused: number;
  numbersCreated: number;
  serviceItemsCreated: number;
  resolutionsCreated: number;
  machineVariantsCreated: number;
  assembliesReplaced: number;
};

/**
 * Persists a reviewed extraction into the catalog tables.
 *
 * Merge policy: parts are canonical and deduped by part number. If any of an item's
 * numbers already exists, that number's part is reused (interchange merge); otherwise a
 * new part is created. When an item lists several numbers that map to different existing
 * parts, the first match wins — full human-mediated merge is an admin-UI concern (later).
 *
 * Multi-page assemblies: the exploded diagram is on page 1 and its parts table often
 * continues onto later catalog pages that repeat the same (code, name). So a page is
 * MERGED into the existing assembly with that (machineId, code) rather than replacing it:
 * the assembly is get-or-created, and each position is upserted by ref number. Re-committing
 * a page therefore refreshes only the ref numbers that page carries; ref numbers contributed
 * by other pages of the same assembly are left intact (deletions propagate via /sync).
 *
 * Note: D1 has no interactive transactions in the Drizzle session, so inserts run
 * sequentially (not atomic). Acceptable for the review-then-commit flow; batch later.
 */
export async function persistExtractedPage(db: Db, input: PersistInput): Promise<PersistSummary> {
  const { machineId, groupType, extracted } = input;
  const summary: PersistSummary = {
    assemblyId: '',
    itemsCreated: 0,
    partsCreated: 0,
    partsReused: 0,
    numbersCreated: 0,
    serviceItemsCreated: 0,
    resolutionsCreated: 0,
    machineVariantsCreated: 0,
    assembliesReplaced: 0,
  };

  // Machine variants referenced by per-variant quantities, get-or-created by name
  // (case-insensitive) so STD/ABS exist exactly once per machine across pages.
  const liveVariants = await db
    .select({ id: machineVariants.id, name: machineVariants.name })
    .from(machineVariants)
    .where(and(eq(machineVariants.machineId, machineId), isNull(machineVariants.deletedAt)));
  const variantIdByName = new Map(liveVariants.map((v) => [v.name.trim().toLowerCase(), v.id]));

  async function variantIdFor(name: string): Promise<string> {
    const key = name.trim().toLowerCase();
    const found = variantIdByName.get(key);
    if (found) return found;
    const [created] = await db.insert(machineVariants).values({ machineId, name: name.trim() }).returning();
    variantIdByName.set(key, created.id);
    summary.machineVariantsCreated++;
    return created.id;
  }

  // Get-or-create the assembly by (machineId, code) so continuation pages merge in. Keep the
  // page-1 diagram: only overwrite imageCode when this page actually carries one.
  const existingAssembly = await db
    .select()
    .from(assemblies)
    .where(
      and(
        eq(assemblies.machineId, machineId),
        eq(assemblies.code, extracted.assembly.code),
        isNull(assemblies.deletedAt),
      ),
    )
    .get();

  let assembly: typeof assemblies.$inferSelect;
  if (existingAssembly) {
    await db
      .update(assemblies)
      .set({
        name: extracted.assembly.name,
        imageCode: extracted.assembly.imageCode ?? existingAssembly.imageCode,
        updatedAt: new Date(),
      })
      .where(eq(assemblies.id, existingAssembly.id));
    assembly = existingAssembly;
    summary.assembliesReplaced = 1;
  } else {
    const [created] = await db
      .insert(assemblies)
      .values({
        machineId,
        groupType,
        code: extracted.assembly.code,
        name: extracted.assembly.name,
        imageCode: extracted.assembly.imageCode ?? null,
      })
      .returning();
    assembly = created;
  }
  summary.assemblyId = assembly.id;

  // Upsert positions by ref number: drop any live item(s) with a ref this page carries
  // (+ their resolutions/dots) so re-committing a page refreshes those positions, while ref
  // numbers from other pages of the same multi-page assembly stay put.
  await softDeleteItemsByRefs(db, assembly.id, extracted.items.map((it) => it.refNo));

  // Pre-fetch all existing numbers for this page in a single query to eliminate N+1 SELECTs.
  const allPageNumbers = [...new Set(extracted.items.flatMap((it) => it.partNumbers.map((pn) => pn.value.trim())).filter(Boolean))];
  const numberRowByValue = new Map<string, typeof partNumbers.$inferSelect>();
  const CHUNK_SIZE = 80;
  for (let i = 0; i < allPageNumbers.length; i += CHUNK_SIZE) {
    const chunk = allPageNumbers.slice(i, i + CHUNK_SIZE);
    const rows = await db
      .select()
      .from(partNumbers)
      .where(and(inArray(partNumbers.value, chunk), isNull(partNumbers.deletedAt)));
    for (const r of rows) numberRowByValue.set(r.value, r);
  }

  for (const item of extracted.items) {
    // Resolve the canonical part: reuse an existing part if any number already exists.
    let partId: string | null = null;
    for (const pn of item.partNumbers) {
      const existing = numberRowByValue.get(pn.value);
      if (existing) {
        partId = existing.partId;
        break;
      }
    }
    if (partId) {
      summary.partsReused++;
    } else {
      const [created] = await db.insert(parts).values({ nameRaw: item.description }).returning();
      partId = created.id;
      summary.partsCreated++;
    }

    const [assemblyItem] = await db
      .insert(assemblyItems)
      .values({ assemblyId: assembly.id, refNo: item.refNo, basePartId: partId })
      .returning();
    summary.itemsCreated++;

    // Ensure each number exists (attach new ones to the canonical part), then link it
    // to this position via item_resolutions with the quantity.
    let isFirst = true;
    for (const pn of item.partNumbers) {
      let numberRow = numberRowByValue.get(pn.value);
      if (!numberRow) {
        const [inserted] = await db
          .insert(partNumbers)
          .values({
            partId,
            value: pn.value,
            brand: pn.brand ?? null,
            note: pn.note ?? null,
            isPrimary: isFirst,
          })
          .returning();
        numberRow = inserted;
        numberRowByValue.set(pn.value, inserted);
        summary.numbersCreated++;
      }
      // One resolution row per applicable variant (per-variant Jumlah cells), or a single
      // variant-less row (= applies to all variants) when the page has one QTY column.
      // A number absent from a variant's column gets no row for that variant.
      const variantQtys = pn.variantQtys?.filter((vq) => vq.variant.trim()) ?? [];
      if (variantQtys.length > 0) {
        for (const vq of variantQtys) {
          await db.insert(itemResolutions).values({
            assemblyItemId: assemblyItem.id,
            partNumberId: numberRow.id,
            qty: vq.qty ?? item.qty ?? 1,
            variantId: await variantIdFor(vq.variant),
            serialFrom: pn.serialFrom ?? null,
            serialTo: pn.serialTo ?? null,
          });
          summary.resolutionsCreated++;
        }
      } else {
        await db.insert(itemResolutions).values({
          assemblyItemId: assemblyItem.id,
          partNumberId: numberRow.id,
          qty: item.qty ?? 1,
          serialFrom: pn.serialFrom ?? null,
          serialTo: pn.serialTo ?? null,
        });
        summary.resolutionsCreated++;
      }
      isFirst = false;
    }
  }

  // The FRT/service table lives on the diagram page. Treat an incoming table as
  // authoritative (replace this assembly's live service items) but leave them untouched
  // when a page has none, so a table-only continuation page can't wipe page 1's FRT.
  if (extracted.serviceItems.length > 0) {
    await db
      .update(serviceItems)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(serviceItems.assemblyId, assembly.id), isNull(serviceItems.deletedAt)));
    for (const svc of extracted.serviceItems) {
      await db.insert(serviceItems).values({
        assemblyId: assembly.id,
        refNo: svc.refNo ?? null,
        name: svc.name,
        frtHours: svc.frtHours ?? null,
      });
      summary.serviceItemsCreated++;
    }
  }

  return summary;
}

/**
 * Soft-deletes the live positions on an assembly whose ref number is in `refNos`, plus their
 * resolutions and dots. Used to upsert a page's positions without disturbing ref numbers that
 * belong to other pages of the same multi-page assembly. Parts/part_numbers are canonical and
 * shared — never deleted here.
 */
async function softDeleteItemsByRefs(db: Db, assemblyId: string, refNos: string[]): Promise<void> {
  const uniqueRefs = [...new Set(refNos)];
  if (uniqueRefs.length === 0) return;
  const items = await db
    .select({ id: assemblyItems.id })
    .from(assemblyItems)
    .where(
      and(
        eq(assemblyItems.assemblyId, assemblyId),
        inArray(assemblyItems.refNo, uniqueRefs),
        isNull(assemblyItems.deletedAt),
      ),
    );
  if (items.length === 0) return;
  const itemIds = items.map((i) => i.id);

  const tombstone = { deletedAt: new Date(), updatedAt: new Date() };
  await db.update(itemResolutions).set(tombstone)
    .where(and(inArray(itemResolutions.assemblyItemId, itemIds), isNull(itemResolutions.deletedAt)));
  await db.update(dots).set(tombstone)
    .where(and(inArray(dots.assemblyItemId, itemIds), isNull(dots.deletedAt)));
  await db.update(assemblyItems).set(tombstone).where(inArray(assemblyItems.id, itemIds));
}
