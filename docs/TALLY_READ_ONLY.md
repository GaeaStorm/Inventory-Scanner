# Read-only Tally stores synchronization

Inventory Scanner reads only the Tally information required for stores operations. The connection uses Tally's HTTP/XML export interface and never posts vouchers or modifies masters during synchronization.

## Company assumptions

- TallyPrime Gold 7.0.
- Quantities are whole-number counts.
- Godowns, batches, and unit conversions are not used by this workflow.
- Stock Item names remain the visible identifiers; Tally GUIDs are retained internally.
- Purchase Orders precede vendor receipt.
- Stores prepares Receipt Notes/GRNs; Accounts records Purchase Vouchers separately.

## Data read from Tally

- loaded companies;
- Stock Items and GUIDs;
- BOM/component relationships where available;
- supplier ledgers under Sundry Creditors;
- Purchase Orders and inventory lines;
- Receipt Notes/GRNs and inventory lines;
- Purchase voucher inventory lines only when needed to complete supplier/rate history.

The sync intentionally excludes unrelated accounting, banking, payroll, tax-return, receivable, and payable data.

## Local Stores Database

The operational source of truth is:

```text
<Electron userData>/data/inventory-scanner.sqlite
```

The first successful historical sync reconstructs Purchase Lots from GRNs. It compares those reconstructed lots with Tally's current Stock Item quantities. Any count that cannot be connected to historical GRNs becomes an **Opening Legacy Stock** lot at the cutover date.

Subsequent successful syncs add newly observed GRNs without rebuilding previously used local FIFO history.

## Read-only boundary

Every request made by the synchronization client uses Tally `EXPORT` requests. Direct posting is deliberately outside this version. Stores transactions are prepared in the local Tally Export Queue for review and manual end-of-day import.
