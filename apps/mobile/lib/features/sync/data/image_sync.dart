import '../../../core/images/image_store.dart';
import 'sync_api.dart';

/// The assembly-image state that changed in a sync delta.
class AssemblyImageDelta {
  const AssemblyImageDelta({required this.id, required this.hasImage, required this.deleted});
  final String id;
  final bool hasImage; // imageRef != null
  final bool deleted; // deletedAt != null
}

class ImageSyncResult {
  const ImageSyncResult({required this.fetched, required this.removed, required this.failed});
  final int fetched;
  final int removed;
  final int failed;
}

/// Downloads/removes cached diagram images for the assemblies that changed in a
/// sync. Only assemblies present in a delta are touched, so a normal sync
/// refetches just what changed; a full sync refetches everything. Best-effort:
/// an image failure never fails the row sync (the data is already applied).
class ImageSyncService {
  ImageSyncService({required this.api, required this.store});

  final SyncApi api;
  final ImageStore store;

  Future<ImageSyncResult> sync(
    Iterable<AssemblyImageDelta> deltas, {
    bool skipExisting = false,
  }) async {
    var fetched = 0, removed = 0, failed = 0;
    for (final d in deltas) {
      try {
        if (d.deleted || !d.hasImage) {
          await store.delete(d.id);
          removed++;
          continue;
        }
        if (skipExisting && await store.has(d.id)) {
          continue;
        }
        final bytes = await api.fetchImage(d.id);
        if (bytes == null) {
          await store.delete(d.id);
          removed++;
        } else {
          await store.write(d.id, bytes);
          fetched++;
        }
      } catch (_) {
        failed++;
      }
    }
    return ImageSyncResult(fetched: fetched, removed: removed, failed: failed);
  }
}
