import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/images/image_store.dart';
import '../../core/settings/app_settings.dart';
import '../search/part_detail_screen.dart';
import '../sync/data/sync_api.dart';
import 'data/catalog_repository.dart';
import 'diagram_view.dart';
import 'fitment_controller.dart';
import 'fitment_sheet.dart';
import 'models.dart';

class DiagramScreen extends StatefulWidget {
  const DiagramScreen({super.key, required this.assemblyId, this.highlightItemId});

  final String assemblyId;

  /// When set (e.g. arriving from part detail), the matching position's dots
  /// start highlighted + zoomed-to and its part card is shown.
  final String? highlightItemId;

  @override
  State<DiagramScreen> createState() => _DiagramScreenState();
}

class _DiagramData {
  _DiagramData({
    required this.meta,
    required this.imageFile,
    required this.aspectRatio,
    required this.dots,
    required this.fitmentAvailable,
    required this.order,
  });
  final AssemblyMeta meta;
  final File? imageFile;
  final double aspectRatio;
  final List<DiagramDot> dots;
  final bool fitmentAvailable; // machine has variants or serial-ranged resolutions
  final List<String> order; // machine's assembly ids in grid order, for prev/next
}

class _DiagramScreenState extends State<DiagramScreen> {
  late String _assemblyId;
  late Future<_DiagramData?> _future;
  DiagramDot? _selected;
  DiagramDot? _focusDot;
  int _focusTick = 0;

  @override
  void initState() {
    super.initState();
    _assemblyId = widget.assemblyId;
    // Capture providers before the async gaps.
    _future = _load(
      context.read<CatalogRepository>(),
      context.read<ImageStore>(),
      context.read<AppSettings>(),
    );
    if (widget.highlightItemId != null) {
      _future.then((data) {
        if (!mounted || data == null) return;
        for (final dot in data.dots) {
          if (dot.itemId == widget.highlightItemId) {
            _select(dot, focus: true);
            break;
          }
        }
      });
    }
  }

  Future<_DiagramData?> _load(
    CatalogRepository repo,
    ImageStore store,
    AppSettings settings,
  ) async {
    final meta = await repo.assemblyMeta(_assemblyId);
    if (meta == null) return null;
    final dots = await repo.diagramDots(_assemblyId);
    final fitmentAvailable = await repo.fitmentAvailable(meta.machineId);
    final order = await repo.assemblyOrder(meta.machineId);
    final file = await store.fileFor(_assemblyId);

    File? imageFile;
    var aspect = meta.aspectRatio ?? 1.0;
    if (await file.exists() && (await file.length()) > 0) {
      imageFile = file;
      if (meta.aspectRatio == null) {
        aspect = await _decodeAspect(file) ?? 1.0;
      }
    } else if (meta.hasImage) {
      // On-demand fetch fallback: image is in server catalog but not cached locally.
      try {
        final api = SyncApi(baseUrl: settings.baseUrl, apiKey: settings.apiKey);
        try {
          final bytes = await api.fetchImage(_assemblyId);
          if (bytes != null && bytes.isNotEmpty) {
            await store.write(_assemblyId, bytes);
            final saved = await store.fileFor(_assemblyId);
            if (await saved.exists()) {
              imageFile = saved;
              if (meta.aspectRatio == null) {
                aspect = await _decodeAspect(saved) ?? 1.0;
              }
            }
          }
        } finally {
          api.dispose();
        }
      } catch (_) {
        // Network/offline failure: fall back to placeholder gracefully
      }
    }
    return _DiagramData(
      meta: meta,
      imageFile: imageFile,
      aspectRatio: aspect,
      dots: dots,
      fitmentAvailable: fitmentAvailable,
      order: order,
    );
  }

  Future<double?> _decodeAspect(File f) async {
    try {
      final codec = await ui.instantiateImageCodec(await f.readAsBytes());
      final frame = await codec.getNextFrame();
      final image = frame.image;
      final aspect = image.height == 0 ? null : image.width / image.height;
      image.dispose();
      return aspect;
    } catch (_) {
      return null;
    }
  }

