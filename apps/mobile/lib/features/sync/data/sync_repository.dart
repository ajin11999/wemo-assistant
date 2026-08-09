import 'dart:convert';

import 'package:drift/drift.dart';

import '../../../core/db/app_database.dart';

/// Applies sync pages to the local replica and owns the sync cursor.
///
/// Per row: `deletedAt != null` -> delete the local row (soft-delete
/// propagation); otherwise upsert. Each page is applied in one transaction and
/// is idempotent, so a retried page is harmless.
class SyncRepository {
  SyncRepository(this.db);

  final AppDatabase db;

  // --- Cursor / bookkeeping -------------------------------------------------

  Future<String> currentCursor() async {
    final row = await (db.select(db.syncStates)..where((t) => t.id.equals(1))).getSingleOrNull();
    return row?.cursor ?? '0';
  }

  Future<DateTime?> lastSyncedAt() async {
    final row = await (db.select(db.syncStates)..where((t) => t.id.equals(1))).getSingleOrNull();
    return row?.lastSyncedAt;
  }

  Future<void> saveCursor(String cursor) async {
    await db
        .into(db.syncStates)
        .insertOnConflictUpdate(SyncStatesCompanion.insert(id: const Value(1), cursor: Value(cursor)));
  }

  Future<void> markSynced(DateTime when) async {
    await db.into(db.syncStates).insertOnConflictUpdate(
      SyncStatesCompanion.insert(id: const Value(1), lastSyncedAt: Value(when)),
    );
  }

  /// Reset to a full sync (recovery / "force full sync").
  Future<void> resetCursor() => saveCursor('0');

  /// Wipe the mirrored catalog so a full sync rebuilds it from scratch,
  /// discarding any orphan rows the delta feed can no longer tombstone.
  Future<void> clearCatalog() => db.clearCatalog();

  // --- Apply a page ---------------------------------------------------------

  static const _canonicalOrder = [
    'machines',
    'parts',
    'customers',
    'machineVariants',
    'colors',
    'assemblies',
    'partNumbers',
    'aliases',
    'partSubstitutes',
    'partColorVariants',
    'assemblyItems',
    'assemblyLinks',
    'serviceItems',
    'customerVehicles',
    'itemResolutions',
    'dots',
    'maintenanceRecords',
    'maintenanceItems',
  ];

  Future<void> applyPage(Map<String, List<Map<String, dynamic>>> tables) async {
    await db.transaction(() async {
      final tableNamesInPage = tables.keys.toList();
      final orderedNames = <String>[
        ..._canonicalOrder.where((name) => tableNamesInPage.contains(name)),
        ...tableNamesInPage.where((name) => !_canonicalOrder.contains(name)),
      ];

      // Phase 1: Deletes in reverse order (children before parents)
      for (final name in orderedNames.reversed) {
        final rows = tables[name];
        if (rows != null && rows.isNotEmpty) {
          await _applyDeletesOnly(name, rows);
        }
      }

      // Phase 2: Upserts in forward order (parents before children)
      for (final name in orderedNames) {
        final rows = tables[name];
        if (rows != null && rows.isNotEmpty) {
          await _applyUpsertsOnly(name, rows);
        }
      }
    });
  }

  TableInfo? _getTableInfo(String name) {
    switch (name) {
      case 'machines': return db.machines;
      case 'machineVariants': return db.machineVariants;
      case 'colors': return db.colors;
      case 'assemblies': return db.assemblies;
      case 'assemblyItems': return db.assemblyItems;
      case 'itemResolutions': return db.itemResolutions;
      case 'dots': return db.dots;
      case 'assemblyLinks': return db.assemblyLinks;
      case 'parts': return db.parts;
      case 'partNumbers': return db.partNumbers;
      case 'partColorVariants': return db.partColorVariants;
      case 'aliases': return db.aliases;
      case 'serviceItems': return db.serviceItems;
      case 'partSubstitutes': return db.partSubstitutes;
      case 'customers': return db.customers;
      case 'customerVehicles': return db.customerVehicles;
      case 'maintenanceRecords': return db.maintenanceRecords;
      case 'maintenanceItems': return db.maintenanceItems;
      default: return null;
    }
  }

