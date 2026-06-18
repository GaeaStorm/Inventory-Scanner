# Demo data and Akademika desktop icon (v11)

## Demo catalog

When the Local Stores Database has no active Tally Stock Items, the desktop app seeds a clearly marked demo company with:

- eight Stock Items, including two destination products;
- two suppliers;
- two open Purchase Orders;
- two historical GRNs;
- supplier-attributed purchase lots suitable for FIFO testing;
- example BOM relationships.

The demo catalog is operational, so it can be used to test box creation, QR labels, Vendor Material In, Material Out, Return Unused Material, FIFO allocation, and export review.

When a later Tally sync returns real Stock Items, the app:

1. creates and validates a SQLite backup;
2. removes all demo operational records;
3. imports the real Tally company data;
4. changes the data mode from `demo` to `tally`.

If Tally returns no Stock Items, the demo catalog is retained. The desktop UI always displays a warning while demo data is active.

## Desktop icon

The supplied Akademika logo is converted into:

- `artifacts/desktop-app/build/icon.icns` for macOS;
- `artifacts/desktop-app/build/icon.ico` for Windows;
- `artifacts/desktop-app/build/public/logo.png` for Linux, the Electron window, the Dock during development, the browser favicon, and the application header.

Electron Builder uses these files when `pnpm desktop:dist` creates platform packages. Existing installed builds do not change their icon until a new package is built and installed.
