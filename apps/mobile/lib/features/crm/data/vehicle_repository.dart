import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import '../../../core/db/app_database.dart';

/// Repository for managing customer vehicles.
class VehicleRepository {
  VehicleRepository(this.db);

  final AppDatabase db;

  // Get all vehicles for a customer
  Future<List<CustomerVehicle>> getVehiclesForCustomer(String customerId) async {
    return await (db.select(db.customerVehicles)
      ..where((t) => t.customerId.equals(customerId))).get();
  }

  // Get vehicle by ID
  Future<CustomerVehicle?> getVehicle(String id) async {
    final query = db.select(db.customerVehicles)..where((t) => t.id.equals(id));
    return await query.getSingleOrNull();
  }

  // Get vehicle with customer and machine info
  Future<({CustomerVehicle vehicle, Customer? customer, Machine? machine})?> getVehicleWithDetails(String vehicleId) async {
    final vehicle = await getVehicle(vehicleId);
    if (vehicle == null) return null;
    
    final customerQuery = db.select(db.customers)..where((t) => t.id.equals(vehicle.customerId));
    final machineQuery = db.select(db.machines)..where((t) => t.id.equals(vehicle.machineId));
    
    final [customer, machine] = await Future.wait([
      customerQuery.getSingleOrNull(),
      machineQuery.getSingleOrNull(),
    ]);
    
    return (vehicle: vehicle, customer: customer as Customer?, machine: machine as Machine?);
  }

  // Create vehicle
  Future<String> createVehicle({
    required String customerId,
    required String machineId,
    String? licensePlate,
    String? frameNumber,
    String? colorId,
    int? year,
    String? nickname,
    String? notes,
  }) async {
    final id = const Uuid().v4();
    final companion = CustomerVehiclesCompanion.insert(
      id: id,
      customerId: customerId,
      machineId: machineId,
      licensePlate: Value(licensePlate),
      frameNumber: Value(frameNumber),
      colorId: Value(colorId),
      year: Value(year),
      nickname: Value(nickname),
      notes: Value(notes),
      updatedAt: DateTime.now(),
    );
    
    await db.into(db.customerVehicles).insert(companion);
    return id.toString();
  }

  // Update vehicle
  Future<bool> updateVehicle({
    required String id,
    String? customerId,
    String? machineId,
    String? licensePlate,
    String? frameNumber,
    String? colorId,
    int? year,
    String? nickname,
    String? notes,
  }) async {
    final query = db.update(db.customerVehicles)..where((t) => t.id.equals(id));
    
    final updates = CustomerVehiclesCompanion(
      customerId: customerId != null ? Value(customerId) : const Value.absent(),
      machineId: machineId != null ? Value(machineId) : const Value.absent(),
      licensePlate: licensePlate != null ? Value(licensePlate) : const Value.absent(),
      frameNumber: frameNumber != null ? Value(frameNumber) : const Value.absent(),
      colorId: colorId != null ? Value(colorId) : const Value.absent(),
      year: year != null ? Value(year) : const Value.absent(),
      nickname: nickname != null ? Value(nickname) : const Value.absent(),
      notes: notes != null ? Value(notes) : const Value.absent(),
      updatedAt: Value(DateTime.now()),
    );
    
    return await query.write(updates) > 0;
  }

  // Delete vehicle (soft delete)
  Future<bool> deleteVehicle(String id) async {
    final query = db.update(db.customerVehicles)..where((t) => t.id.equals(id));
    return await query.write(CustomerVehiclesCompanion(
      deletedAt: Value(DateTime.now()),
      updatedAt: Value(DateTime.now()),
    )) > 0;
  }

  // Get vehicles with their maintenance records
  Future<List<({CustomerVehicle vehicle, List<MaintenanceRecord> records})>> getVehiclesWithRecords(String customerId) async {
    final vehicles = await getVehiclesForCustomer(customerId);
    
    final results = <({CustomerVehicle vehicle, List<MaintenanceRecord> records})>[];
    
    for (final vehicle in vehicles) {
      final records = await (db.select(db.maintenanceRecords)
        ..where((t) => t.customerVehicleId.equals(vehicle.id))).get();
      results.add((vehicle: vehicle, records: records));
    }
    
    return results;
  }
}