  Future<void> _applyDeletesOnly(String name, List<Map<String, dynamic>> rows) async {
    final table = _getTableInfo(name);
    if (table == null) return;

    final deleteIds = <String>[];
    for (final r in rows) {
      if (r['deletedAt'] != null && r['id'] is String) {
        deleteIds.add(r['id'] as String);
      }
    }

    if (deleteIds.isNotEmpty) {
      final placeholders = List.filled(deleteIds.length, '?').join(', ');
      await db.customStatement(
        'DELETE FROM ${table.actualTableName} WHERE id IN ($placeholders)',
        deleteIds,
      );
    }
  }

  Future<void> _applyUpsertsOnly(String name, List<Map<String, dynamic>> rows) async {
    switch (name) {
      case 'machines': return _upsertOnly(db.machines, rows, _machine);
      case 'machineVariants': return _upsertOnly(db.machineVariants, rows, _machineVariant);
      case 'colors': return _upsertOnly(db.colors, rows, _color);
      case 'assemblies': return _upsertOnly(db.assemblies, rows, _assembly);
      case 'assemblyItems': return _upsertOnly(db.assemblyItems, rows, _assemblyItem);
      case 'itemResolutions': return _upsertOnly(db.itemResolutions, rows, _itemResolution);
      case 'dots': return _upsertOnly(db.dots, rows, _dot);
      case 'assemblyLinks': return _upsertOnly(db.assemblyLinks, rows, _assemblyLink);
      case 'parts': return _upsertOnly(db.parts, rows, _part);
      case 'partNumbers': return _upsertOnly(db.partNumbers, rows, _partNumber);
      case 'partColorVariants': return _upsertOnly(db.partColorVariants, rows, _partColorVariant);
      case 'aliases': return _upsertOnly(db.aliases, rows, _alias);
      case 'serviceItems': return _upsertOnly(db.serviceItems, rows, _serviceItem);
      case 'partSubstitutes': return _upsertOnly(db.partSubstitutes, rows, _partSubstitute);
      case 'customers': return _upsertOnly(db.customers, rows, _customer);
      case 'customerVehicles': return _upsertOnly(db.customerVehicles, rows, _customerVehicle);
      case 'maintenanceRecords': return _upsertOnly(db.maintenanceRecords, rows, _maintenanceRecord);
      case 'maintenanceItems': return _upsertOnly(db.maintenanceItems, rows, _maintenanceItem);
      default: return;
    }
  }

  Future<void> _upsertOnly<T extends Table, D>(
    TableInfo<T, D> table,
    List<Map<String, dynamic>> rows,
    Insertable<D> Function(Map<String, dynamic>) toRow,
  ) async {
    final upserts = <Insertable<D>>[];
    for (final r in rows) {
      if (r['deletedAt'] == null) {
        upserts.add(toRow(r));
      }
    }
    if (upserts.isNotEmpty) {
      await db.batch((b) => b.insertAllOnConflictUpdate(table, upserts));
    }
  }

