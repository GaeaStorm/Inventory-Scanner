# Desktop app code walkthrough

## Entry points

- `src/main.ts`: Electron lifecycle, API startup, IPC registration, printing.
- `src/preload.ts`: safe renderer bridge and LAN-client request routing.
- `src/renderer/main.tsx`: React mount and stylesheet imports.
- `src/renderer/App.tsx`: application shell, authentication state, global refresh, top navigation.

## Renderer structure

Important screens:

- `InventoryPlanningDashboard.tsx`: restock, BOM, and planning sections.
- `OperationsTab.tsx`: Orders & Production shell plus operational tools.
- `OrderRegister.tsx`: PO grouping, filters, order detail, product-line editor.
- `AdministrationDashboard.tsx`: wastage and stage-duration reporting.
- `BulkMaterialInForm.tsx`: supplier receipt workflow.
- `BoxQrCodeCreatorTab.tsx`: authoritative boxes, QR generation, print queue.
- `TallyTab.tsx`: Tally synchronization, review, and exports.
- `AuthGate.tsx`: bootstrap, sign-in, and recovery.

Shared visual rules are mainly in `styles.css`, `layout-fixes.css`, `OperationsTab.css`, and `BoxQrCodeCreatorTab.css`.

## Refresh flow

`App.refresh()` loads Stores, Planning, Operations, Dashboard, and Auth state. Mutating components call their domain bridge and then refresh the affected state.

## Stores domain

### `stores/database.ts`

Owns:

- Catalog and boxes
- Purchase orders and GRNs
- Purchase lots
- FIFO Material Out
- Material In
- Export review and batch records
- Backup/restore metadata

### `stores/service.ts`

Checks permissions, wraps cross-domain work in application transactions, and informs Operations so the condition ledger mirrors legacy stores movements.

## Planning domain

### `planning/database.ts`

Owns:

- Restock policies and recommendations
- BOM versions and lines
- Customer-order product lines
- Material reservations
- Fixed workflow stages
- Stage transition history

`updateProductOrderWorkflowState()` closes the open history entry and creates the next one. `saveProductOrder()` performs the same work when an edit changes the stage.

## Operations domain

### `operations/database.ts`

Owns:

- Users, sessions, and audit events
- Lot conditions and serial tracking
- Faults, returns, counts, scrap, and reversals
- Production execution
- Wastage valuation

Wastage is calculated from scrap movement lot lines multiplied by the source purchase-lot rate. Missing rates are reported separately.

### `operations/permissions.ts`

Defines role-to-permission mappings. Always enforce new permissions in services or routers; renderer visibility is not a security boundary.

## LAN client behavior

The renderer uses the same `window.desktop` methods on every computer. `preload.ts` routes calls to IPC locally or HTTP remotely, keeping UI code independent of deployment mode.

## Tests

`test/operations.test.ts` creates temporary SQLite databases and exercises migrations, authentication, planning, FIFO, traceability, counts, returns, scrap, production, and synchronization.
