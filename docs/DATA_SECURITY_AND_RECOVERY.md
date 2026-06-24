# Data, security, backup, and recovery

## Authoritative data

The Production desktop SQLite database is authoritative for local inventory operations. LAN clients and phones are clients of that database.

Tally remains the accounting/catalog source for synchronized masters and vouchers, while Inventory Scanner retains local operational provenance and review state.

## Authentication

Desktop users have:

- Username
- Unique recovery email
- Password or PIN hash and salt
- Role and permissions
- Audit identity
- Session records

Passwords and PINs are hashed with `scrypt`; plaintext credentials are not stored.

Forgotten-password reset on the Production computer requires the username and matching recovery email. The current implementation verifies ownership data locally; it does not send email because no outbound mail service is configured.

## Roles

- Store
- Accounts
- Production
- Sales
- Admin

Permissions are checked in services and API handlers. The phone uses a hidden shared Store audit identity after desktop setup is complete.

## Auditability

Inventory movements retain:

- Operator
- Date and timestamp
- Item and quantity
- Supplier and purchase-lot provenance
- Conditions and serials
- Product order where applicable
- Reversal and reference links

Order stages retain entered and exited timestamps.

## FIFO valuation

Material Out and scrap are linked to source purchase lots. Wastage value uses the lot rate, or value divided by received quantity. Units without a source valuation are shown separately rather than assigned an invented cost.

## Backups

The Production desktop creates validated SQLite snapshots and pre-migration safety backups. Settings shows the database path, schema, integrity, size, and latest backup.

Before restore:

1. Stop active phone and LAN-client work.
2. Confirm the selected snapshot date.
3. Create or verify a current safety backup.
4. Restore on the Production computer.
5. Reopen the application and confirm integrity.
6. Reconnect clients and synchronize queued phone work carefully.

## Recovery limitations

A restored snapshot does not contain later transactions. Phone entries still waiting locally may synchronize afterward, but already accepted transactions recorded after the snapshot may need business review before re-entry.