  /// Get all pending local CRM changes (rows updated after [since])
  /// to push back to backend.
  Future<Map<String, List<Map<String, dynamic>>>> getPendingCrmChanges(DateTime? since) async {
    final result = <String, List<Map<String, dynamic>>>{};

    // 1. Customers
    final custQuery = db.select(db.customers);
    if (since != null) {
      custQuery.where((t) => t.updatedAt.isBiggerThanValue(since));
    }
    final custRows = await custQuery.get();
    if (custRows.isNotEmpty) {
      result['customers'] = custRows.map((c) => {
        'id': c.id,
        'name': c.name,
        'phone': c.phone,
        'phoneAlt': c.phoneAlt,
        'email': c.email,
        'address': c.address,
        'notes': c.notes,
        'tag': c.tag,
        'updatedAt': c.updatedAt.toIso8601String(),
        'deletedAt': c.deletedAt?.toIso8601String(),
      }).toList();
    }

    // 2. CustomerVehicles
    final vehicleQuery = db.select(db.customerVehicles);
    if (since != null) {
      vehicleQuery.where((t) => t.updatedAt.isBiggerThanValue(since));
    }
    final vehicleRows = await vehicleQuery.get();
    if (vehicleRows.isNotEmpty) {
      result['customerVehicles'] = vehicleRows.map((v) => {
        'id': v.id,
        'customerId': v.customerId,
        'machineId': v.machineId,
        'licensePlate': v.licensePlate,
        'frameNumber': v.frameNumber,
        'colorId': v.colorId,
        'year': v.year,
        'nickname': v.nickname,
        'notes': v.notes,
        'updatedAt': v.updatedAt.toIso8601String(),
        'deletedAt': v.deletedAt?.toIso8601String(),
      }).toList();
    }

    // 3. MaintenanceRecords
    final recQuery = db.select(db.maintenanceRecords);
    if (since != null) {
      recQuery.where((t) => t.updatedAt.isBiggerThanValue(since));
    }
    final recRows = await recQuery.get();
    if (recRows.isNotEmpty) {
      result['maintenanceRecords'] = recRows.map((r) => {
        'id': r.id,
        'customerVehicleId': r.customerVehicleId,
        'customerId': r.customerId,
        'type': r.type,
        'date': r.date,
        'description': r.description,
        'technicianId': r.technicianId,
        'clerkId': r.clerkId,
        'invoiceNumber': r.invoiceNumber,
        'totalAmount': r.totalAmount,
        'notes': r.notes,
        'updatedAt': r.updatedAt.toIso8601String(),
        'deletedAt': r.deletedAt?.toIso8601String(),
      }).toList();
    }

    // 4. MaintenanceItems
    final itemQuery = db.select(db.maintenanceItems);
    if (since != null) {
      itemQuery.where((t) => t.updatedAt.isBiggerThanValue(since));
    }
    final itemRows = await itemQuery.get();
    if (itemRows.isNotEmpty) {
      result['maintenanceItems'] = itemRows.map((i) => {
        'id': i.id,
        'maintenanceRecordId': i.maintenanceRecordId,
        'category': i.category,
        'partId': i.partId,
        'partNumberId': i.partNumberId,
        'partNumber': i.partNumber,
        'brand': i.brand,
        'quantity': i.quantity,
        'hasWarranty': i.hasWarranty,
        'warrantyPeriodValue': i.warrantyPeriodValue,
        'warrantyPeriodUnit': i.warrantyPeriodUnit,
        'warrantyStartDate': i.warrantyStartDate,
        'warrantyExpiryDate': i.warrantyExpiryDate,
        'warrantyNotes': i.warrantyNotes,
        'unitPrice': i.unitPrice,
        'notes': i.notes,
        'sortOrder': i.sortOrder,
        'updatedAt': i.updatedAt.toIso8601String(),
        'deletedAt': i.deletedAt?.toIso8601String(),
      }).toList();
    }

    return result;
  }
}

// --- JSON -> companion mappers ---------------------------------------------

DateTime _dt(dynamic v) => DateTime.parse(v as String);
DateTime? _dtN(dynamic v) => v == null ? null : DateTime.parse(v as String);
double _d(dynamic v) => (v as num).toDouble();
double? _dN(dynamic v) => v == null ? null : (v as num).toDouble();
String? _json(dynamic v) => v == null ? null : jsonEncode(v);

int? _msN(dynamic v) {
  if (v == null) return null;
  if (v is int) return v;
  if (v is String) return DateTime.tryParse(v)?.millisecondsSinceEpoch;
  return null;
}
int _ms(dynamic v) => _msN(v) ?? 0;

