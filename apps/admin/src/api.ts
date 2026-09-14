import type {
  AiSettings,
  Assembly,
  BrandStats,
  ChatMessage,
  ColorCommitSummary,
  CommitSummary,
  CorrectionProposal,
  Customer,
  CustomerVehicle,
  EditorDot,
  ExtractedColorPage,
  ExtractedPage,
  FullAssembly,
  MaintenanceItem,
  MaintenanceRecord,
  Machine,
  MachineVariant,
  PartFull,
  PreviewEntry,
  Proposal,
  SearchResult,
  WarrantyExpiryResponse,
} from './types';

const BASE = '/api';

export function getToken(): string {
  return localStorage.getItem('adminToken') ?? '';
}
export function setToken(t: string): void {
  localStorage.setItem('adminToken', t);
}

type ReqOpts = { method?: string; admin?: boolean; body?: unknown };

async function req<T>(path: string, opts: ReqOpts = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.admin) headers['Authorization'] = `Bearer ${getToken()}`;
  const res = await fetch(BASE + path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? res.statusText);
  return data as T;
}

export const imageUrl = (assemblyId: string) => `${BASE}/assemblies/${assemblyId}/image`;

export const api = {
  listMachines: () => req<Machine[]>('/machines'),
  createMachine: (m: { brand: string; model: string }) =>
    req<Machine>('/machines', { method: 'POST', admin: true, body: m }),
  updateMachine: (id: string, patch: { brand?: string; model?: string }) =>
    req<Machine>(`/machines/${encodeURIComponent(id)}`, { method: 'PATCH', admin: true, body: patch }),
  deleteMachine: (id: string) =>
    req<{ ok: boolean }>(`/machines/${encodeURIComponent(id)}`, { method: 'DELETE', admin: true }),
  ingestPage: (imageBase64: string, mediaType: string, mapDots = true) =>
    req<{ extracted: ExtractedPage }>('/ingest/page', {
      method: 'POST',
      admin: true,
      body: { imageBase64, mediaType, mapDots },
    }),
  commitPage: (machineId: string, groupType: string, extracted: ExtractedPage) =>
    req<{ ok: boolean; summary: CommitSummary }>('/ingest/commit', {
      method: 'POST',
      admin: true,
      body: { machineId, groupType, extracted },
    }),
  previewNumbers: (numbers: string[]) =>
    req<{ results: PreviewEntry[] }>('/ingest/preview', {
      method: 'POST',
      admin: true,
      body: { numbers },
    }),
  ingestColorPage: (imageBase64: string, mediaType: string) =>
    req<{ extracted: ExtractedColorPage }>('/ingest/color-page', {
      method: 'POST',
      admin: true,
      body: { imageBase64, mediaType },
    }),
  colorCommit: (machineId: string, extracted: ExtractedColorPage) =>
    req<{ ok: boolean; summary: ColorCommitSummary }>('/ingest/color-commit', {
      method: 'POST',
      admin: true,
      body: { machineId, extracted },
    }),
  listAssemblies: (machineId: string) =>
    req<Assembly[]>(`/assemblies?machineId=${encodeURIComponent(machineId)}`),
  listVariants: (machineId: string) =>
    req<MachineVariant[]>(`/machines/${encodeURIComponent(machineId)}/variants`),
  getAssemblyFull: (id: string, filter?: { variantId?: string; serial?: string }) => {
    const params = new URLSearchParams();
    if (filter?.variantId) params.set('variantId', filter.variantId);
    if (filter?.serial) params.set('serial', filter.serial);
    const qs = params.toString();
    return req<FullAssembly>(`/assemblies/${id}/full${qs ? `?${qs}` : ''}`);
  },
  uploadAssemblyImage: (id: string, imageBase64: string, mediaType: string, width: number, height: number) =>
    req<{ ok: boolean; imageRef: string }>(`/assemblies/${id}/image`, {
      method: 'POST',
      admin: true,
      body: { imageBase64, mediaType, width, height },
    }),
  saveDots: (id: string, dots: EditorDot[]) =>
    req<{ ok: boolean; count: number }>(`/assemblies/${id}/dots`, {
      method: 'PUT',
      admin: true,
      body: { dots },
    }),
  lookupPart: (number: string) => req<PartFull>(`/parts?number=${encodeURIComponent(number)}`),
  createPart: (part: { nameRaw: string; nameNormalized?: string; category?: string; partNumber: string; brand?: string }) =>
    req<{ ok: boolean; partId: string }>('/parts', { method: 'POST', admin: true, body: part }),
  searchParts: (q: string) => req<{ results: SearchResult[] }>(`/parts/search?q=${encodeURIComponent(q)}`),
  getPart: (id: string) => req<PartFull>(`/parts/${encodeURIComponent(id)}`),
  addSubstitute: (partId: string, substitutePartId: string, note?: string) =>
    req<{ ok: boolean }>(`/parts/${encodeURIComponent(partId)}/substitutes`, {
      method: 'POST',
      admin: true,
      body: { substitutePartId, note },
    }),
  removeSubstitute: (partId: string, otherId: string) =>
    req<{ ok: boolean }>(`/parts/${encodeURIComponent(partId)}/substitutes/${encodeURIComponent(otherId)}`, {
      method: 'DELETE',
      admin: true,
    }),
  markCurrent: (partId: string) =>
    req<{ ok: boolean }>(`/parts/${encodeURIComponent(partId)}/substitutes/current`, {
      method: 'POST',
      admin: true,
    }),
  unmarkCurrent: (partId: string) =>
    req<{ ok: boolean }>(`/parts/${encodeURIComponent(partId)}/substitutes/current`, {
      method: 'DELETE',
      admin: true,
    }),
  adminChat: (messages: ChatMessage[]) =>
    req<{ reply: string; proposals: Proposal[] }>('/admin/chat', { method: 'POST', admin: true, body: { messages } }),
  applyCorrection: (proposal: CorrectionProposal) =>
    req<{ ok: boolean; summary: string }>('/admin/corrections/apply', { method: 'POST', admin: true, body: { proposal } }),
  checkAuth: () => req<{ ok: boolean }>('/auth/check', { admin: true }),
  getAiSettings: () => req<AiSettings>('/settings/ai', { admin: true }),
  saveAiSettings: (
    s: Partial<Pick<AiSettings, 'chatProvider' | 'chatModel' | 'visionModel' | 'anthropicKey' | 'deepseekKey'>>,
  ) =>
    req<AiSettings>('/settings/ai', { method: 'PUT', admin: true, body: s }),

  // CRM API methods
  listCustomers: () => req<Customer[]>('/customers', { admin: true }),
  getCustomer: (id: string) => req<Customer>(`/customers/${encodeURIComponent(id)}`, { admin: true }),
  createCustomer: (customer: Omit<Customer, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>) =>
    req<Customer>('/customers', { method: 'POST', admin: true, body: customer }),
  updateCustomer: (id: string, customer: Partial<Customer>) =>
    req<Customer>(`/customers/${encodeURIComponent(id)}`, { method: 'PUT', admin: true, body: customer }),
  deleteCustomer: (id: string) =>
    req<{ ok: boolean }>(`/customers/${encodeURIComponent(id)}`, { method: 'DELETE', admin: true }),
  getCustomerVehicles: (customerId: string) =>
    req<CustomerVehicle[]>(`/customers/${encodeURIComponent(customerId)}/vehicles`, { admin: true }),
  getCustomerRecords: (customerId: string) =>
    req<MaintenanceRecord[]>(`/customers/${encodeURIComponent(customerId)}/records`, { admin: true }),
  createCustomerVehicle: (customerId: string, vehicle: Omit<CustomerVehicle, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'customerId'>) =>
    req<CustomerVehicle>(`/customers/${encodeURIComponent(customerId)}/vehicles`, { method: 'POST', admin: true, body: vehicle }),

  listVehicles: (search?: string) => {
    const qs = search ? `?search=${encodeURIComponent(search)}` : '';
    return req<(CustomerVehicle & { customerName: string; machineBrand: string; machineModel: string })[]>(`/vehicles${qs}`, { admin: true });
  },
  getVehicle: (id: string) => req<CustomerVehicle>(`/vehicles/${encodeURIComponent(id)}`, { admin: true }),
  updateVehicle: (id: string, vehicle: Partial<CustomerVehicle>) =>
    req<CustomerVehicle>(`/vehicles/${encodeURIComponent(id)}`, { method: 'PUT', admin: true, body: vehicle }),
  deleteVehicle: (id: string) =>
    req<{ ok: boolean }>(`/vehicles/${encodeURIComponent(id)}`, { method: 'DELETE', admin: true }),
  getVehicleRecords: (vehicleId: string) =>
    req<MaintenanceRecord[]>(`/vehicles/${encodeURIComponent(vehicleId)}/records`, { admin: true }),

  listRecords: (params?: { customerId?: string; vehicleId?: string; type?: string }) => {
    const qs = new URLSearchParams();
    if (params?.customerId) qs.set('customerId', params.customerId);
    if (params?.vehicleId) qs.set('vehicleId', params.vehicleId);
    if (params?.type) qs.set('type', params.type);
    const queryString = qs.toString();
    return req<MaintenanceRecord[]>(`/records${queryString ? `?${queryString}` : ''}`, { admin: true });
  },
  getRecord: (id: string) => req<MaintenanceRecord>(`/records/${encodeURIComponent(id)}`, { admin: true }),
  createRecord: (record: Omit<MaintenanceRecord, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>) =>
    req<MaintenanceRecord>('/records', { method: 'POST', admin: true, body: record }),
  updateRecord: (id: string, record: Partial<MaintenanceRecord>) =>
    req<MaintenanceRecord>(`/records/${encodeURIComponent(id)}`, { method: 'PUT', admin: true, body: record }),
  deleteRecord: (id: string) =>
    req<{ ok: boolean }>(`/records/${encodeURIComponent(id)}`, { method: 'DELETE', admin: true }),
  getRecordItems: (recordId: string) =>
    req<MaintenanceItem[]>(`/records/${encodeURIComponent(recordId)}/items`, { admin: true }),

  getItem: (id: string) => req<MaintenanceItem>(`/record-items/${encodeURIComponent(id)}`, { admin: true }),
  createItem: (recordId: string, item: Omit<MaintenanceItem, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'maintenanceRecordId'>) =>
    req<MaintenanceItem>(`/record-items/${encodeURIComponent(recordId)}/items`, { method: 'POST', admin: true, body: item }),
  updateItem: (id: string, item: Partial<MaintenanceItem>) =>
    req<MaintenanceItem>(`/record-items/${encodeURIComponent(id)}`, { method: 'PUT', admin: true, body: item }),
  deleteItem: (id: string) =>
    req<{ ok: boolean }>(`/record-items/${encodeURIComponent(id)}`, { method: 'DELETE', admin: true }),

  getBrandStats: (limit?: number) =>
    req<{ brands: BrandStats[] }>(`/stats/records/brands${limit ? `?limit=${limit}` : ''}`, { admin: true }),
  getExpiringWarranties: (days?: number, limit?: number) => {
    const qs = new URLSearchParams();
    if (days) qs.set('days', String(days));
    if (limit) qs.set('limit', String(limit));
    const queryString = qs.toString();
    return req<WarrantyExpiryResponse>(`/stats/warranty/expiring${queryString ? `?${queryString}` : ''}`, { admin: true });
  },
};
