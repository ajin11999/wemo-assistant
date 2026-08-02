import 'package:drift/drift.dart';
import 'package:uuid/uuid.dart';

import '../../../core/db/app_database.dart';

/// Repository for managing customers.
class CustomerRepository {
  CustomerRepository(this.db);

  final AppDatabase db;

  // Get all customers (sorted by last updated)
  Future<List<Customer>> getAllCustomers() async {
    return await (db.select(db.customers)
      ..where((t) => t.deletedAt.isNull())
      ..orderBy([(t) => OrderingTerm(expression: t.updatedAt, mode: OrderingMode.desc)]))
      .get();
  }

  // Get customer by ID
  Future<Customer?> getCustomer(String id) async {
    final query = db.select(db.customers)..where((t) => t.id.equals(id) & t.deletedAt.isNull());
    return await query.getSingleOrNull();
  }

  // Search customers by name, phone, email, tag, or address
  Future<List<Customer>> searchCustomers(String query) async {
    if (query.isEmpty) return getAllCustomers();
    
    final searchPattern = '%$query%';
    final q = db.select(db.customers)
      ..where((t) => 
        t.deletedAt.isNull() & (
          t.name.like(searchPattern) |
          t.phone.like(searchPattern) |
          t.phoneAlt.like(searchPattern) |
          t.email.like(searchPattern) |
          t.tag.like(searchPattern) |
          t.address.like(searchPattern)
        )
      )
      ..orderBy([(t) => OrderingTerm(expression: t.updatedAt, mode: OrderingMode.desc)])
      ..limit(50);
    
    return await q.get();
  }

  // Create customer
  Future<String> createCustomer({
    required String name,
    String? phone,
    String? phoneAlt,
    String? email,
    String? address,
    String? notes,
    String? tag,
  }) async {
    final id = const Uuid().v4();
    final companion = CustomersCompanion.insert(
      id: id,
      name: name,
      phone: Value(phone),
      phoneAlt: Value(phoneAlt),
      email: Value(email),
      address: Value(address),
      notes: Value(notes),
      tag: Value(tag),
      updatedAt: DateTime.now(),
    );
    
    await db.into(db.customers).insert(companion);
    return id.toString();
  }

  // Update customer
  Future<bool> updateCustomer({
    required String id,
    String? name,
    String? phone,
    String? phoneAlt,
    String? email,
    String? address,
    String? notes,
    String? tag,
  }) async {
    final query = db.update(db.customers)..where((t) => t.id.equals(id));
    
    final updates = CustomersCompanion(
      name: name != null ? Value(name) : const Value.absent(),
      phone: phone != null ? Value(phone) : const Value.absent(),
      phoneAlt: phoneAlt != null ? Value(phoneAlt) : const Value.absent(),
      email: email != null ? Value(email) : const Value.absent(),
      address: address != null ? Value(address) : const Value.absent(),
      notes: notes != null ? Value(notes) : const Value.absent(),
      tag: tag != null ? Value(tag) : const Value.absent(),
      updatedAt: Value(DateTime.now()),
    );
    
    return await query.write(updates) > 0;
  }

  // Delete customer (soft delete)
  Future<bool> deleteCustomer(String id) async {
    final query = db.update(db.customers)..where((t) => t.id.equals(id));
    return await query.write(CustomersCompanion(
      deletedAt: Value(DateTime.now()),
      updatedAt: Value(DateTime.now()),
    )) > 0;
  }

  // Get customer with their vehicles
  Future<({Customer customer, List<CustomerVehicle> vehicles})?> getCustomerWithVehicles(String customerId) async {
    final customer = await getCustomer(customerId);
    if (customer == null) return null;
    
    final vehicles = await (db.select(db.customerVehicles)
      ..where((t) => t.customerId.equals(customerId))).get();
    
    return (customer: customer, vehicles: vehicles);
  }
}