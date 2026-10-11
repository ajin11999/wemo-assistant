import 'dart:io';
import 'dart:typed_data';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// On-disk cache of diagram images, one file per assembly at
/// `<app documents>/diagrams/<assemblyId>.img`. The bytes come from
/// `GET /assemblies/:id/image`; the row's `imageRef` tells us an image exists.
class ImageStore {
  Directory? _dir;

  Future<Directory> _diagramsDir() async {
    if (_dir != null) return _dir!;
    final docs = await getApplicationDocumentsDirectory();
    final dir = Directory(p.join(docs.path, 'diagrams'));
    if (!await dir.exists()) await dir.create(recursive: true);
    return _dir = dir;
  }

  Future<File> fileFor(String assemblyId) async {
    final dir = await _diagramsDir();
    return File(p.join(dir.path, '$assemblyId.img'));
  }

  Future<bool> has(String assemblyId) => fileFor(assemblyId).then((f) async {
        return (await f.exists()) && (await f.length()) > 0;
      });

  Future<void> write(String assemblyId, Uint8List bytes) async {
    final f = await fileFor(assemblyId);
    await f.writeAsBytes(bytes, flush: true);
  }

  Future<void> delete(String assemblyId) async {
    final f = await fileFor(assemblyId);
    if (await f.exists()) await f.delete();
  }
}
