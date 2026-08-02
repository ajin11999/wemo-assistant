import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../../core/db/app_database.dart' hide Color, Colors;
import '../data/record_repository.dart';
import 'record_edit_screen.dart';
import 'record_item_edit_screen.dart';

/// Screen that shows maintenance record details and its items.
class RecordDetailScreen extends StatefulWidget {
  const RecordDetailScreen({super.key, required this.recordId});

  final String recordId;

  @override
  State<RecordDetailScreen> createState() => _RecordDetailScreenState();
}

class _RecordDetailScreenState extends State<RecordDetailScreen> {
  @override
  Widget build(BuildContext context) {
    final db = Provider.of<AppDatabase>(context);
    final recordRepo = RecordRepository(db);

    return FutureBuilder<({
      MaintenanceRecord record,
      Customer? customer,
      CustomerVehicle? vehicle,
      List<MaintenanceItem> items
    })?>(
      future: recordRepo.getRecordFull(widget.recordId),
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Scaffold(
            body: Center(child: CircularProgressIndicator()),
          );
        }

        if (snapshot.hasError) {
          return Scaffold(
            appBar: AppBar(title: const Text('Error')),
            body: Center(child: Text('Error: ${snapshot.error}')),
          );
        }

        final data = snapshot.data;
        if (data == null) {
          return Scaffold(
            appBar: AppBar(title: const Text('Not Found')),
            body: const Center(child: Text('Record not found')),
          );
        }

        final record = data.record;
        final customer = data.customer;
        final vehicle = data.vehicle;
        final items = data.items;

        return Scaffold(
          appBar: AppBar(
            title: const Text('Record Details'),
            actions: [
              if (customer != null)
                IconButton(
                  icon: const Icon(Icons.edit),
                  onPressed: () {
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (context) => RecordEditScreen(
                          recordId: widget.recordId,
                          customerId: customer.id,
                          vehicleId: vehicle?.id,
                        ),
                      ),
                    ).then((value) {
                      if (value == 'deleted') {
                        Navigator.pop(context);
                      } else {
                        // Refresh the screen when returning
                        setState(() {});
                      }
                    });
                  },
                )
              else
                IconButton(
                  icon: const Icon(Icons.edit),
                  onPressed: () {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Cannot edit record without customer info')),
                    );
                  },
                ),
            ],
          ),
          body: CustomScrollView(
            slivers: [
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // Record info card
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              // Record type and date
                              Row(
                                children: [
                                  Chip(
                                    label: Text(record.type.capitalize()),
                                    backgroundColor: record.type == 'service'
                                        ? Colors.blue.withOpacity(0.2)
                                        : Colors.green.withOpacity(0.2),
                                  ),
                                  const SizedBox(width: 8),
                                  Text(
                                    _formatDate(record.date),
                                    style: Theme.of(context).textTheme.titleMedium,
                                  ),
                                ],
                              ),
                              const SizedBox(height: 8),
                              
                              // Description
                              Text(
                                record.description,
                                style: Theme.of(context).textTheme.titleLarge,
                              ),
                              const SizedBox(height: 8),
                              
                              // Customer info
                              if (customer != null) ...[
                                Text('Customer: ${customer.name}'),
                                if (customer.phone != null) Text('Phone: ${customer.phone}'),
                                const SizedBox(height: 4),
                              ],
                              
                              // Vehicle info
                              if (vehicle != null) ...[
                                Text('Vehicle: ${vehicle.nickname ?? vehicle.licensePlate ?? vehicle.id}'),
                                const SizedBox(height: 4),
                              ],
                              
                              // Invoice and amount
                              if (record.invoiceNumber != null) Text('Invoice: ${record.invoiceNumber}'),
                              if (record.totalAmount != null) Text('Total: IDR ${record.totalAmount}'),
                              
                              // Notes
                              if (record.notes != null && record.notes!.isNotEmpty)
                                Padding(
                                  padding: const EdgeInsets.only(top: 8),
                                  child: Text('Notes: ${record.notes}'),
                                ),
                            ],
                          ),
                        ),
                      ),
                      const SizedBox(height: 24),
                      
                      // Items section
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text('Items (${items.length})', style: Theme.of(context).textTheme.titleMedium),
                          FilledButton.icon(
                            icon: const Icon(Icons.add, size: 16),
                            label: const Text('Add Item'),
                            onPressed: () => Navigator.push(
                              context,
                              MaterialPageRoute(
                                builder: (context) => RecordItemEditScreen(recordId: widget.recordId),
                              ),
                            ).then((_) {
                              setState(() {});
                            }),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                    ],
                  ),
                ),
              ),
              
              // Items list
              items.isEmpty
                  ? const SliverToBoxAdapter(
                      child: Padding(
                        padding: EdgeInsets.all(16),
                        child: Text('No items in this record.'),
                      ),
                    )
                  : SliverList(
                      delegate: SliverChildBuilderDelegate(
                        (context, index) {
                          final item = items[index];
                          return _buildItemCard(context, item);
                        },
                        childCount: items.length,
                      ),
                    ),
              
              const SliverToBoxAdapter(child: SizedBox(height: 16)),
            ],
          ),
        );
      },
    );
  }

  Widget _buildItemCard(BuildContext context, MaintenanceItem item) {
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      child: InkWell(
        onTap: () => Navigator.push(
          context,
          MaterialPageRoute(
            builder: (context) => RecordItemEditScreen(
              itemId: item.id,
              recordId: item.maintenanceRecordId,
            ),
          ),
        ).then((_) {
          // Refresh after editing/deleting an item
          // To access setState, we could pass it or rely on the parent FutureBuilder rebuilding,
          // but _buildItemCard is a method of _RecordDetailScreenState so we can just call setState.
          setState(() {});
        }),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Text(
                    item.brand != null ? '${item.category}: ${item.brand}' : item.category,
                    style: Theme.of(context).textTheme.bodyLarge,
                  ),
                ),
                if (item.hasWarranty == true && item.warrantyExpiryDate != null)
                  _buildWarrantyBadge(context, item.warrantyExpiryDate!),
              ],
            ),
            const SizedBox(height: 4),
            
            // Part number
            if (item.partNumber != null) Text('Part: ${item.partNumber}', style: const TextStyle(fontSize: 12)),
            
            // Quantity and price
            Row(
              children: [
                if (item.quantity > 1) Text('Qty: ${item.quantity}'),
                if (item.quantity > 1 && item.unitPrice != null) const SizedBox(width: 16),
                if (item.unitPrice != null) Text('Price: IDR ${item.unitPrice}'),
              ],
            ),
            
            // Warranty details
            if (item.hasWarranty == true) ...[
              const SizedBox(height: 4),
              Text(
                'Warranty: ${item.warrantyPeriodValue}${item.warrantyPeriodUnit == 'months' ? ' months' : ' days'}',
                style: const TextStyle(fontSize: 12, color: Colors.green),
              ),
              if (item.warrantyNotes != null) Text(item.warrantyNotes!, style: const TextStyle(fontSize: 12)),
            ],
            
            // Notes
            if (item.notes != null && item.notes!.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(item.notes!, style: const TextStyle(fontSize: 12)),
              ),
          ],
        ),
      ),
    ),
  );
  }

  Widget _buildWarrantyBadge(BuildContext context, int expiryDateMs) {
    final expiryDate = DateTime.fromMillisecondsSinceEpoch(expiryDateMs);
    final now = DateTime.now();
    final daysLeft = expiryDate.difference(now).inDays;
    
    Color color;
    String text;
    
    if (expiryDate.isBefore(now)) {
      color = Colors.red;
      text = 'EXPIRED';
    } else if (daysLeft <= 7) {
      color = Colors.orange;
      text = '$daysLeft days';
    } else if (daysLeft <= 30) {
      color = Colors.blue;
      text = '$daysLeft days';
    } else {
      color = Colors.green;
      text = 'Active';
    }
    
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withOpacity(0.2),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        text,
        style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.bold),
      ),
    );
  }

  String _formatDate(int? timestampMs) {
    if (timestampMs == null) return 'N/A';
    final date = DateTime.fromMillisecondsSinceEpoch(timestampMs);
    return '${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';
  }
}

// Extension for string capitalization
extension on String {
  String capitalize() => isNotEmpty ? '${this[0].toUpperCase()}${substring(1)}' : this;
}
