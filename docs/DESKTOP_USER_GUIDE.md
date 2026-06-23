# Desktop app user guide

## First-time company setup

The installer opens a Company LAN Setup screen before creating any database.

- Choose **Production server** on the one authoritative Production computer.
- Choose **Company LAN client** on Accounts and all other company computers.
- On a client, enter the Production computer name or fixed IP and test the
  connection before saving.
- On the Accounts computer, select the TallyPrime option so Windows can permit
  Tally access from Production.

On Windows, firewall setup uses the normal Administrator approval prompt. No
PowerShell scripts or GitHub checkout are required. Change the saved role or
addresses later from Settings → Company LAN.

## Signing in

Sign in with your username and password or PIN. Every account has a recovery email. Older accounts without one are prompted to add it immediately after their next successful login.

Forgotten-password reset on the Production computer requires:

- Username
- Matching recovery email
- New password or PIN

An administrator can also reset another user's credential from the Users screen.

## Inventory Dashboard

Use the Inventory Dashboard for restock attention, BOM maintenance, and stock planning. Reservation values show committed material that has not yet been issued to production.

## Orders & Production

The Order Register is the only order workflow view.

### Finding orders

Search by customer, PO, file number, or product. Filter by stage, due date, owner, overdue, blocked, or dispatched.

### Expanding an order

Select the arrow beside a PO to see its product lines. Each line has its own stage, quantity, blocker, completion, and owner.

### Order detail

Select the customer/PO name to open the detail view. It shows:

- Product lines
- Overall completion
- CRF and CRAC information
- Owner and priority
- Follow-up information
- Recent stage activity

### Editing a product line

Select a product line to open the right-hand editor. Change the stage, owner, date, quantity, blocker, or notes.

Quality Control appears only after that line has previously entered Material Purchase.

## Inventory Tracker

### Material receipt

Use the receipt form for supplier deliveries. Select the supplier and PO where applicable, record challan details, and split quantities into available, pending inspection, faulty, or rejected.

### Recent events

The movement table shows receipts, Material Out, Material In, and adjustments with operator and traceability details.

## Admin Dashboard

The Admin Dashboard is available to Accounts and administrators.

It shows:

- Total wastage value based on FIFO purchase rates
- Scrapped quantity
- Products affected
- Units that cannot yet be valued
- Wastage by destination product
- Wastage by material
- Typical and current time in every order stage

Select a stage to see each order line, when it entered and exited, and its time in that stage. Select View all stages on an order to see its complete stage-by-stage journey.

## QR Code Creator

Select one to five stock items, enter a Box ID, and save the box. The QR identifies the authoritative box record and revision.

Use Edit an Existing Box to load or delete an existing record. Add generated labels to the Print Queue, choose copies, and print.

## Tally Syncer

Tally is read for catalog, purchase, receipt, supplier, and BOM data. Generated files are reviewed before import into Tally.

## Scanner security

Phone scanners must be paired from **Settings → Phone connection**. Each pairing QR is single-use, expires after 10 minutes, and creates a separate audit identity for that handset. Administrators can revoke a lost or replaced scanner from the same screen.

The Production server still listens on the selected company LAN so paired phones and LAN clients can reach it. Browser origins are restricted, scanner mutation requests are rate-limited, and the old unauthenticated workbook transaction routes are disabled in the desktop application.

## Credential recovery email

Credential recovery sends a six-digit code from `gtrswnt@gmail.com`. On the Production computer, set `INVENTORY_GMAIL_APP_PASSWORD` to a Gmail app password for that account before starting Inventory Scanner. Do not use or store the normal Gmail password.

Review pending Material In/Out and manual Accounts items before generating an export batch.

## Settings

Settings shows:

- Production/LAN role
- Phone connection QR and API address
- SQLite path, schema, size, integrity, host ID, and backup status
- Validated SQLite snapshots and restore controls on the Production computer

The old Excel-audit path is no longer part of Settings.

## Users

Administrators create and edit users from Settings → Company Access. The role
checklist shows whether Production, Accounts, Store, and Sales access has been
created. A user requires:

- Display name
- Username
- Unique recovery email
- Role
- Password or PIN

Roles limit both visible screens and server-side operations.
