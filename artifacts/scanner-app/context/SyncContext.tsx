import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import {
  getStoresQueueSummary,
  getStoresQueue,
  removeStoresOperation,
  synchronizeStoresQueue,
  type OfflineQueueSummary,
  type QueuedStoresOperation,
} from "@/lib/storesOfflineQueue";

const SERVER_URL_KEY = "@stockscanner/serverUrl";
const LEGACY_TRANSACTIONS_KEY = "@stockscanner/transactions";
const EMPTY_QUEUE: OfflineQueueSummary = { pending: 0, rejected: 0, total: 0 };

function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function getDevelopmentServerUrl(): string | null {
  const hostUri = Constants.expoConfig?.hostUri;
  if (!hostUri) return null;

  try {
    const parsed = new URL(
      hostUri.includes("://") ? hostUri : `http://${hostUri}`,
    );
    const rawPort = process.env.EXPO_PUBLIC_API_PORT ?? "5050";
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const host =
      parsed.hostname.includes(":") && !parsed.hostname.startsWith("[")
        ? `[${parsed.hostname}]`
        : parsed.hostname;
    return `http://${host}:${port}`;
  } catch {
    return null;
  }
}

async function canReachServer(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${normalizeServerUrl(url)}/api/healthz`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

interface SyncContextType {
  serverUrl: string;
  queueSummary: OfflineQueueSummary;
  queue: QueuedStoresOperation[];
  pendingCount: number;
  setServerUrl: (url: string) => Promise<void>;
  syncPending: () => Promise<OfflineQueueSummary>;
  refreshQueue: () => Promise<OfflineQueueSummary>;
  removeQueuedTransaction: (clientTransactionId: string) => Promise<OfflineQueueSummary>;
  testConnection: (url?: string) => Promise<boolean>;
}

const SyncContext = createContext<SyncContextType | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [serverUrl, setServerUrlState] = useState("");
  const [queueSummary, setQueueSummary] = useState<OfflineQueueSummary>(EMPTY_QUEUE);
  const [queue, setQueue] = useState<QueuedStoresOperation[]>([]);

  const refreshQueue = useCallback(async () => {
    const summary = await getStoresQueueSummary();
    setQueue(await getStoresQueue());
    setQueueSummary(summary);
    setQueue(await getStoresQueue());
    return summary;
  }, []);

  const syncPending = useCallback(async () => {
    const summary = serverUrl
      ? await synchronizeStoresQueue(serverUrl)
      : await getStoresQueueSummary();
    setQueueSummary(summary);
    return summary;
  }, [serverUrl]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [storedUrl] = await Promise.all([
        AsyncStorage.getItem(SERVER_URL_KEY),
        AsyncStorage.removeItem(LEGACY_TRANSACTIONS_KEY),
      ]);
      let resolvedUrl = storedUrl;
      if (!resolvedUrl) {
        const detectedUrl = getDevelopmentServerUrl();
        if (detectedUrl && await canReachServer(detectedUrl)) {
          resolvedUrl = detectedUrl;
          await AsyncStorage.setItem(SERVER_URL_KEY, detectedUrl);
        }
      }
      if (cancelled) return;
      if (resolvedUrl) setServerUrlState(resolvedUrl);
      setQueueSummary(await getStoresQueueSummary());
      setQueue(await getStoresQueue());
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void syncPending().catch(() => refreshQueue());
    }, 30_000);
    return () => clearInterval(timer);
  }, [refreshQueue, syncPending]);

  const setServerUrl = useCallback(async (url: string) => {
    const normalizedUrl = normalizeServerUrl(url);
    setServerUrlState(normalizedUrl);
    await AsyncStorage.setItem(SERVER_URL_KEY, normalizedUrl);
  }, []);

  const testConnection = useCallback(
    (url?: string) => canReachServer(normalizeServerUrl(url || serverUrl)),
    [serverUrl],
  );

  const removeQueuedTransaction = useCallback(async (clientTransactionId: string) => {
    const summary = await removeStoresOperation(clientTransactionId);
    setQueueSummary(summary);
    setQueue(await getStoresQueue());
    return summary;
  }, []);

  return (
    <SyncContext.Provider
      value={{
        serverUrl,
        queueSummary,
        queue,
        pendingCount: queueSummary.pending,
        setServerUrl,
        syncPending,
        refreshQueue,
        removeQueuedTransaction,
        testConnection,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
}

export function useSync() {
  const context = useContext(SyncContext);
  if (!context) throw new Error("useSync must be used within SyncProvider");
  return context;
}
