import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';

import 'tables.dart';

part 'app_database.g.dart';

@DriftDatabase(
  tables: [
    Machines,
    MachineVariants,
    Colors,
    Assemblies,
    AssemblyItems,
    ItemResolutions,
    Dots,
    AssemblyLinks,
    Parts,
    PartNumbers,
    PartColorVariants,
    Aliases,
    ServiceItems,
    PartSubstitutes,
    SyncStates,
    // CRM tables
    Customers,
    CustomerVehicles,
    MaintenanceRecords,
    MaintenanceItems,
  ],
)
class AppDatabase extends _$AppDatabase {
  AppDatabase() : super(driftDatabase(name: 'wemo_clerk'));

  /// For tests: pass an in-memory or custom executor.
  AppDatabase.forTesting(super.executor);

  @override
  int get schemaVersion => 3;

  @override
  MigrationStrategy get migration => MigrationStrategy(
    onUpgrade: (m, from, to) async {
      // This is a disposable read replica: rather than write per-version
      // migrations, drop and recreate every table, then let the sync cursor
      // (reset to '0' because SyncStates is recreated empty) rebuild the whole
      // catalog from the master — including any new tables/columns.
      for (final table in allTables) {
        await m.deleteTable(table.actualTableName);
      }
      await m.createAll();
    },
  );

  /// The 18 mirrored catalog + CRM tables, keyed by the name the sync API uses
  /// (see apps/backend/src/routes/sync.ts `SYNC_TABLES`). Order matches the
  /// canonical parent-first sequence so a full sync inserts parents before children.
  Map<String, TableInfo> get syncTables => {
    'machines': machines,
    'parts': parts,
    'customers': customers,
    'machineVariants': machineVariants,
    'colors': colors,
    'assemblies': assemblies,
    'partNumbers': partNumbers,
    'aliases': aliases,
    'partSubstitutes': partSubstitutes,
    'partColorVariants': partColorVariants,
    'assemblyItems': assemblyItems,
    'assemblyLinks': assemblyLinks,
    'serviceItems': serviceItems,
    'customerVehicles': customerVehicles,
    'itemResolutions': itemResolutions,
    'dots': dots,
    'maintenanceRecords': maintenanceRecords,
    'maintenanceItems': maintenanceItems,
  };

  /// Wipe every mirrored catalog table so a full sync can rebuild from scratch.
  ///
  /// Used by "force full sync": the delta feed only drops a local row when it
  /// pulls a `deletedAt` tombstone, so rows hard-deleted on the master before
  /// tombstoning was in place (e.g. old balloon dots) leave orphans a cursor-0
  /// re-pull never learns to remove. Clearing first guarantees the replica ends
  /// up with exactly what the master currently holds. `syncStates` is left
  /// alone — the caller resets the cursor separately. Children are deleted
  /// before parents (reverse insert order) to respect any FK constraints.
  Future<void> clearCatalog() async {
    await transaction(() async {
      for (final table in syncTables.values.toList().reversed) {
        await customStatement('DELETE FROM ${table.actualTableName}');
      }
    });
  }

  /// Live row count per mirrored table (soft-deleted rows are already removed).
  Future<Map<String, int>> tableCounts() async {
    final counts = <String, int>{};
    for (final entry in syncTables.entries) {
      final row = await customSelect(
        'SELECT COUNT(*) AS c FROM ${entry.value.actualTableName}',
      ).getSingle();
      counts[entry.key] = row.read<int>('c');
    }
    return counts;
  }
}
