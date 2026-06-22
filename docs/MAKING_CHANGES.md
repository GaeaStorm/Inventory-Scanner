# How to make changes in the code

## Prerequisites

- Node.js and pnpm compatible with the workspace
- Platform build tools required by Electron/Expo
- A clean backup before testing against real company data

Install dependencies from the repository root:

```bash
pnpm install
```

## Development commands

Desktop:

```bash
pnpm --filter @workspace/desktop-app typecheck
pnpm --filter @workspace/desktop-app test
pnpm --filter @workspace/desktop-app dev
pnpm --filter @workspace/desktop-app build
```

Phone:

```bash
pnpm --filter @workspace/scanner-app typecheck
pnpm --filter @workspace/scanner-app dev
```

## Change the desktop UI

1. Find the screen under `artifacts/desktop-app/src/renderer`.
2. Reuse existing components and CSS conventions.
3. Call `window.desktop` instead of importing Node modules.
4. Keep authorization in the backend even if the button is role-gated.
5. Type-check and build the renderer.

## Change a database-backed feature

1. Update the domain type.
2. Add an additive migration; never rewrite an applied migration.
3. Update the database method.
4. Update the service permission check.
5. Expose the operation through router, IPC, preload, and global renderer types as needed.
6. Add a temporary-database test.

The application database coordinates transactions across Stores, Planning, and Operations. Use that coordinator for cross-domain changes.

## Change order stages

The order lifecycle is intentionally fixed because reporting depends on stable stage IDs. A stage change requires:

- A new Planning migration
- A migration strategy for existing orders and history
- Updated stage validation
- Updated Admin Dashboard interpretation
- Updated user documentation

Do not add ad hoc states through UI configuration.

## Change phone transactions

Keep offline compatibility in mind. Phones can retain older payloads for days.

- Prefer optional new fields with a safe server default.
- Keep client transaction IDs stable.
- Validate rules on the desktop.
- Test online, offline, retry, and rejection paths.

## Migrations

Before a Stores, Planning, or Operations migration, the application creates a safety backup through the module's migration callback.

Migration rules:

- Increase the module version.
- Use additive SQL where possible.
- Populate new required columns for old records.
- Add indexes for new report paths.
- Test a fresh database and a migrated database.

## Tests to run before release

```bash
pnpm --filter @workspace/desktop-app typecheck
pnpm --filter @workspace/scanner-app typecheck
pnpm --filter @workspace/desktop-app test
pnpm --filter @workspace/desktop-app build
```

Also manually verify:

- Sign-in and recovery email
- LAN client authentication
- Phone online/offline movement
- Material Out reservation reduction
- Order-stage history
- Wastage valuation
- Backup creation and restore selection
- QR label printing

## Documentation

Update the maintained guide that matches the change. Avoid creating version-numbered change-note documents in `docs/`; use source control for historical detail.