MachinesCompanion _machine(Map<String, dynamic> r) => MachinesCompanion.insert(
  id: r['id'] as String,
  brand: r['brand'] as String,
  model: r['model'] as String,
  typeCode: Value(r['typeCode'] as String?),
  kCode: Value(r['kCode'] as String?),
  market: Value(r['market'] as String?),
  engineSeries: Value(r['engineSeries'] as String?),
  frameSeries: Value(r['frameSeries'] as String?),
  yearFrom: Value(r['yearFrom'] as int?),
  yearTo: Value(r['yearTo'] as int?),
  catalogEdition: Value(r['catalogEdition'] as String?),
  catalogDate: Value(r['catalogDate'] as String?),
  notes: Value(r['notes'] as String?),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

MachineVariantsCompanion _machineVariant(Map<String, dynamic> r) => MachineVariantsCompanion.insert(
  id: r['id'] as String,
  machineId: r['machineId'] as String,
  name: r['name'] as String,
  note: Value(r['note'] as String?),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

ColorsCompanion _color(Map<String, dynamic> r) => ColorsCompanion.insert(
  id: r['id'] as String,
  machineId: r['machineId'] as String,
  code: r['code'] as String,
  name: r['name'] as String,
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

AssembliesCompanion _assembly(Map<String, dynamic> r) => AssembliesCompanion.insert(
  id: r['id'] as String,
  machineId: r['machineId'] as String,
  groupType: r['groupType'] as String,
  code: r['code'] as String,
  name: r['name'] as String,
  imageRef: Value(r['imageRef'] as String?),
  imageCode: Value(r['imageCode'] as String?),
  width: Value(r['width'] as int?),
  height: Value(r['height'] as int?),
  pageNo: Value(r['pageNo'] as int?),
  sortOrder: Value(r['sortOrder'] as int?),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

AssemblyItemsCompanion _assemblyItem(Map<String, dynamic> r) => AssemblyItemsCompanion.insert(
  id: r['id'] as String,
  assemblyId: r['assemblyId'] as String,
  refNo: r['refNo'] as String,
  basePartId: Value(r['basePartId'] as String?),
  note: Value(r['note'] as String?),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

ItemResolutionsCompanion _itemResolution(Map<String, dynamic> r) => ItemResolutionsCompanion.insert(
  id: r['id'] as String,
  assemblyItemId: r['assemblyItemId'] as String,
  partNumberId: r['partNumberId'] as String,
  qty: Value(r['qty'] as int? ?? 1),
  variantId: Value(r['variantId'] as String?),
  serialFrom: Value(r['serialFrom'] as String?),
  serialTo: Value(r['serialTo'] as String?),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

DotsCompanion _dot(Map<String, dynamic> r) => DotsCompanion.insert(
  id: r['id'] as String,
  assemblyItemId: r['assemblyItemId'] as String,
  x: _d(r['x']),
  y: _d(r['y']),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

AssemblyLinksCompanion _assemblyLink(Map<String, dynamic> r) => AssemblyLinksCompanion.insert(
  id: r['id'] as String,
  fromAssemblyId: r['fromAssemblyId'] as String,
  toCode: r['toCode'] as String,
  toAssemblyId: Value(r['toAssemblyId'] as String?),
  x: Value(_dN(r['x'])),
  y: Value(_dN(r['y'])),
  label: Value(r['label'] as String?),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

PartsCompanion _part(Map<String, dynamic> r) => PartsCompanion.insert(
  id: r['id'] as String,
  nameRaw: r['nameRaw'] as String,
  nameNormalized: Value(r['nameNormalized'] as String?),
  category: Value(r['category'] as String?),
  specs: Value(_json(r['specs'])),
  notes: Value(r['notes'] as String?),
  isCurrentReplacement: Value(r['isCurrentReplacement'] as bool? ?? false),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

PartNumbersCompanion _partNumber(Map<String, dynamic> r) => PartNumbersCompanion.insert(
  id: r['id'] as String,
  partId: r['partId'] as String,
  value: r['value'] as String,
  kind: Value(r['kind'] as String? ?? 'oem'),
  brand: Value(r['brand'] as String?),
  note: Value(r['note'] as String?),
  isPrimary: Value(r['isPrimary'] as bool? ?? false),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

PartColorVariantsCompanion _partColorVariant(Map<String, dynamic> r) => PartColorVariantsCompanion.insert(
  id: r['id'] as String,
  partId: r['partId'] as String,
  colorId: r['colorId'] as String,
  suffixCode: Value(r['suffixCode'] as String?),
  fullNumber: Value(r['fullNumber'] as String?),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

AliasesCompanion _alias(Map<String, dynamic> r) => AliasesCompanion.insert(
  id: r['id'] as String,
  partId: r['partId'] as String,
  term: r['term'] as String,
  lang: Value(r['lang'] as String?),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

PartSubstitutesCompanion _partSubstitute(Map<String, dynamic> r) => PartSubstitutesCompanion.insert(
  id: r['id'] as String,
  partId: r['partId'] as String,
  substitutePartId: r['substitutePartId'] as String,
  note: Value(r['note'] as String?),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

ServiceItemsCompanion _serviceItem(Map<String, dynamic> r) => ServiceItemsCompanion.insert(
  id: r['id'] as String,
  assemblyId: r['assemblyId'] as String,
  name: r['name'] as String,
  refNo: Value(r['refNo'] as String?),
  frtHours: Value(_dN(r['frtHours'])),
  note: Value(r['note'] as String?),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

// CRM mappers

CustomersCompanion _customer(Map<String, dynamic> r) => CustomersCompanion.insert(
  id: r['id'] as String,
  name: r['name'] as String,
  phone: Value(r['phone'] as String?),
  phoneAlt: Value(r['phoneAlt'] as String?),
  email: Value(r['email'] as String?),
  address: Value(r['address'] as String?),
  notes: Value(r['notes'] as String?),
  tag: Value(r['tag'] as String?),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

CustomerVehiclesCompanion _customerVehicle(Map<String, dynamic> r) => CustomerVehiclesCompanion.insert(
  id: r['id'] as String,
  customerId: r['customerId'] as String,
  machineId: r['machineId'] as String,
  licensePlate: Value(r['licensePlate'] as String?),
  frameNumber: Value(r['frameNumber'] as String?),
  colorId: Value(r['colorId'] as String?),
  year: Value(r['year'] as int?),
  nickname: Value(r['nickname'] as String?),
  notes: Value(r['notes'] as String?),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

MaintenanceRecordsCompanion _maintenanceRecord(Map<String, dynamic> r) => MaintenanceRecordsCompanion.insert(
  id: r['id'] as String,
  customerVehicleId: Value(r['customerVehicleId'] as String?),
  customerId: r['customerId'] as String,
  type: r['type'] as String,
  date: _ms(r['date']),
  description: r['description'] as String,
  technicianId: Value(r['technicianId'] as String?),
  clerkId: Value(r['clerkId'] as String?),
  invoiceNumber: Value(r['invoiceNumber'] as String?),
  totalAmount: Value(r['totalAmount'] as int?),
  notes: Value(r['notes'] as String?),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);

MaintenanceItemsCompanion _maintenanceItem(Map<String, dynamic> r) => MaintenanceItemsCompanion.insert(
  id: r['id'] as String,
  maintenanceRecordId: r['maintenanceRecordId'] as String,
  category: r['category'] as String,
  partId: Value(r['partId'] as String?),
  partNumberId: Value(r['partNumberId'] as String?),
  partNumber: Value(r['partNumber'] as String?),
  brand: Value(r['brand'] as String?),
  quantity: Value(r['quantity'] as int? ?? 1),
  hasWarranty: Value(r['hasWarranty'] as bool? ?? false),
  warrantyPeriodValue: Value(r['warrantyPeriodValue'] as int?),
  warrantyPeriodUnit: Value(r['warrantyPeriodUnit'] as String?),
  warrantyStartDate: Value(_msN(r['warrantyStartDate'])),
  warrantyExpiryDate: Value(_msN(r['warrantyExpiryDate'])),
  warrantyNotes: Value(r['warrantyNotes'] as String?),
  unitPrice: Value(r['unitPrice'] as int?),
  notes: Value(r['notes'] as String?),
  sortOrder: Value(r['sortOrder'] as int? ?? 0),
  updatedAt: _dt(r['updatedAt']),
  deletedAt: Value(_dtN(r['deletedAt'])),
);
