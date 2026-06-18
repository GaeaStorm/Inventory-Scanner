# Catalog, Tally history, and bulk Material In (v12)

This patch makes three focused improvements to the Electron desktop application.

## QR Creator catalog

The Stores Catalog stays inside a fixed-height card and scrolls independently of the rest of the QR Creator. Filters are available for:

- Tally Stock Item group
- Available versus zero stock
- Items with or without a BOM
- Free-text item search

The filter values come from the synchronized Tally Stock Items rather than a hard-coded list.

## Complete Tally voucher-history scan

The Tally Syncer includes a **Complete voucher-history scan** option. When enabled, the client reads voucher history in one-year ranges from the configured history start date through today. It examines voucher types and inventory lines so custom voucher names derived from Receipt Note, Purchase Order, or Purchase can be recognized.

The scan is broad for discovery, but the Local Stores Database only persists stores-relevant records:

- Stock Items and BOM relationships
- Supplier ledgers
- Purchase Orders and their inventory lines
- Receipt Notes / GRNs and their inventory lines
- Purchase voucher lines used to fill missing receipt rates

The sync summary reports the number of vouchers scanned, inventory vouchers scanned, Receipt Notes detected, and the voucher-type names found. This diagnostic information is intended to explain why a company-specific GRN type was or was not recognized.

If a previous cutover created Opening Legacy Stock because no historical GRNs were found, a later successful history scan will not double-count stock:

- With no local movements yet, the application rebuilds supplier attribution from the discovered GRNs while preserving the current total quantity.
- After local movements exist, discovered historical lots are retained with zero available quantity and the application raises a reconciliation warning for manual review.

## Bulk Material In

The Inventory Tracker now starts with a desktop **Vendor Material In** form for larger deliveries. It follows the physical Receipt Note / GRN workflow rather than creating a Purchase Voucher.

The form supports:

- Supplier selection
- Open Purchase Order selection
- Challan number and date
- Receipt date
- All outstanding lines from a selected Purchase Order
- Whole-number quantity entry for multiple Stock Items
- A clearly marked non-PO exception workflow

Saving a receipt creates one local GRN with multiple lines, corresponding purchase lots, inventory movements, FIFO-ready quantities, and one pending Tally review entry. Repeated submission with the same client transaction ID is idempotent.

## Database migration

Schema version 2 adds a stable `client_transaction_id` to GRNs. The migration system creates a validated SQLite backup before upgrading an existing database.

## Important boundary

This patch still does not directly post into Tally. It prepares local review entries. The final Material Out XML adapter remains intentionally unconfigured until sample Production and Servicing Material Out vouchers are available.
