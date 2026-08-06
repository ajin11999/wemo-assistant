import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

/// One page of the delta-sync response from `GET /sync`.
///
/// Contract (apps/backend/src/routes/sync.ts): the client loops while
/// [hasMore], passing [cursor] back verbatim each time. Mid-session [cursor] is
/// an opaque token; on the terminal page it is a bare ms number = the next
/// session's low watermark. Rows carry `updatedAt` (ISO) and `deletedAt`
/// (ISO|null); a non-null `deletedAt` means the row was soft-deleted.
class SyncPage {
  SyncPage({required this.cursor, required this.hasMore, required this.tables});

  final String cursor;
  final bool hasMore;

  /// tableName -> list of row maps.
  final Map<String, List<Map<String, dynamic>>> tables;
}

class SyncApiException implements Exception {
  SyncApiException(this.message);
  final String message;
  @override
  String toString() => 'SyncApiException: $message';
}

/// Thin HTTP client for sync endpoints. Reads are guarded by the clerk API key
/// (sent as a Bearer header). CRM tables can be written back via POST /sync/push.
class SyncApi {
  SyncApi({
    required this.baseUrl,
    this.apiKey = '',
    http.Client? client,
    this.timeout = const Duration(seconds: 30),
  }) : _client = client ?? http.Client(),
       _ownsClient = client == null;

  final String baseUrl;
  final String apiKey;
  final Duration timeout;
  final http.Client _client;
  final bool _ownsClient;

  Map<String, String> get _headers =>
      apiKey.isEmpty ? const {} : {'Authorization': 'Bearer $apiKey'};

  Future<SyncPage> fetch({required String cursor, int? limit}) async {
    final base = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
    final uri = Uri.parse('$base/sync').replace(
      queryParameters: {
        'cursor': cursor.isEmpty ? '0' : cursor,
        if (limit != null) 'limit': '$limit',
      },
    );

    final http.Response res;
    try {
      res = await _client.get(uri, headers: _headers).timeout(timeout);
    } catch (e) {
      throw SyncApiException('cannot reach $base ($e)');
    }
    if (res.statusCode == 401) {
      throw SyncApiException('Not authorized — check the API key on the Sync screen.');
    }
    if (res.statusCode != 200) {
      throw SyncApiException('HTTP ${res.statusCode} from $uri');
    }

    final Map<String, dynamic> body;
    try {
      body = jsonDecode(res.body) as Map<String, dynamic>;
    } catch (e) {
      throw SyncApiException('bad JSON from $uri ($e)');
    }

    final rawTables = (body['tables'] as Map<String, dynamic>? ?? const {});
    final tables = <String, List<Map<String, dynamic>>>{
      for (final entry in rawTables.entries)
        entry.key: (entry.value as List<dynamic>).cast<Map<String, dynamic>>(),
    };

    return SyncPage(
      // cursor is a bare number on the terminal page, an opaque string mid-session.
      cursor: '${body['cursor']}',
      hasMore: body['hasMore'] as bool? ?? false,
      tables: tables,
    );
  }

  /// Fetch an assembly's diagram image bytes. Returns null on 404 (no image).
  Future<Uint8List?> fetchImage(String assemblyId) async {
    final base = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
    final uri = Uri.parse('$base/assemblies/$assemblyId/image');

    final http.Response res;
    try {
      res = await _client.get(uri, headers: _headers).timeout(timeout);
    } catch (e) {
      throw SyncApiException('cannot reach $base ($e)');
    }
    if (res.statusCode == 404) return null;
    if (res.statusCode != 200) throw SyncApiException('HTTP ${res.statusCode} from $uri');
    return res.bodyBytes;
  }

  void dispose() {
    if (_ownsClient) _client.close();
  }

  /// Push local CRM changes back to the server (POST /sync/push).
  /// Used for bidirectional sync of CRM tables that clerk can write to.
  Future<Map<String, dynamic>> push(Map<String, List<Map<String, dynamic>>> tables) async {
    final base = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
    final uri = Uri.parse('$base/sync/push');

    final http.Response res;
    try {
      res = await _client.post(
        uri,
        headers: {..._headers, 'Content-Type': 'application/json'},
        body: jsonEncode({'tables': tables}),
      ).timeout(timeout);
    } catch (e) {
      throw SyncApiException('cannot reach $base ($e)');
    }
    if (res.statusCode == 401) {
      throw SyncApiException('Not authorized — check the API key on the Sync screen.');
    }
    if (res.statusCode != 200) {
      String msg = 'HTTP ${res.statusCode} from $uri';
      try {
        final body = jsonDecode(res.body);
        if (body is Map && body.containsKey('error')) {
          msg = '${body['error']}${body['details'] != null ? ': ${body['details']}' : ''}';
        }
      } catch (_) {}
      throw SyncApiException(msg);
    }

    try {
      return jsonDecode(res.body) as Map<String, dynamic>;
    } catch (e) {
      throw SyncApiException('bad JSON from $uri ($e)');
    }
  }
}
