import 'package:flutter/foundation.dart';

import '../../core/db/app_database.dart';
import '../../core/images/image_store.dart';
import '../../core/settings/app_settings.dart';
import 'data/image_sync.dart';
import 'data/sync_api.dart';
import 'data/sync_repository.dart';

enum SyncStatus { idle, syncing, success, error }

/// Drives the delta-sync loop and exposes state for the sync screen.
///
/// The read-only replica pulls pages until `hasMore` is false, persisting the
/// cursor after each page (partial progress survives a crash; pages are
/// idempotent). After the rows apply, diagram images for the assemblies that
/// changed are fetched into the on-disk cache. Nothing here writes back.
class SyncController extends ChangeNotifier {
  SyncController({required this.db, required this.settings, required this.imageStore})
    : _repo = SyncRepository(db) {
    _load();
  }

  final AppDatabase db;
  final AppSettings settings;
  final ImageStore imageStore;
  final SyncRepository _repo;

  SyncStatus status = SyncStatus.idle;
  String? errorMessage;
  int pagesPulled = 0;
  int rowsPulled = 0;
  int imagesFetched = 0;
  DateTime? lastSyncedAt;
  Map<String, int> tableCounts = const {};

  Future<void> _load() async {
    lastSyncedAt = await _repo.lastSyncedAt();
    tableCounts = await db.tableCounts();
    notifyListeners();
  }

  Future<void> refreshCounts() async {
    tableCounts = await db.tableCounts();
    notifyListeners();
  }

  Future<void> syncNow() async {
    if (status == SyncStatus.syncing) return;
    status = SyncStatus.syncing;
    errorMessage = null;
    pagesPulled = 0;
    rowsPulled = 0;
    imagesFetched = 0;
    notifyListeners();

    final api = SyncApi(baseUrl: settings.baseUrl, apiKey: settings.apiKey);
    // Last-seen image state per assembly across the session (id -> delta).
    final imageDeltas = <String, AssemblyImageDelta>{};
    try {
      // 1. Push pending local CRM changes to backend
      final pendingCrm = await _repo.getPendingCrmChanges(lastSyncedAt);
      if (pendingCrm.isNotEmpty) {
        await api.push(pendingCrm);
      }

      // 2. Pull deltas from server
      var cursor = await _repo.currentCursor();
      while (true) {
        final page = await api.fetch(cursor: cursor);
        await _repo.applyPage(page.tables);
        cursor = page.cursor;
        await _repo.saveCursor(cursor);

        for (final row in page.tables['assemblies'] ?? const []) {
          imageDeltas[row['id'] as String] = AssemblyImageDelta(
            id: row['id'] as String,
            hasImage: row['imageRef'] != null,
            deleted: row['deletedAt'] != null,
          );
        }

        pagesPulled++;
        rowsPulled += page.tables.values.fold<int>(0, (sum, rows) => sum + rows.length);
        notifyListeners();

        if (!page.hasMore) break;
      }

      // Images are best-effort: the catalog data is already synced.
      final imageResult = await ImageSyncService(api: api, store: imageStore).sync(imageDeltas.values);
      imagesFetched = imageResult.fetched;

      await _repo.markSynced(DateTime.now());
      lastSyncedAt = await _repo.lastSyncedAt();
      tableCounts = await db.tableCounts();
      status = SyncStatus.success;
    } catch (e) {
      errorMessage = e is SyncApiException ? e.message : '$e';
      status = SyncStatus.error;
    } finally {
      api.dispose();
      notifyListeners();
    }
  }

  /// Wipe the local replica and pull the whole catalog again (recovery path).
  ///
  /// Clears the mirrored tables first so orphan rows the delta feed can no
  /// longer tombstone (e.g. dots hard-deleted on the master before tombstoning)
  /// are dropped, then re-pulls from cursor 0 for an exact copy of the master.
  Future<void> forceFullSync() async {
    if (status == SyncStatus.syncing) return;
    await _repo.clearCatalog();
    await _repo.resetCursor();
    await syncNow();
  }
}
