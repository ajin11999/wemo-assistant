export type ExtractedVariantQty = { variant: string; qty: number | null };

export type ExtractedPartNumber = {
  value: string;
  brand?: string | null;
  note?: string | null;
  serialFrom?: string | null;
  serialTo?: string | null;
  variantQtys?: ExtractedVariantQty[];
};

export type ExtractedItem = {
  refNo: string;
  description: string;
  qty?: number | null;
  partNumbers: ExtractedPartNumber[];
  dots?: { x: number; y: number }[];
};

export type ExtractedServiceItem = { refNo?: string | null; name: string; frtHours?: number | null };

export type DiagramBox = { x: number; y: number; width: number; height: number };

export type ExtractedPage = {
  assembly: { code: string; name: string; imageCode?: string | null };
  diagram?: DiagramBox | null;
  items: ExtractedItem[];
  serviceItems: ExtractedServiceItem[];
  variantColumns?: string[];
};

export type ExtractedColorPage = {
  colors: { code: string; name: string }[];
  items: {
    partName: string;
    baseNumber: string;
    blockCode?: string | null;
    refNo?: string | null;
    variants: { colorCode: string; suffix: string }[];
  }[];
};

export type Machine = { id: string; brand: string; model: string; typeCode?: string | null };

export type SearchResult = { partId: string; name: string; primaryNumber: string | null };

export type AiSettings = {
  chatProvider: string;
  chatModel: string;
  visionModel: string;
  visionModelEffective: string;
  anthropicKey: string;
  deepseekKey: string;
  activeChatProvider: 'anthropic' | 'deepseek' | 'stub' | null;
  visionConfigured: boolean;
};

export type MachineVariant = { id: string; name: string; note?: string | null };

