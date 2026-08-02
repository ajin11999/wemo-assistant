import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import '../../../core/db/app_database.dart';

/// Repository for managing maintenance record items.
class RecordItemRepository {
  RecordItemRepository(this.db);

  final AppDatabase db;

  // Get all items for a record
  Future<List<MaintenanceItem>> getItemsForRecord(String recordId) async {
    return await (db.select(db.maintenanceItems)
      ..where((t) => t.maintenanceRecordId.equals(recordId))
      ..orderBy([(t) => OrderingTerm(expression: t.sortOrder)])).get();
  }

  // Get item by ID
  Future<MaintenanceItem?> getItem(String id) async {
    final query = db.select(db.maintenanceItems)..where((t) => t.id.equals(id));
    return await query.getSingleOrNull();
  }

  // Create item
  Future<String> createItem({
    required String maintenanceRecordId,
    required String category,
    String? partId,
    String? partNumberId,
    String? partNumber,
    String? brand,
    int quantity = 1,
    bool hasWarranty = false,
    int? warrantyPeriodValue,
    String? warrantyPeriodUnit, // 'days' | 'months'
    DateTime? warrantyStartDate,
    int? warrantyExpiryDateMs,
    String? warrantyNotes,
    int? unitPrice,
    String? notes,
    int sortOrder = 0,
  }) async {
    // Calculate expiry if warranty is enabled
    final now = DateTime.now();
    final startMs = warrantyStartDate?.millisecondsSinceEpoch ?? now.millisecondsSinceEpoch;
    final expiryMs = hasWarranty && warrantyPeriodValue != null && warrantyPeriodUnit != null
        ? _calculateWarrantyExpiry(startMs, warrantyPeriodValue, warrantyPeriodUnit)
        : warrantyExpiryDateMs;
    
    final id = const Uuid().v4();
    final companion = MaintenanceItemsCompanion.insert(
      id: id,
      maintenanceRecordId: maintenanceRecordId,
      category: category,
      partId: Value(partId),
      partNumberId: Value(partNumberId),
      partNumber: Value(partNumber),
      brand: Value(brand),
      quantity: Value(quantity),
      hasWarranty: Value(hasWarranty),
      warrantyPeriodValue: Value(warrantyPeriodValue),
      warrantyPeriodUnit: Value(warrantyPeriodUnit),
      warrantyStartDate: Value(startMs),
      warrantyExpiryDate: Value(expiryMs),
      warrantyNotes: Value(warrantyNotes),
      unitPrice: Value(unitPrice),
      notes: Value(notes),
      sortOrder: Value(sortOrder),
      updatedAt: DateTime.now(),
    );
    
    await db.into(db.maintenanceItems).insert(companion);
    return id.toString();
  }

  // Update item
  Future<bool> updateItem({
    required String id,
    String? maintenanceRecordId,
    String? category,
    String? partId,
    String? partNumberId,
    String? partNumber,
    String? brand,
    int? quantity,
    bool? hasWarranty,
    int? warrantyPeriodValue,
    String? warrantyPeriodUnit,
    DateTime? warrantyStartDate,
    int? warrantyExpiryDateMs,
    String? warrantyNotes,
    int? unitPrice,
    String? notes,
    int? sortOrder,
  }) async {
    final query = db.update(db.maintenanceItems)..where((t) => t.id.equals(id));
    
    // Calculate expiry if warranty fields are being updated
    int? calculatedExpiryMs;
    if (hasWarranty != null && hasWarranty && warrantyPeriodValue != null && warrantyPeriodUnit != null) {
      final startMs = warrantyStartDate?.millisecondsSinceEpoch ?? DateTime.now().millisecondsSinceEpoch;
      calculatedExpiryMs = _calculateWarrantyExpiry(startMs, warrantyPeriodValue, warrantyPeriodUnit);
    }
    
    final updates = MaintenanceItemsCompanion(
      maintenanceRecordId: maintenanceRecordId != null ? Value(maintenanceRecordId) : const Value.absent(),
      category: category != null ? Value(category) : const Value.absent(),
      partId: partId != null ? Value(partId) : const Value.absent(),
      partNumberId: partNumberId != null ? Value(partNumberId) : const Value.absent(),
      partNumber: partNumber != null ? Value(partNumber) : const Value.absent(),
      brand: brand != null ? Value(brand) : const Value.absent(),
      quantity: quantity != null ? Value(quantity) : const Value.absent(),
      hasWarranty: hasWarranty != null ? Value(hasWarranty) : const Value.absent(),
      warrantyPeriodValue: warrantyPeriodValue != null ? Value(warrantyPeriodValue) : const Value.absent(),
      warrantyPeriodUnit: warrantyPeriodUnit != null ? Value(warrantyPeriodUnit) : const Value.absent(),
      warrantyStartDate: warrantyStartDate != null ? Value(warrantyStartDate.millisecondsSinceEpoch) : const Value.absent(),
      warrantyExpiryDate: calculatedExpiryMs != null || warrantyExpiryDateMs != null 
          ? Value(calculatedExpiryMs ?? warrantyExpiryDateMs) 
          : const Value.absent(),
      warrantyNotes: warrantyNotes != null ? Value(warrantyNotes) : const Value.absent(),
      unitPrice: unitPrice != null ? Value(unitPrice) : const Value.absent(),
      notes: notes != null ? Value(notes) : const Value.absent(),
      sortOrder: sortOrder != null ? Value(sortOrder) : const Value.absent(),
      updatedAt: Value(DateTime.now()),
    );
    
    return await query.write(updates) > 0;
  }

  // Delete item (soft delete)
  Future<bool> deleteItem(String id) async {
    final query = db.update(db.maintenanceItems)..where((t) => t.id.equals(id));
    return await query.write(MaintenanceItemsCompanion(
      deletedAt: Value(DateTime.now()),
      updatedAt: Value(DateTime.now()),
    )) > 0;
  }

  // Reorder items
  Future<bool> reorderItem(String id, int newSortOrder) async {
    final query = db.update(db.maintenanceItems)..where((t) => t.id.equals(id));
    return await query.write(MaintenanceItemsCompanion(
      sortOrder: Value(newSortOrder),
      updatedAt: Value(DateTime.now()),
    )) > 0;
  }

  // Calculate warranty expiry in milliseconds
  int _calculateWarrantyExpiry(int startMs, int periodValue, String periodUnit) {
    final startDate = DateTime.fromMillisecondsSinceEpoch(startMs);
    if (periodUnit == 'days') {
      return startDate.add(Duration(days: periodValue)).millisecondsSinceEpoch;
    } else { // months
      return DateTime(startDate.year, startDate.month + periodValue, startDate.day).millisecondsSinceEpoch;
    }
  }

  // Get items with warranty expiring soon
  Future<List<MaintenanceItem>> getExpiringWarrantyItems({int days = 30}) async {
    final now = DateTime.now();
    final expiryThreshold = now.add(Duration(days: days)).millisecondsSinceEpoch;
    final nowMs = now.millisecondsSinceEpoch;
    
    final allItems = await (db.select(db.maintenanceItems)
      ..where((t) => t.hasWarranty.equals(true) & t.warrantyExpiryDate.isNotNull())).get();
    
    return allItems.where((item) {
      final expiryDate = item.warrantyExpiryDate;
      if (expiryDate == null) return false;
      return expiryDate > nowMs && expiryDate <= expiryThreshold;
    }).toList();
  }
}