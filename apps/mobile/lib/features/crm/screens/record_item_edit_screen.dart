import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../../core/db/app_database.dart';
import '../../sync/sync_controller.dart';
import '../data/record_item_repository.dart';
import '../crm.dart';

/// Screen for creating or editing a maintenance record item.
class RecordItemEditScreen extends StatefulWidget {
  const RecordItemEditScreen({super.key, this.itemId, required this.recordId});

  final String? itemId;
  final String recordId;

  @override
  State<RecordItemEditScreen> createState() => _RecordItemEditScreenState();
}

class _RecordItemEditScreenState extends State<RecordItemEditScreen> {
  final _formKey = GlobalKey<FormState>();
  late String _category;
  late TextEditingController _brandController;
  late TextEditingController _partNumberController;
  late TextEditingController _quantityController;
  late TextEditingController _unitPriceController;
  late TextEditingController _notesController;

  bool _hasWarranty = false;
  late TextEditingController _warrantyPeriodValueController;
  String _warrantyPeriodUnit = 'months';
  DateTime? _warrantyStartDate;
  late TextEditingController _warrantyNotesController;

  @override
  void initState() {
    super.initState();
    _category = kMaintenanceItemCategories.first;
    _brandController = TextEditingController();
    _partNumberController = TextEditingController();
    _quantityController = TextEditingController(text: '1');
    _unitPriceController = TextEditingController();
    _notesController = TextEditingController();
    _warrantyPeriodValueController = TextEditingController();
    _warrantyNotesController = TextEditingController();

    if (widget.itemId != null) {
      _loadItem();
    }
  }

  @override
  void dispose() {
    _brandController.dispose();
    _partNumberController.dispose();
    _quantityController.dispose();
    _unitPriceController.dispose();
    _notesController.dispose();
    _warrantyPeriodValueController.dispose();
    _warrantyNotesController.dispose();
    super.dispose();
  }

  Future<void> _loadItem() async {
    final db = Provider.of<AppDatabase>(context, listen: false);
    final repository = RecordItemRepository(db);
    final item = await repository.getItem(widget.itemId!);

    if (item != null && mounted) {
      setState(() {
        _category = item.category;
        _brandController.text = item.brand ?? '';
        _partNumberController.text = item.partNumber ?? '';
        _quantityController.text = item.quantity.toString();
        _unitPriceController.text = item.unitPrice?.toString() ?? '';
        _notesController.text = item.notes ?? '';
        _hasWarranty = item.hasWarranty;
        _warrantyPeriodValueController.text = item.warrantyPeriodValue?.toString() ?? '';
        _warrantyPeriodUnit = item.warrantyPeriodUnit ?? 'months';
        _warrantyStartDate = item.warrantyStartDate != null 
            ? DateTime.fromMillisecondsSinceEpoch(item.warrantyStartDate!) 
            : null;
        _warrantyNotesController.text = item.warrantyNotes ?? '';
      });
    }
  }