export type CommitSummary = {
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

// --- Ingest blob (multi-PDF single-file package, single machine) ---
// Produced offline by a subscription model from one machine's catalog PDFs
// (see docs/blob-ingest.md) and staged in the admin UI before committing.
// Dots stay in FULL-PAGE coords (same convention as ExtractedItem.dots); the
// importer transforms them into crop space via `extracted.diagram`, exactly
// like ingest-helpers.autoMap. Identity of a page is (source, pageNo);
// `seq` is the global commit order across all source PDFs.

export const BLOB_VERSION = 1;

export type BlobMachineHint = { brand?: string | null; model?: string | null; typeCode?: string | null };

export type BlobAssemblyPage = {
  source: string;
  pageNo: number;
  seq: number;
  type: 'assembly';
  groupType: 'engine' | 'frame';
  extracted: ExtractedPage;
  // Cropped diagram image (what lands in R2). Omitted on table-only
  // continuation pages (merge-only, no diagram).
  diagramCropBase64?: string | null;
  mediaType?: string | null;
  width?: number | null;
  height?: number | null;
  thumbDataUrl?: string | null;
};

export type BlobColorPage = {
  source: string;
  pageNo: number;
  seq: number;
  type: 'color';
  extracted: ExtractedColorPage;
};

export type BlobPage = BlobAssemblyPage | BlobColorPage;

export type BlobPackage = {
  version: number;
  exportedAt?: number | null;
  sourcePdf?: string | null;
  machineHint?: BlobMachineHint | null;
  sources: string[];
  pages: BlobPage[];
};

export type PreviewEntry =
  | { value: string; found: true; partId: string; name: string | null; primaryNumber: string }
  | { value: string; found: false; partId: null; name: null; primaryNumber: null };

export type ColorCommitSummary = {
  colorsCreated: number;
  colorsReused: number;
  partsCreated: number;
  partsReused: number;
  variantsCreated: number;
  variantsSkipped: number;
};

// --- Dot mapping / browse ---

export type Assembly = {
  id: string;
  code: string;
  name: string;
  groupType: string;
  imageRef?: string | null;
  width?: number | null;
  height?: number | null;
};

export type EditorDot = { assemblyItemId: string; x: number; y: number };

export type Resolution = {
  id: string;
  partNumberId: string;
  partNumberValue: string | null;
  qty: number;
  variantId: string | null;
  variantName: string | null;
  serialFrom: string | null;
  serialTo: string | null;
};

export type FullItem = {
  id: string;
  refNo: string;
  description?: string | null;
  part: { nameRaw: string } | null;
  resolutions: Resolution[];
  dots: EditorDot[];
};

export type FullAssembly = { assembly: Assembly; items: FullItem[] };

export type Applicability = {
  number: string | null;
  qty: number;
  variantName: string | null;
  serialFrom: string | null;
  serialTo: string | null;
};

export type Placement = {
  assemblyItemId: string;
  refNo: string;
  assemblyId: string;
  assemblyCode: string;
  assemblyName: string;
  machineId: string;
  machine: string;
  applicability: Applicability[];
};

export type SubstituteLink = {
  partId: string;
  name: string;
  primaryNumber: string | null;
  note: string | null;
  isCurrent: boolean; // this substitute is the current replacement; the rest are obsolete
};

export type PartFull = {
  id: string;
  nameRaw: string;
  nameNormalized?: string | null;
  category?: string | null;
  notes?: string | null;
  isCurrentReplacement: boolean; // this part is the current replacement in its substitute cluster
  numbers: { value: string; kind: string; brand?: string | null; note?: string | null; isPrimary: boolean }[];
  colorVariants: { id: string; colorId: string; suffixCode?: string | null; fullNumber?: string | null }[];
  placements: Placement[];
  substitutes: SubstituteLink[];
};

// --- Admin correction assistant ---

export type NumberKind = 'oem' | 'alternative' | 'superseded' | 'aftermarket' | 'bulk';

export type CorrectionProposal =
  | { type: 'rename'; partId: string; nameNormalized?: string | null; category?: string | null; notes?: string | null }
  | { type: 'add_alias'; partId: string; term: string; lang?: string | null }
  | { type: 'add_number'; partId: string; value: string; kind?: NumberKind; brand?: string | null }
  | { type: 'edit_number'; partId: string; value: string; newValue?: string; kind?: NumberKind; brand?: string | null }
  | { type: 'merge'; sourcePartId: string; targetPartId: string }
  | { type: 'substitute'; partId: string; substitutePartId: string; note?: string | null };

export type Proposal = {
  id: string;
  proposal: CorrectionProposal;
  summary: string;
  partLabel: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

// --- CRM Types ---

export type MaintenanceRecordType = 'service' | 'purchase';

export type MaintenanceItemCategory =
  | 'bearing' | 'chain' | 'sprocket' | 'oil' | 'tire' | 'brake_pad' | 'battery' | 'spark_plug'
  | 'filter' | 'seal' | 'gasket' | 'engine_part' | 'body_part' | 'electrical' | 'other';

export type WarrantyPeriodUnit = 'days' | 'months';

export type Customer = {
  id: string;
  name: string;
  phone?: string | null;
  phoneAlt?: string | null;
  email?: string | null;
  address?: string | null;
  notes?: string | null;
  tag?: string | null;
  vehiclesCount?: number;
  recordsCount?: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
};

export type CustomerVehicle = {
  id: string;
  customerId: string;
  machineId: string;
  licensePlate?: string | null;
  frameNumber?: string | null;
  colorId?: string | null;
  year?: number | null;
  nickname?: string | null;
  notes?: string | null;
  recordsCount?: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
};

export type MaintenanceRecord = {
  id: string;
  customerVehicleId?: string | null;
  customerId: string;
  type: MaintenanceRecordType;
  date: number;
  description: string;
  technicianId?: string | null;
  clerkId?: string | null;
  invoiceNumber?: string | null;
  totalAmount?: number | null;
  notes?: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
};

export type MaintenanceItem = {
  id: string;
  maintenanceRecordId: string;
  category: MaintenanceItemCategory;
  partId?: string | null;
  partNumberId?: string | null;
  partNumber?: string | null;
  brand?: string | null;
  quantity: number;
  hasWarranty: boolean;
  warrantyPeriodValue?: number | null;
  warrantyPeriodUnit?: WarrantyPeriodUnit | null;
  warrantyStartDate?: number | null;
  warrantyExpiryDate?: number | null;
  warrantyNotes?: string | null;
  unitPrice?: number | null;
  notes?: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
};

export type BrandStats = {
  brand: string;
  count: number;
};

export type ExpiringWarrantyItem = MaintenanceItem & {
  daysUntilExpiry: number;
  expiryDate: string;
};

export type WarrantyExpiryResponse = {
  expiring: ExpiringWarrantyItem[];
  daysThreshold: number;
  count: number;
};

export type CustomerWithVehicles = Customer & {
  vehicles: CustomerVehicle[];
  records: MaintenanceRecord[];
};

export type VehicleWithCustomer = CustomerVehicle & {
  customer: Customer;
  machineBrand?: string;
  machineModel?: string;
  colorName?: string;
  records: MaintenanceRecord[];
};

export type RecordWithItems = MaintenanceRecord & {
  items: MaintenanceItem[];
  customer?: Customer;
  vehicle?: CustomerVehicle;
};

/** Flat joined type returned by GET /vehicles (list all) */
export type VehicleListRow = CustomerVehicle & {
  customerName: string;
  machineBrand: string;
  machineModel: string;
};
