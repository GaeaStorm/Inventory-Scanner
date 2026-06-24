# High-level code architecture

## Purpose

Inventory Scanner is a local-first stores, production, and administration system. The Production desktop is the authoritative database host. Other desktop installations can connect as LAN clients, and phones submit stores movements through the desktop API.

## Workspace

The repository is a pnpm workspace:

```text
artifacts/
  desktop-app/       Electron desktop, Express API, SQLite services, React UI
  scanner-app/       Expo/React Native phone scanner
  api-server/        Older standalone API artifact; not the authoritative desktop runtime
lib/
  api-client-react/  Generated API client types
  api-spec/          OpenAPI source
  api-zod/           Generated validation types
  db/                Shared database package
deployment/windows/  Production, LAN client, and Accounts/Tally setup scripts
docs/                Maintained product and engineering documentation
```

## Runtime topology

```text
Phone scanner ──HTTP/LAN──┐
LAN desktop ───HTTP/LAN───┼── Production desktop
                          │   ├── Electron main process
                          │   ├── Express API
                          │   ├── SQLite application database
                          │   └── Tally read/export integration
Accounts/Tally computer ──┘
```

The Production desktop owns writes, migrations, backups, authentication, and synchronization. LAN clients do not maintain an independent company database.

Before services start, Electron reads `deployment.json` from its application
data folder. A first-run setup screen creates this file. Existing databases and
older environment-variable deployments are detected and migrated automatically.
An unconfigured installation does not create the SQLite company database.

## Desktop layers

### Renderer

`artifacts/desktop-app/src/renderer`

React components render the application shell, dashboards, order register, stores workflows, QR labels, Tally tools, authentication, and settings. Renderer code calls only the API exposed by `preload.ts`.

### Preload bridge

`artifacts/desktop-app/src/preload.ts`

The preload bridge exposes a typed `window.desktop` API. On the Production computer it invokes Electron IPC. On a LAN client it converts the same operation into an authenticated HTTP request.

### Electron main and HTTP routers

`artifacts/desktop-app/src/main.ts`

The main process starts Electron, the local API, IPC handlers, printing, and the database-backed services.

`artifacts/desktop-app/src/deployment.ts` owns deployment configuration,
Production connectivity tests, and optional elevated Windows firewall setup.
Configuration changes relaunch the app so the main process and preload bridge
both enter the selected role cleanly.

Routers live beside their domain:

- `src/stores/router.ts`
- `src/planning/router.ts`
- `src/operations/router.ts`

### Domain services and databases

- Stores: catalog, boxes, receipts, FIFO, Material In/Out, exports, backups.
- Planning: restock policy, BOMs, customer-order lines, reservations, order stages.
- Operations: authentication, conditions, faults, counts, returns, production execution, scrap, audit records.

Services enforce permissions and coordinate cross-domain transactions. Database classes contain migrations and SQL.

## Data model

The application uses one SQLite file with additive module migrations.

Important groups:

- Tally catalog and purchase data
- Purchase lots and FIFO allocations
- Inventory movements and export review
- Condition and traceability ledger
- BOMs, customer-order lines, reservations, and stage history
- Users, sessions, permissions, audit events, and sync exceptions

Order records are product lines. Lines sharing customer and PO details are grouped into one commercial order in the Order Register.

## Order stages

The fixed lifecycle is:

1. PO Pending
2. PO Generated
3. CRF Pending
4. CRF Sent
5. Material Planning
6. Material Purchase (optional)
7. Quality Control (only after Material Purchase)
8. PCB Soldering
9. Initial Testing
10. Burn Test
11. Final Testing
12. Packing
13. Pending Dispatch
14. Dispatched
15. CRAC Generated (optional)

Every transition closes the current stage-history record and opens a new one. The Admin Dashboard uses that history for cycle-time reporting.

## Inventory movement rules

- Material In records stock found after an earlier extra issue. It has no destination product.
- Material Out has Production, Servicing, and Customer Extras purposes.
- Production requires a destination product and consumes active reservations for that product.
- Servicing and Customer Extras use system destinations and do not consume production reservations.
- Physical stock issues use supplier-aware FIFO purchase-lot allocation.

## Security boundary

Renderer code cannot access Node or SQLite directly. Authentication sessions and role permissions are enforced in the service/API layer, not only by hiding buttons.
