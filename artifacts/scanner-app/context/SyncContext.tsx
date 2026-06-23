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
  getStoresQueueState,
  clearScannerPairing,
  removeStoresOperation,
  saveScannerPairing,
  scannerDeviceLabel,
  scannerDeviceToken,
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
  deviceLabel: string;
  paired: boolean;
  queueSummary: OfflineQueueSummary;
  queue: QueuedStoresOperation[];
  pendingCount: number;
  setServerUrl: (url: string) => Promise<void>;
  pairScanner: (input: { url: string; pairingToken: string; deviceLabel?: string }) => Promise<void>;
  syncPending: () => Promise<OfflineQueueSummary>;
  refreshQueue: () => Promise<OfflineQueueSummary>;
  removeQueuedTransaction: (clientTransactionId: string) => Promise<OfflineQueueSummary>;
  testConnection: (url?: string) => Promise<boolean>;
}

const SyncContext = createContext<SyncContextType | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [serverUrl, setServerUrlState] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [paired, setPaired] = useState(false);
  const [queueSummary, setQueueSummary] = useState<OfflineQueueSummary>(EMPTY_QUEUE);
  const [queue, setQueue] = useState<QueuedStoresOperation[]>([]);

  const refreshQueue = useCallback(async () => {
    const state = await getStoresQueueState();
    setQueue(state.queue);
    setQueueSummary(state.summary);
    return state.summary;
  }, []);

  const syncPending = useCallback(async () => {
    const state = serverUrl
      ? await synchronizeStoresQueue(serverUrl)
      : await getStoresQueueState();
    setQueue(state.queue);
    setQueueSummary(state.summary);
    return state.summary;
  }, [serverUrl]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [storedUrl, storedToken, storedLabel] = await Promise.all([
        AsyncStorage.getItem(SERVER_URL_KEY),
        scannerDeviceToken(),
        scannerDeviceLabel(),
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
      setPaired(Boolean(storedToken));
      setDeviceLabel(storedLabel);
      const state = await getStoresQueueState();
      setQueueSummary(state.summary);
      setQueue(state.queue);
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
    setPaired(false);
    setDeviceLabel("");
    await Promise.all([
      AsyncStorage.setItem(SERVER_URL_KEY, normalizedUrl),
      clearScannerPairing(),
    ]);
  }, []);

  const pairScanner = useCallback(async (input: { url: string; pairingToken: string; deviceLabel?: string }) => {
    const normalizedUrl = normalizeServerUrl(input.url);
    const label = input.deviceLabel?.trim() || await scannerDeviceLabel();
    const response = await fetch(`${normalizedUrl}/api/scanners/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingToken: input.pairingToken, deviceLabel: label }),
    });
    const body = await response.json().catch(() => ({})) as {
      deviceToken?: string;
      device?: { label?: string };
      error?: string;
    };
    if (!response.ok || !body.deviceToken) {
      throw new Error(body.error || "The scanner pairing request was rejected.");
    }
    const savedLabel = body.device?.label || label;
    await Promise.all([
      AsyncStorage.setItem(SERVER_URL_KEY, normalizedUrl),
      saveScannerPairing(body.deviceToken, savedLabel),
    ]);
    setServerUrlState(normalizedUrl);
    setDeviceLabel(savedLabel);
    setPaired(true);
  }, []);

  const testConnection = useCallback(
    (url?: string) => canReachServer(normalizeServerUrl(url || serverUrl)),
    [serverUrl],
  );

  const removeQueuedTransaction = useCallback(async (clientTransactionId: string) => {
    const state = await removeStoresOperation(clientTransactionId);
    setQueueSummary(state.summary);
    setQueue(state.queue);
    return state.summary;
  }, []);

  return (
    <SyncContext.Provider
      value={{
        serverUrl,
        deviceLabel,
        paired,
        queueSummary,
        queue,
        pendingCount: queueSummary.pending,
        setServerUrl,
        pairScanner,
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
