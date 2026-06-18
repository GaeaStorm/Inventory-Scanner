import AsyncStorage from "@react-native-async-storage/async-storage";

const QUEUE_KEY = "inventory-scanner:stores-offline-queue:v1";
const DEVICE_KEY = "inventory-scanner:stores-device-id:v1";
const CATALOG_PREFIX = "inventory-scanner:stores-catalog:v1:";
const BOX_PREFIX = "inventory-scanner:stores-box:v1:";
const MAX_QUEUE_ENTRIES = 2500;

export type QueuedStoresOperationType = "MATERIAL_OUT" | "ADJUSTMENT";

export interface QueuedStoresOperation {
  clientTransactionId: string;
  type: QueuedStoresOperationType;
  payload: Record<string, unknown> & { clientTransactionId: string };
  createdAt: string;
  attempts: number;
  status: "PENDING" | "REJECTED";
  lastError: string;
}

export interface OfflineQueueSummary {
  pending: number;
  rejected: number;
  total: number;
}

interface OfflineBatchResponse {
  results: Array<{
    clientTransactionId: string;
    status: "ACCEPTED" | "REJECTED" | "RETRY";
    error?: string;
  }>;
}

let storageChain: Promise<unknown> = Promise.resolve();
let syncInFlight: Promise<OfflineQueueSummary> | null = null;

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = storageChain.then(work, work);
  storageChain = next.then(() => undefined, () => undefined);
  return next;
}

function normalizedServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/$/, "");
}

function cacheSuffix(serverUrl: string): string {
  return encodeURIComponent(normalizedServerUrl(serverUrl) || "default");
}

async function readQueue(): Promise<QueuedStoresOperation[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as QueuedStoresOperation[] : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: QueuedStoresOperation[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE_ENTRIES)));
}

function summarize(queue: QueuedStoresOperation[]): OfflineQueueSummary {
  return {
    pending: queue.filter((entry) => entry.status === "PENDING").length,
    rejected: queue.filter((entry) => entry.status === "REJECTED").length,
    total: queue.length,
  };
}

export async function storesDeviceId(): Promise<string> {
  const current = await AsyncStorage.getItem(DEVICE_KEY);
  if (current) return current;
  const created = `DEVICE-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  await AsyncStorage.setItem(DEVICE_KEY, created);
  return created;
}

export async function createStoresClientTransactionId(): Promise<string> {
  const deviceId = await storesDeviceId();
  return `${deviceId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function enqueueStoresOperation(
  operation: Omit<QueuedStoresOperation, "createdAt" | "attempts" | "status" | "lastError">,
): Promise<OfflineQueueSummary> {
  return serialized(async () => {
    const queue = await readQueue();
    const existing = queue.find((entry) => entry.clientTransactionId === operation.clientTransactionId);
    if (existing) {
      if (JSON.stringify(existing.payload) !== JSON.stringify(operation.payload) || existing.type !== operation.type) {
        throw new Error("This offline transaction ID is already attached to different data.");
      }
      return summarize(queue);
    }
    queue.push({
      ...operation,
      createdAt: new Date().toISOString(),
      attempts: 0,
      status: "PENDING",
      lastError: "",
    });
    await writeQueue(queue);
    return summarize(queue);
  });
}

export async function getStoresQueueSummary(): Promise<OfflineQueueSummary> {
  return summarize(await readQueue());
}

export async function synchronizeStoresQueue(serverUrl: string): Promise<OfflineQueueSummary> {
  if (!serverUrl) return getStoresQueueSummary();
  if (syncInFlight) return syncInFlight;

  syncInFlight = serialized(async () => {
    let queue = await readQueue();
    for (let round = 0; round < 10; round += 1) {
      const pending = queue.filter((entry) => entry.status === "PENDING").slice(0, 500);
      if (pending.length === 0) break;

      const response = await fetch(`${normalizedServerUrl(serverUrl)}/api/stores/offline-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: await storesDeviceId(),
          operations: pending.map((entry) => ({
            type: entry.type,
            clientTransactionId: entry.clientTransactionId,
            payload: entry.payload,
          })),
        }),
      });
      const body = await response.json().catch(() => ({})) as OfflineBatchResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || `Desktop server returned ${response.status}.`);

      const byId = new Map(body.results.map((result) => [result.clientTransactionId, result]));
      let retryRequested = false;
      queue = queue.flatMap((entry) => {
        const result = byId.get(entry.clientTransactionId);
        if (!result) return [entry];
        if (result.status === "ACCEPTED") return [];
        if (result.status === "RETRY") {
          retryRequested = true;
          return [{
            ...entry,
            attempts: entry.attempts + 1,
            lastError: result.error || "The desktop database is busy; this transaction will retry.",
          }];
        }
        return [{
          ...entry,
          attempts: entry.attempts + 1,
          status: "REJECTED" as const,
          lastError: result.error || "The desktop rejected this queued transaction.",
        }];
      });
      await writeQueue(queue);
      if (retryRequested) break;
    }
    return summarize(queue);
  }).finally(() => {
    syncInFlight = null;
  });

  return syncInFlight;
}

export async function cacheStoresCatalog<T>(serverUrl: string, catalog: T): Promise<void> {
  await AsyncStorage.setItem(`${CATALOG_PREFIX}${cacheSuffix(serverUrl)}`, JSON.stringify({
    cachedAt: new Date().toISOString(),
    catalog,
  }));
}

export async function loadCachedStoresCatalog<T>(serverUrl: string): Promise<T | null> {
  const raw = await AsyncStorage.getItem(`${CATALOG_PREFIX}${cacheSuffix(serverUrl)}`);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { catalog: T }).catalog;
  } catch {
    return null;
  }
}

export async function cacheStoresBox<T extends { boxId: string }>(serverUrl: string, box: T): Promise<void> {
  await AsyncStorage.setItem(
    `${BOX_PREFIX}${cacheSuffix(serverUrl)}:${encodeURIComponent(box.boxId)}`,
    JSON.stringify({ cachedAt: new Date().toISOString(), box }),
  );
}

export async function loadCachedStoresBox<T>(serverUrl: string, boxId: string): Promise<T | null> {
  const raw = await AsyncStorage.getItem(
    `${BOX_PREFIX}${cacheSuffix(serverUrl)}:${encodeURIComponent(boxId)}`,
  );
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { box: T }).box;
  } catch {
    return null;
  }
}
