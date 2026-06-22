# Inventory Scanner v1 consolidation

This document defines the stable operating boundary for the first company-specific version.

## One authoritative database host

Exactly one Electron desktop installation is the authoritative host for a company database. Its
SQLite file remains under Electron's local per-user application-data directory. Do not put the live
file in OneDrive, Dropbox, Google Drive, a NAS, or a shared network folder.

Phones and future production-tracking clients write through the host's HTTP API. A second desktop
must not start a separate company database and be treated as part of the same inventory. A future
LAN desktop-client mode should proxy to the authoritative host rather than sharing the SQLite file.

The Electron composition root owns one `ApplicationDatabase`. Stores receives that connection;
future domains such as Production must receive the same object. Domain modules may register their
own versioned migrations with `ApplicationDatabase.migrateModule`, but must not open an independent
connection to the operational file.

## Concurrency and retries

Every inventory write runs in `BEGIN IMMEDIATE` with a 15-second SQLite busy timeout. Multi-table
operations either commit completely or roll back completely. API busy responses are retryable.

Every phone operation has a stable transaction ID created before the first network attempt. The
server stores the operation name, canonical payload hash, and response. Retrying the same ID and
same payload returns the original response; reusing an ID for different data is rejected.

The phone writes Material Out and Adjustment events to AsyncStorage before attempting upload. It
synchronizes in order, in batches, and retains rejected records for review. Catalog and box records
are cached locally and remain usable while the host is unavailable. Offline submission does not
promise stock availability; FIFO and business validation occur when the queue reaches the host.

Desktop Material In is already local to the authoritative host and therefore does not need internet
or Tally connectivity. Phone-side Material In remains intentionally removed in v1.

## Opening-stock cutover

The Inventory Dashboard can set a target local count for a Tally Stock Item.

- Positive differences create clearly marked Opening Legacy Stock lots.
- Negative differences reduce only Opening Legacy Stock.
- The app refuses to reduce below quantities linked to GRNs or local vendor receipts.
- Every change has a stable ID, reason, optional operator name, and audit record.
- These local cutover values do not alter Tally automatically.

This supports a staged rollout where only proven physical stock is introduced into the Local Stores
Database.

## Export format versions

The review workbook, combined CSV, and XML carry export schema version `1.0`. File names also include
the schema version. The workbook contains a Metadata sheet and an Opening Adjustments sheet.

Tally remains an isolated adapter. Receipt Note XML uses the current adapter; Material Out XML stays
blocked until the two company sample vouchers are mapped.

## Backup and restore

Backups use SQLite `VACUUM INTO` and are integrity-checked. The desktop creates a
backup when the newest snapshot is at least two hours old. Retention keeps every
snapshot created today plus only the newest snapshot from the previous calendar
day. A restore:

1. validates the selected backup and schema version;
2. creates a new safety backup of the current database;
3. closes the shared connection;
4. replaces the active database without carrying WAL/SHM sidecars;
5. reopens, migrates, and integrity-checks the restored database;
6. rolls back to the previous active file if restoration fails.

## Deliberately deferred after v1

- LAN authentication and user roles
- Full remote Electron desktop-client mode
- Physical container-level quantities (QR boxes remain quick item-selection labels)
- General physical-count adjustment workflows beyond the current issue-linked Adjustment
- Automated test suite
- Company-agnostic Tally adapters
- Direct Tally posting
