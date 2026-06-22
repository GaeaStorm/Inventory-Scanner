# Phone app code walkthrough

## Framework

The phone app is an Expo Router / React Native application in `artifacts/scanner-app`.

## Navigation

`app/(tabs)/_layout.tsx` defines the scanner, history/sync queue, and settings tabs.

## Scanner workflow

`components/BoxScannerScreen.tsx` contains the main scan flow:

1. Request camera permission.
2. Parse the box QR.
3. Load the catalog and authoritative box from the desktop.
4. Fall back to cached data if the desktop is offline.
5. Select an item and workflow.
6. Build a Material Out or Material In payload.
7. Add it to the durable queue.
8. Attempt synchronization.

Material Out purpose is included in the payload. Destination Product is included only for Production.

## Offline storage

`lib/storesOfflineQueue.ts` stores pending operations in AsyncStorage.

Each entry has:

- Stable client transaction ID
- Operation type
- Payload
- Creation time
- Attempt count
- Pending or rejected status
- Last error

Stable IDs make desktop processing idempotent.

## Synchronization

`context/SyncContext.tsx` owns:

- Desktop server URL
- Queue state
- Periodic synchronization
- Manual retry
- Removal of queued transactions

The phone posts batches to `/api/stores/offline-batch`. Accepted entries are removed; retryable entries remain pending; business-rule failures become rejected.

## Cached data

The queue library also stores recent catalogs and box definitions by server. This supports short offline periods without creating a second authoritative inventory database.

## Settings and history

- `app/(tabs)/settings.tsx`: desktop address and connection test.
- `app/(tabs)/history.tsx`: pending/rejected queue with movement purpose and removal.

## Safe changes

When changing a phone payload:

1. Update the scanner payload.
2. Update shared or desktop input types.
3. Update Stores service/database validation.
4. Preserve old queued payload compatibility where practical.
5. Type-check both scanner and desktop projects.
