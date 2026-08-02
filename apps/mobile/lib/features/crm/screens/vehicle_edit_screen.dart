import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../../core/db/app_database.dart';
import '../data/customer_repository.dart';
import '../data/vehicle_repository.dart';
import 'customer_search_screen.dart';
import 'machine_search_screen.dart';

/// Screen for creating or editing a vehicle.
class VehicleEditScreen extends StatefulWidget {
  const VehicleEditScreen({super.key, this.vehicleId, this.customerId});

  final String? vehicleId;
  final String? customerId;

  @override
  State<VehicleEditScreen> createState() => _VehicleEditScreenState();
}

class _VehicleEditScreenState extends State<VehicleEditScreen> {
  final _formKey = GlobalKey<FormState>();
  late TextEditingController _licensePlateController;
  late TextEditingController _frameNumberController;
  late TextEditingController _nicknameController;
  late TextEditingController _yearController;
  late TextEditingController _notesController;

  String? _selectedCustomerId;
  String? _selectedCustomerName;
  String? _selectedMachineId;
  String? _selectedMachineName;
  String? _selectedColorId;

  @override
  void initState() {
    super.initState();
    _licensePlateController = TextEditingController();
    _frameNumberController = TextEditingController();
    _nicknameController = TextEditingController();
    _yearController = TextEditingController();
    _notesController = TextEditingController();

    _selectedCustomerId = widget.customerId;

    if (widget.vehicleId != null) {
      _loadVehicle();
    }
  }

  @override
  void dispose() {
    _licensePlateController.dispose();
    _frameNumberController.dispose();
    _nicknameController.dispose();
    _yearController.dispose();
    _notesController.dispose();
    super.dispose();
  }

  Future<void> _loadVehicle() async {
    final db = Provider.of<AppDatabase>(context, listen: false);
    final repository = VehicleRepository(db);
    final vehicle = await repository.getVehicle(widget.vehicleId!);

    if (vehicle != null && mounted) {
      final customer = await CustomerRepository(db).getCustomer(vehicle.customerId);
      final machine = await (db.select(db.machines)..where((m) => m.id.equals(vehicle.machineId))).getSingleOrNull();

      if (mounted) {
        setState(() {
          _selectedCustomerId = vehicle.customerId;
          _selectedCustomerName = customer?.name;
          _selectedMachineId = vehicle.machineId;
          _selectedMachineName = machine == null ? null : '${machine.brand} ${machine.model}';
          _selectedColorId = vehicle.colorId;
          _licensePlateController.text = vehicle.licensePlate ?? '';
          _frameNumberController.text = vehicle.frameNumber ?? '';
          _nicknameController.text = vehicle.nickname ?? '';
          _yearController.text = vehicle.year?.toString() ?? '';
          _notesController.text = vehicle.notes ?? '';
        });
      }
    }
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    if (_selectedCustomerId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please select a customer')),
      );
      return;
    }
    if (_selectedMachineId == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please select a machine')),
      );
      return;
    }

    final db = Provider.of<AppDatabase>(context, listen: false);
    final repository = VehicleRepository(db);

    final vehicleId = widget.vehicleId != null
        ? await repository.updateVehicle(
            id: widget.vehicleId!,
            customerId: _selectedCustomerId!,
            machineId: _selectedMachineId!,
            licensePlate: _licensePlateController.text.isEmpty ? null : _licensePlateController.text,
            frameNumber: _frameNumberController.text.isEmpty ? null : _frameNumberController.text,
            colorId: _selectedColorId,
            year: _yearController.text.isEmpty ? null : int.parse(_yearController.text),
            nickname: _nicknameController.text.isEmpty ? null : _nicknameController.text,
            notes: _notesController.text.isEmpty ? null : _notesController.text,
          )
        : await repository.createVehicle(
            customerId: _selectedCustomerId!,
            machineId: _selectedMachineId!,
            licensePlate: _licensePlateController.text.isEmpty ? null : _licensePlateController.text,
            frameNumber: _frameNumberController.text.isEmpty ? null : _frameNumberController.text,
            colorId: _selectedColorId,
            year: _yearController.text.isEmpty ? null : int.parse(_yearController.text),
            nickname: _nicknameController.text.isEmpty ? null : _nicknameController.text,
            notes: _notesController.text.isEmpty ? null : _notesController.text,
          );

    if (vehicleId != null && mounted) {
      Navigator.pop(context, vehicleId);
    }
  }

  Future<void> _selectCustomer() async {
    final result = await Navigator.push<String?>(context, MaterialPageRoute(
      builder: (context) => const CustomerSearchScreen(),
    ));
    
    if (result != null && mounted) {
      final db = Provider.of<AppDatabase>(context, listen: false);
      final customer = await CustomerRepository(db).getCustomer(result);
      if (mounted) {
        setState(() {
          _selectedCustomerId = result;
          _selectedCustomerName = customer?.name;
        });
      }
    }
  }

  Future<void> _selectMachine() async {
    final result = await Navigator.push<String?>(context, MaterialPageRoute(
      builder: (context) => const MachineSearchScreen(),
    ));
    
    if (result != null && mounted) {
      final db = Provider.of<AppDatabase>(context, listen: false);
      final machine = await (db.select(db.machines)..where((m) => m.id.equals(result))).getSingleOrNull();
      if (mounted) {
        setState(() {
          _selectedMachineId = result;
          _selectedMachineName = machine == null ? null : '${machine.brand} ${machine.model}';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final isEditing = widget.vehicleId != null;

    return Scaffold(
      appBar: AppBar(
        title: Text(isEditing ? 'Edit Vehicle' : 'New Vehicle'),
        actions: [
          if (isEditing)
            IconButton(
              icon: const Icon(Icons.delete),
              onPressed: () async {
                final confirm = await showDialog<bool>(
                  context: context,
                  builder: (context) => AlertDialog(
                    title: const Text('Delete Vehicle'),
                    content: const Text('Are you sure you want to delete this vehicle? This action cannot be undone.'),
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
                  final repository = VehicleRepository(db);
                  await repository.deleteVehicle(widget.vehicleId!);
                  if (mounted) {
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
              // Customer selection
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _selectCustomer,
                      child: Text(
                        _selectedCustomerId == null 
                          ? 'Select Customer' 
                          : 'Customer: ${_selectedCustomerName ?? _selectedCustomerId}',
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              
              // Machine selection
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _selectMachine,
                      child: Text(
                        _selectedMachineId == null 
                          ? 'Select Machine' 
                          : 'Machine: ${_selectedMachineName ?? _selectedMachineId}',
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              
              TextFormField(
                controller: _licensePlateController,
                decoration: const InputDecoration(labelText: 'License Plate'),
              ),
              const SizedBox(height: 16),
              
              TextFormField(
                controller: _frameNumberController,
                decoration: const InputDecoration(labelText: 'Frame Number'),
              ),
              const SizedBox(height: 16),
              
              TextFormField(
                controller: _nicknameController,
                decoration: const InputDecoration(labelText: 'Nickname'),
              ),
              const SizedBox(height: 16),
              
              TextFormField(
                controller: _yearController,
                decoration: const InputDecoration(labelText: 'Year'),
                keyboardType: TextInputType.number,
              ),
              const SizedBox(height: 16),
              
              TextFormField(
                controller: _notesController,
                decoration: const InputDecoration(labelText: 'Notes'),
                maxLines: 3,
              ),
              const SizedBox(height: 24),
              
              FilledButton(
                onPressed: _save,
                child: const Text('Save Vehicle'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
