# Phone app user guide

## Connect the phone

1. Open Settings on the Production desktop.
2. Scan or copy the phone connection address.
3. Save the address in the phone app.
4. Test the connection.

The phone caches the stores catalog and box records for temporary offline work.

## Scan a box

Tap Scan QR code and hold the box label inside the frame. The app loads the latest authoritative box revision when the desktop is reachable.

Choose the item being moved and enter a whole-number quantity.

## Material Out

Material Out has three purposes.

### Production

Use when material is issued for manufacturing.

- Destination Product is required.
- The desktop reduces the active reserved quantity for that product.
- FIFO purchase-lot provenance is retained.

### Servicing

Use for service or repair work. No destination product is requested.

### Customer Extras

Use for extra material supplied to a customer. No destination product is requested.

## Material In

Use Material In only when extras were previously taken out and later found.

Material In:

- Has no destination product
- Returns the quantity to stock
- Is recorded for desktop and Accounts review

Do not use it for normal supplier receipts; supplier receipts belong in the desktop receipt workflow.

## Offline queue

If the desktop cannot be reached, the transaction remains safely in the phone's Sync Queue.

The queue shows:

- Material In or Material Out
- Material Out purpose
- Waiting or rejected status
- The latest synchronization error

Accepted transactions disappear automatically. Remove a queued entry only when it should not be submitted.

## Common problems

### Production cannot be submitted

The cached catalog may not contain destination products. Reconnect to the desktop and scan again.

### Old box revision

The phone warns when a printed label is older than the desktop record and loads the current contents.

### Rejected transaction

Read the queue error, correct the desktop data or stock condition, then retry or remove and re-enter the transaction.
