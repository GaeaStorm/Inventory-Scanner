# Inventory Scanner desktop application

The desktop package bundles three things into one application:

1. An Electron window.
2. A React/Vite dashboard.
3. The existing Express API server from `artifacts/api-server`.

The phone scanner can continue to reach the API over the local network. The
desktop dashboard displays the correct LAN address after startup.

## Configure the workspace

The Electron patch itself only adds new files, so it does not depend on the
exact formatting of the root `package.json` or `pnpm-workspace.yaml`.

From the repository root, run the included idempotent setup script once:

```bash
node artifacts/desktop-app/scripts/setup-workspace.mjs
```

It performs two small workspace edits:

- adds `desktop:setup`, `desktop:dev`, `desktop:build`, and `desktop:dist` aliases
  to the root `package.json`;
- adds `electron: true` to the existing pnpm `allowBuilds` map so Electron's
  reviewed install script may download its platform binary.

The script can safely be run more than once.

## Install dependencies

```bash
pnpm install
```

The first install updates `pnpm-lock.yaml` for the new Electron package. Commit
that generated lockfile together with the desktop files and the two setup edits.

## Run in development

```bash
pnpm desktop:dev
```

This builds the Electron main/preload processes, starts Vite with hot module
replacement, starts the existing API, and opens the desktop window.

The command can also be run without the root alias:

```bash
pnpm --filter @workspace/desktop-app dev
```

## Build the application

```bash
pnpm desktop:build
```

The compiled application is written to `artifacts/desktop-app/dist`.

## Generate an installer

```bash
pnpm desktop:dist
```

Installer output is written to `artifacts/desktop-app/release`.
Electron installers are normally built on their target operating system:

- Windows produces an NSIS `.exe` installer.
- macOS produces `.dmg` and `.zip` artifacts.
- Linux produces AppImage and Debian package artifacts.

The included GitHub Actions workflow builds all three operating-system variants
when a `v*` tag is pushed or the workflow is started manually.

## Local data

The operational database is stored under Electron's per-user application-data folder:

- Windows: `%APPDATA%/Inventory Scanner/data/inventory-scanner.sqlite`
- macOS: `~/Library/Application Support/Inventory Scanner/data/inventory-scanner.sqlite`
- Linux: `~/.config/Inventory Scanner/data/inventory-scanner.sqlite`

Do not move the active database into Dropbox, OneDrive, Google Drive, a NAS, or a shared network folder. Use the Settings tab to choose a separate backup folder and to create a validated manual backup. The app also backs up before migrations and exports and automatically when the newest backup is at least two hours old. It retains all backups from today and the newest backup from yesterday.

Excel and optional CSV files are generated as review/audit outputs. The legacy `stock_transactions.xlsx` path remains available for compatibility but is no longer authoritative.

## Phone scanner connection

1. Put the phone and computer on the same Wi-Fi or Ethernet network.
2. Start Inventory Scanner Desktop.
3. Copy one of the displayed phone-scanner URLs.
4. Use that URL as the scanner's API base URL.
5. Allow private-network access if Windows Firewall or macOS asks.

The preferred port is `5000`. Set `INVENTORY_SCANNER_PORT` before launching to
choose a different port. If the preferred port is occupied, the app selects an
available port and displays it in the dashboard.

## Multiple computers on the LAN

The current architecture supports one authoritative desktop host plus many API
clients. Set `INVENTORY_SCANNER_REMOTE_URL=http://production:5000` on the five
client computers. In that mode the same desktop interface connects to
Production and does not create a local company database. They must not run
independent authoritative databases, and the live SQLite file must not be
placed on a shared drive.

The server listens on the LAN and serializes writes through one SQLite
connection with transaction IDs and retry handling. Tally, backups, generated
files, and the SQLite file remain on the Production host. Tally itself may run
on the Accounts computer; configure `INVENTORY_TALLY_HOST=accounts` on
Production and allow Production to reach Accounts TCP port 9000.

## Signing public releases

The workflow deliberately creates unsigned artifacts. For public distribution,
configure Apple signing/notarization credentials and a Windows code-signing
certificate in repository secrets, then remove
`CSC_IDENTITY_AUTO_DISCOVERY=false` and add the relevant electron-builder
settings.

## Repository dashboard note

The GitHub repository currently contains the generic Replit mockup preview shell,
but its generated mockup component registry is empty. The desktop package
therefore includes a complete functional dashboard rather than importing the
uncommitted online mockup. Once that dashboard component is committed, it can
replace `artifacts/desktop-app/src/renderer/App.tsx` without changing the
Electron main process or packaging setup.