  Future<void> _selectWarrantyStartDate() async {
    final pickedDate = await showDatePicker(
      context: context,
      initialDate: _warrantyStartDate ?? DateTime.now(),
      firstDate: DateTime(2000),
      lastDate: DateTime(2100),
    );

    if (pickedDate != null && mounted) {
      setState(() {
        _warrantyStartDate = pickedDate;
      });
    }
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;

    final db = Provider.of<AppDatabase>(context, listen: false);
    final repository = RecordItemRepository(db);

    final String? resultId;
    if (widget.itemId != null) {
      final ok = await repository.updateItem(
        id: widget.itemId!,
        category: _category,
        partNumber: _partNumberController.text.isEmpty ? null : _partNumberController.text,
        brand: _brandController.text.isEmpty ? null : _brandController.text,
        quantity: int.parse(_quantityController.text),
        hasWarranty: _hasWarranty,
        warrantyPeriodValue: _warrantyPeriodValueController.text.isEmpty 
            ? null 
            : int.parse(_warrantyPeriodValueController.text),
        warrantyPeriodUnit: _warrantyPeriodUnit,
        warrantyStartDate: _warrantyStartDate,
        warrantyNotes: _warrantyNotesController.text.isEmpty ? null : _warrantyNotesController.text,
        unitPrice: _unitPriceController.text.isEmpty ? null : int.parse(_unitPriceController.text),
        notes: _notesController.text.isEmpty ? null : _notesController.text,
      );
      resultId = ok ? widget.itemId : null;
    } else {
      resultId = await repository.createItem(
        maintenanceRecordId: widget.recordId,
        category: _category,
        partNumber: _partNumberController.text.isEmpty ? null : _partNumberController.text,
        brand: _brandController.text.isEmpty ? null : _brandController.text,
        quantity: int.parse(_quantityController.text),
        hasWarranty: _hasWarranty,
        warrantyPeriodValue: _warrantyPeriodValueController.text.isEmpty 
            ? null 
            : int.parse(_warrantyPeriodValueController.text),
        warrantyPeriodUnit: _warrantyPeriodUnit,
        warrantyStartDate: _warrantyStartDate,
        warrantyNotes: _warrantyNotesController.text.isEmpty ? null : _warrantyNotesController.text,
        unitPrice: _unitPriceController.text.isEmpty ? null : int.parse(_unitPriceController.text),
        notes: _notesController.text.isEmpty ? null : _notesController.text,
      );
    }

    if (resultId != null && mounted) {
      final sync = Provider.of<SyncController>(context, listen: false);
      void syncFuture = sync.syncNow();
      Navigator.pop(context, resultId);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isEditing = widget.itemId != null;

    return Scaffold(
      appBar: AppBar(
        title: Text(isEditing ? 'Edit Item' : 'Add Item'),
        actions: [
          if (isEditing)
            IconButton(
              icon: const Icon(Icons.delete),
              onPressed: () async {
                final confirm = await showDialog<bool>(
                  context: context,
                  builder: (context) => AlertDialog(
                    title: const Text('Delete Item'),
                    content: const Text('Are you sure you want to delete this item?'),
                    actions: [
                      TextButton(
                        onPressed: () => Navigator.pop(context, false),
                        child: const Text('Cancel'),
                      ),
                      TextButton(
                        onPressed: () => Navigator.pop(context, true),
                        style: TextButton.styleFrom(foregroundColor: Colors.red),
                        child: const Text('Delete'),
                      ),
                    ],
                  ),
                );

                if (confirm == true && mounted) {
                  final db = Provider.of<AppDatabase>(context, listen: false);
                  final repository = RecordItemRepository(db);
                  await repository.deleteItem(widget.itemId!);
                  if (mounted) {
                    final sync = Provider.of<SyncController>(context, listen: false);
                    void syncFuture = sync.syncNow();
                    Navigator.pop(context, 'deleted');
                  }
                }
              },
            ),
          IconButton(
            icon: const Icon(Icons.save),
            onPressed: _save,
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Category selection
              DropdownButtonFormField<String>(
                value: _category,
                items: kMaintenanceItemCategories.map((category) => DropdownMenuItem(
                  value: category,
                  child: Text(category.replaceAll('_', ' ').capitalize()),
                )).toList(),
                onChanged: (value) => setState(() => _category = value!),
                decoration: const InputDecoration(labelText: 'Category *'),
                validator: (value) => value == null ? 'Category is required' : null,
              ),
              const SizedBox(height: 16),

              // Brand
              TextFormField(
                controller: _brandController,
                decoration: const InputDecoration(labelText: 'Brand'),
              ),
              const SizedBox(height: 16),

              // Part number
              TextFormField(
                controller: _partNumberController,
                decoration: const InputDecoration(labelText: 'Part Number'),
              ),
              const SizedBox(height: 16),

              // Quantity
              TextFormField(
                controller: _quantityController,
                decoration: const InputDecoration(labelText: 'Quantity'),
                keyboardType: TextInputType.number,
                validator: (value) {
                  if (value?.isEmpty ?? true) return 'Quantity is required';
                  final qty = int.tryParse(value!);
                  if (qty == null || qty <= 0) return 'Please enter a valid quantity';
                  return null;
                },
              ),
              const SizedBox(height: 16),

              // Unit price
              TextFormField(
                controller: _unitPriceController,
                decoration: const InputDecoration(labelText: 'Unit Price (IDR)'),
                keyboardType: TextInputType.number,
              ),
              const SizedBox(height: 16),

              // Warranty section
              Padding(
                padding: const EdgeInsets.only(top: 8, bottom: 4),
                child: Text('WARRANTY', style: TextStyle(color: Colors.grey, fontWeight: FontWeight.bold, fontSize: 12)),
              ),
              const Divider(),
              const SizedBox(height: 8),
              
              SwitchListTile(
                title: const Text('Has Warranty'),
                value: _hasWarranty,
                onChanged: (value) => setState(() => _hasWarranty = value),
              ),
              
              if (_hasWarranty) ...[
                Row(
                  children: [
                    Expanded(
                      child: TextFormField(
                        controller: _warrantyPeriodValueController,
                        decoration: const InputDecoration(labelText: 'Period Value'),
                        keyboardType: TextInputType.number,
                        validator: (value) {
                          if (_hasWarranty && (value?.isEmpty ?? true)) {
                            return 'Period value is required when warranty is enabled';
                          }
                          return null;
                        },
                      ),
                    ),
                    const SizedBox(width: 8),
                    DropdownButton<String>(
                      value: _warrantyPeriodUnit,
                      items: kWarrantyPeriodUnits.map((unit) => DropdownMenuItem(
                        value: unit,
                        child: Text(unit.capitalize()),
                      )).toList(),
                      onChanged: (value) => setState(() => _warrantyPeriodUnit = value!),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: _selectWarrantyStartDate,
                        child: Text(
                          _warrantyStartDate != null 
                            ? '${_warrantyStartDate!.year}-${_warrantyStartDate!.month.toString().padLeft(2, '0')}-${_warrantyStartDate!.day.toString().padLeft(2, '0')}'
                            : 'Select Start Date',
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                
                TextFormField(
                  controller: _warrantyNotesController,
                  decoration: const InputDecoration(labelText: 'Warranty Notes'),
                  maxLines: 2,
                ),
                const SizedBox(height: 16),
              ],
              
              // Notes
              TextFormField(
                controller: _notesController,
                decoration: const InputDecoration(labelText: 'Notes'),
                maxLines: 3,
              ),
              const SizedBox(height: 24),

              FilledButton(
                onPressed: _save,
                child: const Text('Save Item'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// Extension for string capitalization
extension on String {
  String capitalize() => isNotEmpty ? '${this[0].toUpperCase()}${substring(1)}' : this;
}

// Helper extension for better display
extension StringExtensions on String {
  String replaceAllUnderscores() => replaceAll('_', ' ');
}

