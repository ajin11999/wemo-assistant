import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import '../../../core/db/app_database.dart';

/// Repository for managing maintenance records.
class RecordRepository {
  RecordRepository(this.db);

  final AppDatabase db;

  // Get all records
  Future<List<MaintenanceRecord>> getAllRecords() async {
    return await (db.select(db.maintenanceRecords)
      ..orderBy([(t) => OrderingTerm(expression: t.date, mode: OrderingMode.desc)])).get();
  }

  // Get records for a customer
  Future<List<MaintenanceRecord>> getRecordsForCustomer(String customerId) async {
    return await (db.select(db.maintenanceRecords)
      ..where((t) => t.customerId.equals(customerId))
      ..orderBy([(t) => OrderingTerm(expression: t.date, mode: OrderingMode.desc)])).get();
  }

  // Get records for a vehicle
  Future<List<MaintenanceRecord>> getRecordsForVehicle(String vehicleId) async {
    return await (db.select(db.maintenanceRecords)
      ..where((t) => t.customerVehicleId.equals(vehicleId))
      ..orderBy([(t) => OrderingTerm(expression: t.date, mode: OrderingMode.desc)])).get();
  }

  // Get record by ID
  Future<MaintenanceRecord?> getRecord(String id) async {
    final query = db.select(db.maintenanceRecords)..where((t) => t.id.equals(id));
    return await query.getSingleOrNull();
  }

  // Get record with customer, vehicle, and items
  Future<({
    MaintenanceRecord record,
    Customer? customer,
    CustomerVehicle? vehicle,
    List<MaintenanceItem> items
  })?> getRecordFull(String recordId) async {
    final record = await getRecord(recordId);
    if (record == null) return null;
    
    final customerQuery = db.select(db.customers)..where((t) => t.id.equals(record.customerId));
    final vehicleQuery = record.customerVehicleId != null 
      ? (db.select(db.customerVehicles)..where((t) => t.id.equals(record.customerVehicleId!)))
      : null;
    final itemsQuery = db.select(db.maintenanceItems)
      ..where((t) => t.maintenanceRecordId.equals(recordId))
      ..orderBy([(t) => OrderingTerm(expression: t.sortOrder)]);
    
    final [customer, items] = await Future.wait([
      customerQuery.getSingleOrNull(),
      itemsQuery.get(),
    ]);
    
    final vehicle = vehicleQuery != null ? await vehicleQuery.getSingleOrNull() : null;
    
    return (record: record, customer: customer as Customer?, vehicle: vehicle, items: items as List<MaintenanceItem>);
  }

  // Create record
  Future<String> createRecord({
    required String customerId,
    String? customerVehicleId,
    required String type, // 'service' or 'purchase'
    DateTime? date,
    required String description,
    String? technicianId,
    String? clerkId,
    String? invoiceNumber,
    int? totalAmount,
    String? notes,
  }) async {
    final id = const Uuid().v4();
    final companion = MaintenanceRecordsCompanion.insert(
      id: id,
      customerId: customerId,
      customerVehicleId: Value(customerVehicleId),
      type: type,
      date: date?.millisecondsSinceEpoch ?? DateTime.now().millisecondsSinceEpoch,
      description: description,
      technicianId: Value(technicianId),
      clerkId: Value(clerkId),
      invoiceNumber: Value(invoiceNumber),
      totalAmount: Value(totalAmount),
      notes: Value(notes),
      updatedAt: DateTime.now(),
    );
    
    await db.into(db.maintenanceRecords).insert(companion);
    return id.toString();
  }

  // Update record
  Future<bool> updateRecord({
    required String id,
    String? customerId,
    String? customerVehicleId,
    String? type,
    DateTime? date,
    String? description,
    String? technicianId,
    String? clerkId,
    String? invoiceNumber,
    int? totalAmount,
    String? notes,
  }) async {
    final query = db.update(db.maintenanceRecords)..where((t) => t.id.equals(id));
    
    final updates = MaintenanceRecordsCompanion(
      customerId: customerId != null ? Value(customerId) : const Value.absent(),
      customerVehicleId: customerVehicleId != null ? Value(customerVehicleId) : const Value.absent(),
      type: type != null ? Value(type) : const Value.absent(),
      date: date != null ? Value(date.millisecondsSinceEpoch) : const Value.absent(),
      description: description != null ? Value(description) : const Value.absent(),
      technicianId: technicianId != null ? Value(technicianId) : const Value.absent(),
      clerkId: clerkId != null ? Value(clerkId) : const Value.absent(),
      invoiceNumber: invoiceNumber != null ? Value(invoiceNumber) : const Value.absent(),
      totalAmount: totalAmount != null ? Value(totalAmount) : const Value.absent(),
      notes: notes != null ? Value(notes) : const Value.absent(),
      updatedAt: Value(DateTime.now()),
    );
    
    return await query.write(updates) > 0;
  }

  // Delete record (soft delete)
  Future<bool> deleteRecord(String id) async {
    final query = db.update(db.maintenanceRecords)..where((t) => t.id.equals(id));
    return await query.write(MaintenanceRecordsCompanion(
      deletedAt: Value(DateTime.now()),
      updatedAt: Value(DateTime.now()),
    )) > 0;
  }

  // Get recent records (limit)
  Future<List<MaintenanceRecord>> getRecentRecords({int limit = 10}) async {
    return await (db.select(db.maintenanceRecords)
      ..orderBy([(t) => OrderingTerm(expression: t.date, mode: OrderingMode.desc)])
      ..limit(limit)).get();
  }
}