# Inventory Scanner v3 — Planning and Restock Action Center

This version adds a local production-planning layer without changing the accounting boundary:

- SQLite remains the operational source for stores and planning.
- Tally remains the company master for Stock Items, suppliers, Purchase Orders, GRNs, and approved accounting imports.
- Production-critical phone movements remain offline-capable.
- Planning can continue from cached/local data when Tally or the public internet is unavailable.

## Inventory Dashboard sections

### Action Center

Classifies Stock Items as Critical, Reorder Now, Reorder Soon, Healthy, Excess, or Unconfigured.

Planning availability is calculated as:

```
Available = On hand - Product reservations - Service reserve
Projected = Available + Open Purchase Order quantity
Suggested order = max(0, Target stock - Projected)
```

Approved recommendations can be exported as a versioned Excel workbook and optional CSV. The `Tally Reorder Import` sheet is intended for TallyPrime's user-defined Excel mapping process. This version does not directly alter Tally masters.

### Stock Planning

Shows on-hand, reserved, service-reserve, available, incoming, and projected quantities. The existing proven-opening-count workflow remains available here.

### Product Definitions

Supports:

- imported Tally BOMs;
- manual BOM versions;
- Excel/CSV BOM upload;
- exact Stock Item name matching;
- per-component whole-number quantities;
- per-component manufacturing-loss buffers;
- active, draft, and archived versions.

Existing product orders retain the BOM version used when they were created.

### Product Orders

Supports manual entry and spreadsheet import. Confirmed orders create local component reservations and show:

- Ready;
- Ready with incoming stock;
- At risk;
- Short components;
- BOM incomplete.

Reservations do not consume FIFO purchase lots. Physical stock is consumed only when a Material Out movement is recorded.

## Restock policy

Each Stock Item can store:

- manual approved reorder point;
- target stock;
- fixed service reserve;
- preferred supplier;
- configured lead time;
- safety days;
- minimum order quantity;
- usage lookback period;
- notes.

The optional usage recommendation is deliberately advisory:

```
Suggested reorder point =
  average daily Material Out
  × (lead time days + safety days)
  + service reserve
```

The approved operational value is never overwritten automatically.

## Offline and stale data

Local inventory, reservations, BOMs, product orders, and saved planning policies work without Tally or public internet access. Incoming Purchase Order values remain cached from the last Tally synchronization and are visibly marked stale after two days.

## Database ownership

The Planning domain registers its own versioned migrations against the same application-owned `ApplicationDatabase` used by Stores. It does not open a second SQLite connection or database file. Future Production modules should follow the same pattern.

## Export schema

Planning exports use schema `3.0` and include:

- Metadata
- Restock Review
- Tally Reorder Import

The CSV contains the same Tally mapping columns as the import sheet.

## Local-only products and components

BOM spreadsheets may contain products or components that do not yet exist in Tally. The import preview can create them as clearly marked `LOCAL` Stores Catalog items and then build the BOM. If a later Tally synchronization returns a Stock Item with the exact same name, the local item is promoted to the real Tally GUID without changing its SQLite ID, so existing BOM and reservation relationships remain intact.

Local-only restock recommendations remain visible in the human review workbook. They are excluded from the `Tally Reorder Import` sheet and listed separately until a matching Stock Item exists in Tally.

## Delivery-aware order feasibility

Confirmed product orders are evaluated in required-date order. On-hand and incoming quantities are allocated once across that sequence, so the same open Purchase Order quantity is not counted as available for multiple product orders.

## Deferred beyond v3

This release does not attempt full delivery scheduling or production-capacity planning. Damage-rate and manufacturing-loss analytics are also deferred until the adjustment reasons and production-run data are sufficiently reliable. Per-BOM-line loss buffers are included now so reservations can already account for expected manufacturing loss.
