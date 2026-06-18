# Phone workflow and adjustment update (v15)

## Phone workflows

The scanner now exposes only:

- **Material Out**
- **Adjustment**

Vendor Material In is intentionally desktop-only. Storekeepers record vendor deliveries from the bulk Material In / Receipt Note form so the supplier, Purchase Order, challan number, challan date, and all received lines remain together in one GRN.

## Adjustment matching

An adjustment requires:

- a scanned box and selected Stock Item;
- a destination product;
- today's date;
- a matching same-day Material Out group;
- operator confirmation of the matched issue;
- an effect and reason.

The server finds the most recently recorded positive issue linked to the same day's item-plus-destination Material Out group and stores that movement as the adjustment reference.

### Return count to stock

This reduces the pending Material Out total and restores the most recently consumed FIFO allocations first.

### Record additional issue

This increases the pending Material Out total and allocates the additional count through the normal supplier-aware FIFO purchase lots.

If the matching Material Out has already been exported or confirmed, the adjustment is recorded as an exception and does not change local purchase-lot balances automatically.

## Adjustment reasons

The phone requires one of:

- Unused material
- Miscount
- Data-entry error
- Damage or loss
- Other

Choosing **Other** requires a note. The reason, effect, note, and referenced movement ID are retained in SQLite and included in audit exports.

## Desktop Material In reset

The bulk Material In form now has a **Clear form** button. It clears the supplier, Purchase Order, challan details, dates, non-PO exception state, and all receipt lines.
