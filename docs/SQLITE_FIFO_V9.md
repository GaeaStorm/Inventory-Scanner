# SQLite, FIFO, and Tally export foundation (v9)

This patch moves Inventory Scanner from an Excel-first logger to a Local Stores Database while preserving Excel as a review and audit format.

## Operational model

SQLite is authoritative for:

- synchronized Tally Stock Items and GUIDs;
- suppliers, Purchase Orders, GRNs, and reconstructed Purchase Lots;
- boxes and their one-to-five Stock Item relationships;
- vendor receipts, Material Out, and unused-material returns;
- supplier-aware FIFO allocations;
- daily Material Out groupings;
- review decisions, export batches, and import references;
- synchronization and correction audit history.

Every multi-record operation runs in a SQLite transaction. A failed FIFO allocation, invalid receipt, or export-queue update rolls back the whole operation.

## FIFO cutover

On the first successful historical synchronization:

1. Historical Tally GRNs are imported.
2. Purchase Lots are created.
3. Tally closing count is compared with reconstructable GRN quantity.
4. Remaining unmatched count is assigned to Opening Legacy Stock.
5. Oldest remaining Purchase Lots are consumed first by Material Out.

FIFO is ordered by receipt date, source voucher date, and stable local database ID. It is calculated per Stock Item only; there is no godown or batch partition.

## Stores workflows

### Vendor Material In

The operator selects a synchronized supplier and, normally, an open Purchase Order. Challan number, challan date, and whole-number received quantity are required. The application creates a local GRN, Purchase Lot, movement, and pending Tally export entry atomically.

A non-PO receipt is allowed only as an explicit review exception.

### Material Out

The operator scans a box, chooses one Stock Item, selects a destination product from synchronized Tally Stock Items, and enters a positive whole-number count. Supplier and rate are inferred through FIFO; insufficient local stock is blocked.

Phone scans for the same issued item, destination product, and business date accumulate into one pending daily Material Out group while remaining separately auditable.

### Return Unused Material

A same-day unused return reduces the matching pending Material Out group and restores the most recently consumed FIFO allocations first. It remains a separate audit event but does not create an additional Tally voucher.

Returns against already exported/confirmed groups are placed in the exception queue.

## Review and export

The Chief of Staff can approve, reject, or return entries for correction. Approved GRNs generate:

- a human-readable Excel workbook;
- optional CSV;
- Tally import XML.

The workbook includes Summary, GRNs, Material Out, FIFO Allocations, Opening Legacy Stock, Exceptions, and Source Transactions sheets.

Material Out XML is intentionally blocked until two manually created sample vouchers—Production and Servicing—are available. Approved Material Out groups remain in the queue and are not marked exported while the adapter is unconfigured.

## Applying the patch

```bash
pnpm install
rm -rf artifacts/desktop-app/dist
pnpm desktop:dev
```

The new `xlsx` dependency is used only to generate review workbooks. CSV generation uses the built-in exporter.

## Verification checklist

1. Test the Tally connection and select the company.
2. Choose a historical start date and synchronize.
3. Review Opening Legacy Stock warnings and local/Tally differences.
4. Create or revise a box using only synchronized Stock Items.
5. Scan the box and test Vendor Material In.
6. Test Material Out and confirm FIFO lot balances reduce.
7. Test a same-day unused return and confirm the daily group and lot balances reverse.
8. Approve a GRN and generate Excel, CSV, and XML.
9. Confirm Material Out remains queued until its adapter is mapped.
10. Create and validate a manual SQLite backup from Settings.