  void _select(DiagramDot dot, {bool focus = false}) {
    setState(() {
      _selected = dot;
      if (focus) {
        _focusDot = dot;
        _focusTick++;
      }
    });
  }

  void _goTo(String assemblyId) {
    setState(() {
      _assemblyId = assemblyId;
      _selected = null;
      _focusDot = null;
      _future = _load(
        context.read<CatalogRepository>(),
        context.read<ImageStore>(),
        context.read<AppSettings>(),
      );
    });
  }

  void _openFitmentSheet(_DiagramData data) {
    showFitmentSheet(
      context,
      machineId: data.meta.machineId,
      machineLabel: data.meta.machineLabel,
    );
  }

  void _openPartsList(_DiagramData data, Fitment fitment) {
    // One row per position (a position can own several balloons of one ref).
    final seen = <String>{};
    final items = [
      for (final dot in data.dots)
        if (seen.add(dot.itemId)) dot,
    ]..sort((a, b) => compareRefNo(a.refNo, b.refNo));

    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheetContext) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.55,
        maxChildSize: 0.9,
        builder: (context, scrollController) => ListView.builder(
          controller: scrollController,
          itemCount: items.length,
          itemBuilder: (context, i) {
            final dot = items[i];
            final dimmed = fitment.isActive && !dot.appliesTo(fitment);
            final theme = Theme.of(context);
            // Dimmed (not-for-this-fitment) rows stay tappable so the clerk
            // can still inspect them.
            return ListTile(
              leading: CircleAvatar(
                backgroundColor: dot.itemId == _selected?.itemId
                    ? theme.colorScheme.error
                    : dimmed
                        ? theme.colorScheme.outline
                        : theme.colorScheme.primary,
                foregroundColor: Colors.white,
                child: Text(dot.refNo, style: const TextStyle(fontWeight: FontWeight.bold)),
              ),
              title: Text(
                dot.partName ?? 'Unnamed part',
                style: dimmed ? TextStyle(color: theme.colorScheme.outline) : null,
              ),
              subtitle: Text(
                _numbersSummary(dot, fitment),
                style: dimmed ? TextStyle(color: theme.colorScheme.outline) : null,
              ),
              onTap: () {
                Navigator.of(sheetContext).pop();
                _select(dot, focus: true);
              },
            );
          },
        ),
      ),
    );
  }

  /// Short subtitle for a parts-list row: the resolved number(s) that apply to
  /// the fitment (or the primary number when the position has no resolutions).
  String _numbersSummary(DiagramDot dot, Fitment fitment) {
    if (dot.resolutions.isEmpty) return dot.primaryNumber ?? 'No part number';
    final applicable = fitment.isActive
        ? dot.resolutions.where((r) => r.appliesTo(fitment)).toList()
        : dot.resolutions;
    if (applicable.isEmpty) return 'Not used on ${fitment.label}';
    final values = {
      for (final r in applicable)
        if (r.partNumberValue != null) r.partNumberValue!,
    };
    if (values.isEmpty) return 'No part number';
    return values.join(', ');
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<_DiagramData?>(
      future: _future,
      builder: (context, snap) {
        final data = snap.data;
        final title = data == null ? 'Diagram' : '${data.meta.code} · ${data.meta.name}';
        final fitment = data == null
            ? const Fitment()
            : context.watch<FitmentController>().fitmentFor(data.meta.machineId);
        return Scaffold(
          appBar: AppBar(
            title: Text(title),
            actions: [
              if (data != null && data.dots.isNotEmpty)
                IconButton(
                  tooltip: 'Parts list',
                  icon: const Icon(Icons.format_list_numbered),
                  onPressed: () => _openPartsList(data, fitment),
                ),
              if (data != null && data.fitmentAvailable)
                IconButton(
                  tooltip: "Customer's bike (variant / serial)",
                  icon: fitment.isActive
                      ? Badge(
                          backgroundColor: Theme.of(context).colorScheme.error,
                          smallSize: 8,
                          child: const Icon(Icons.filter_alt),
                        )
                      : const Icon(Icons.filter_alt_outlined),
                  onPressed: () => _openFitmentSheet(data),
                ),
            ],
          ),
          body: switch (snap.connectionState) {
            ConnectionState.done when data == null => const _Centered('Assembly not found.'),
            ConnectionState.done => _body(data!, fitment),
            _ => const Center(child: CircularProgressIndicator()),
          },
        );
      },
    );
  }

  Widget _body(_DiagramData data, Fitment fitment) {
    final dimmed = <String>{
      if (fitment.isActive)
        for (final dot in data.dots)
          if (!dot.appliesTo(fitment)) dot.itemId,
    };
    return Column(
      children: [
        if (fitment.isActive) _FitmentBanner(fitment: fitment, data: data),
        Expanded(
          child: data.imageFile == null
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.image_not_supported_outlined,
                          size: 48,
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                        const SizedBox(height: 12),
                        Text(
                          'No diagram image cached for “${data.meta.code}”.\nIt may not be uploaded yet, or sync hasn’t fetched it.',
                          textAlign: TextAlign.center,
                        ),
                        if (data.meta.hasImage) ...[
                          const SizedBox(height: 16),
                          FilledButton.tonalIcon(
                            icon: const Icon(Icons.download),
                            label: const Text('Download Diagram'),
                            onPressed: () {
                              setState(() {
                                _future = _load(
                                  context.read<CatalogRepository>(),
                                  context.read<ImageStore>(),
                                  context.read<AppSettings>(),
                                );
                              });
                            },
                          ),
                        ],
                      ],
                    ),
                  ),
                )
              : Padding(
                  padding: const EdgeInsets.all(8),
                  child: DiagramView(
                    key: ValueKey(_assemblyId),
                    image: data.imageFile!,
                    aspectRatio: data.aspectRatio,
                    dots: data.dots,
                    selectedItemId: _selected?.itemId,
                    dimmedItemIds: dimmed,
                    focusDot: _focusDot,
                    focusTick: _focusTick,
                    onTapDot: (d) => _select(d),
                  ),
                ),
        ),
        if (_selected != null)
          _SelectedItemCard(
            dot: _selected!,
            fitment: fitment,
            onClose: () => setState(() => _selected = null),
            onOpenPart: _selected!.basePartId == null
                ? null
                : () => Navigator.of(context).push(
                      MaterialPageRoute(
                        builder: (_) => PartDetailScreen(partId: _selected!.basePartId!),
                      ),
                    ),
          )
        else
          _PrevNextStrip(data: data, onGo: _goTo),
      ],
    );
  }
}

/// Thin bottom strip: previous / next assembly in catalog order. Hidden while
/// a part card is open (the card takes its place).
class _PrevNextStrip extends StatelessWidget {
  const _PrevNextStrip({required this.data, required this.onGo});

  final _DiagramData data;
  final ValueChanged<String> onGo;

  @override
  Widget build(BuildContext context) {
    final order = data.order;
    final index = order.indexOf(data.meta.id);
    if (order.length < 2 || index < 0) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Material(
      color: theme.colorScheme.surfaceContainerLow,
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            IconButton(
              tooltip: 'Previous diagram',
              icon: const Icon(Icons.chevron_left),
              onPressed: index > 0 ? () => onGo(order[index - 1]) : null,
            ),
            Expanded(
              child: Text(
                '${index + 1} / ${order.length}',
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
              ),
            ),
            IconButton(
              tooltip: 'Next diagram',
              icon: const Icon(Icons.chevron_right),
              onPressed: index < order.length - 1 ? () => onGo(order[index + 1]) : null,
            ),
          ],
        ),
      ),
    );
  }
}

/// Thin strip showing the active fitment; tap to edit, x to clear.
class _FitmentBanner extends StatelessWidget {
  const _FitmentBanner({required this.fitment, required this.data});

  final Fitment fitment;
  final _DiagramData data;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: theme.colorScheme.secondaryContainer,
      child: InkWell(
        onTap: () => showFitmentSheet(
          context,
          machineId: data.meta.machineId,
          machineLabel: data.meta.machineLabel,
        ),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 6, 4, 6),
          child: Row(
            children: [
              Icon(Icons.filter_alt, size: 16, color: theme.colorScheme.onSecondaryContainer),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Showing parts for ${fitment.label}',
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: theme.colorScheme.onSecondaryContainer),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              IconButton(
                icon: const Icon(Icons.close, size: 16),
                visualDensity: VisualDensity.compact,
                tooltip: 'Clear',
                onPressed: () =>
                    context.read<FitmentController>().clear(data.meta.machineId),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SelectedItemCard extends StatelessWidget {
  const _SelectedItemCard({
    required this.dot,
    required this.fitment,
    required this.onClose,
    this.onOpenPart,
  });

  final DiagramDot dot;
  final Fitment fitment;
  final VoidCallback onClose;

  /// Opens the canonical part's detail (all numbers, colors, aliases). Null
  /// when the position has no linked part.
  final VoidCallback? onOpenPart;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      elevation: 8,
      child: InkWell(
        onTap: onOpenPart,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 8, 16),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              CircleAvatar(
                backgroundColor: theme.colorScheme.error,
                foregroundColor: Colors.white,
                child: Text(dot.refNo, style: const TextStyle(fontWeight: FontWeight.bold)),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(dot.partName ?? 'Unnamed part', style: theme.textTheme.titleMedium),
                    const SizedBox(height: 2),
                    ..._numbers(theme),
                    if (onOpenPart != null) ...[
                      const SizedBox(height: 6),
                      Text(
                        'Tap for full detail',
                        style: theme.textTheme.bodySmall
                            ?.copyWith(color: theme.colorScheme.primary),
                      ),
                    ],
                  ],
                ),
              ),
              IconButton(icon: const Icon(Icons.close), onPressed: onClose, tooltip: 'Clear'),
            ],
          ),
        ),
      ),
    );
  }

  /// The position's part numbers. With resolutions we show the actual resolved
  /// number(s) + qty + applicability; an active fitment narrows to the
  /// applicable ones (or explains that none apply). Without resolutions, fall
  /// back to the base part's primary number.
  List<Widget> _numbers(ThemeData theme) {
    if (dot.resolutions.isEmpty) {
      return [
        Text(
          dot.primaryNumber ?? 'No part number',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
      ];
    }

    final applicable =
        fitment.isActive ? dot.resolutions.where((r) => r.appliesTo(fitment)).toList() : dot.resolutions;

    if (applicable.isEmpty) {
      // Fitment active and nothing matches: say so, then list what it fits.
      return [
        Text(
          'Not used on ${fitment.label}',
          style: theme.textTheme.bodyMedium
              ?.copyWith(color: theme.colorScheme.error, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 2),
        for (final r in dot.resolutions) _resolutionLine(theme, r, dimmed: true),
      ];
    }
    return [
      for (final r in applicable)
        _resolutionLine(theme, r, dimmed: false, showLabel: !fitment.isActive || applicable.length > 1),
    ];
  }

  Widget _resolutionLine(ThemeData theme, ItemResolutionView r,
      {required bool dimmed, bool showLabel = true}) {
    final color = dimmed ? theme.colorScheme.outline : theme.colorScheme.onSurfaceVariant;
    final label = r.label;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: r.partNumberValue ?? 'No part number',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: dimmed ? theme.colorScheme.outline : theme.colorScheme.onSurface,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
            if (r.qty != 1)
              TextSpan(
                text: '  ×${r.qty}',
                style: theme.textTheme.bodySmall?.copyWith(color: color),
              ),
            if (showLabel && label != null)
              TextSpan(
                text: '  $label',
                style: theme.textTheme.bodySmall?.copyWith(color: color),
              ),
          ],
        ),
      ),
    );
  }
}

class _Centered extends StatelessWidget {
  const _Centered(this.text, {this.icon});
  final String text;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(icon, size: 48, color: Theme.of(context).colorScheme.onSurfaceVariant),
              const SizedBox(height: 12),
            ],
            Text(text, textAlign: TextAlign.center),
          ],
        ),
      ),
    );
  }
}
