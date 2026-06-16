import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
// import { setBaseUrl } from "@workspace/api-client-react";

function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function getDevelopmentServerUrl(): string | null {
  const hostUri = Constants.expoConfig?.hostUri;

  if (!hostUri) {
    return null;
  }

  try {
    const parsed = new URL(
      hostUri.includes("://") ? hostUri : `http://${hostUri}`,
    );
    const rawPort = process.env.EXPO_PUBLIC_API_PORT ?? "5050";
    const port = Number(rawPort);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }

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

const STORAGE_KEYS = {
  SERVER_URL: "@stockscanner/serverUrl",
  TRANSACTIONS: "@stockscanner/transactions",
};

export type MovementType = "Restock" | "Use" | "Adjustment";
export type AdjustmentDirection = "in" | "out";

export interface LocalTransaction {
  id: string;

  refNo: string;
  itemCode: string;
  itemName: string;
  unitRate: string;
  godown: string;
  batchNo: string;

  movementType: MovementType;
  adjustmentDirection?: AdjustmentDirection;

  quantity: number;
  usedIn: string;

  timestamp: string;
  synced: boolean;
  syncError?: string;
}

interface SyncContextType {
  serverUrl: string;
  setServerUrl: (url: string) => Promise<void>;
  transactions: LocalTransaction[];
  pendingCount: number;
  isSubmitting: boolean;
  lastSyncResult: "success" | "error" | null;
  addTransaction: (
    tx: Omit<LocalTransaction, "id" | "synced">,
  ) => Promise<boolean>;
  syncPending: () => Promise<void>;
  clearHistory: () => Promise<void>;
  testConnection: (url?: string) => Promise<boolean>;
}

const SyncContext = createContext<SyncContextType | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [serverUrl, setServerUrlState] = useState<string>("");
  const [transactions, setTransactions] = useState<LocalTransaction[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState<
    "success" | "error" | null
  >(null);
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const storedUrl = await AsyncStorage.getItem(STORAGE_KEYS.SERVER_URL);
      const storedTxns = await AsyncStorage.getItem(STORAGE_KEYS.TRANSACTIONS);
      let resolvedUrl = storedUrl;

      if (!resolvedUrl) {
        const detectedUrl = getDevelopmentServerUrl();

        if (detectedUrl && (await canReachServer(detectedUrl))) {
          resolvedUrl = detectedUrl;
          await AsyncStorage.setItem(STORAGE_KEYS.SERVER_URL, detectedUrl);
          console.log("Automatically detected inventory server:", detectedUrl);
        }
      }

      if (cancelled) {
        return;
      }

      if (resolvedUrl) {
        setServerUrlState(resolvedUrl);
        // setBaseUrl(resolvedUrl);
      }

      if (storedTxns) {
        try {
          setTransactions(JSON.parse(storedTxns));
        } catch {
          // Ignore invalid locally cached history.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const saveTransactions = useCallback(async (txns: LocalTransaction[]) => {
    setTransactions(txns);
    await AsyncStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(txns));
  }, []);

  const postTransaction = useCallback(
    async (tx: LocalTransaction, url: string): Promise<boolean> => {
      if (!url) {
        console.log("No server URL saved; cannot sync transaction");
        return false;
      }

      const baseUrl = url.endsWith("/") ? url.slice(0, -1) : url;
      const endpoint = `${baseUrl}/api/transactions`;

      const payload = {
        refNo: tx.refNo,
        movementType: tx.movementType,
        itemCode: tx.itemCode,
        itemName: tx.itemName,
        quantity: tx.quantity,
        unitRate: tx.unitRate,
        godown: tx.godown,
        batchNo: tx.batchNo,
        usedIn: tx.usedIn,
        adjustmentDirection: tx.adjustmentDirection,
        timestamp: tx.timestamp,
      };

      console.log("Posting transaction to:", endpoint);
      console.log("Transaction payload:", payload);

      try {
        const resp = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const text = await resp.text();
        console.log("Transaction response:", resp.status, text);

        return resp.ok;
      } catch (error) {
        console.log("Transaction post failed:", endpoint, error);
        return false;
      }
    },
    [],
  );

  const addTransaction = useCallback(
    async (
      txData: Omit<LocalTransaction, "id" | "synced">,
    ): Promise<boolean> => {
      const tx: LocalTransaction = {
        ...txData,
        id: Date.now().toString() + Math.random().toString(36).substring(2, 7),
        synced: false,
      };

      const updated = [tx, ...transactions];
      await saveTransactions(updated);

      setIsSubmitting(true);
      const ok = await postTransaction(tx, serverUrl);
      setIsSubmitting(false);

      const finalList = updated.map((t) =>
        t.id === tx.id
          ? { ...t, synced: ok, syncError: ok ? undefined : "Pending sync" }
          : t,
      );
      await saveTransactions(finalList);
      setLastSyncResult(ok ? "success" : "error");
      return ok;
    },
    [transactions, serverUrl, saveTransactions, postTransaction],
  );

  const syncPending = useCallback(async () => {
    console.log("syncPending called");
    console.log("Current serverUrl:", serverUrl);
    console.log("Total transactions:", transactions.length);

    if (!serverUrl) {
      console.log("syncPending stopped: no serverUrl");
      return;
    }

    const pending = transactions.filter((t) => !t.synced);
    console.log("Pending transactions:", pending.length);

    if (pending.length === 0) {
      console.log("syncPending stopped: no pending transactions");
      return;
    }

    const results = await Promise.all(
      pending.map(async (tx) => ({
        id: tx.id,
        ok: await postTransaction(tx, serverUrl),
      })),
    );

    console.log("Sync results:", results);

    const updated = transactions.map((tx) => {
      const result = results.find((r) => r.id === tx.id);
      if (result) {
        return {
          ...tx,
          synced: result.ok,
          syncError: result.ok ? undefined : tx.syncError,
        };
      }
      return tx;
    });

    await saveTransactions(updated);

    const anyOk = results.some((r) => r.ok);
    setLastSyncResult(anyOk ? "success" : "error");
  }, [transactions, serverUrl, saveTransactions, postTransaction]);

  const testConnection = useCallback(
    async (url?: string): Promise<boolean> => {
      const candidateUrl = normalizeServerUrl(url || serverUrl);

      if (!candidateUrl) {
        console.log("No server URL supplied");
        return false;
      }

      console.log("Testing inventory server:", candidateUrl);
      return canReachServer(candidateUrl);
    },
    [serverUrl],
  );

  const setServerUrl = useCallback(async (url: string) => {
    const normalizedUrl = normalizeServerUrl(url);
    setServerUrlState(normalizedUrl);
    // setBaseUrl(normalizedUrl);
    await AsyncStorage.setItem(STORAGE_KEYS.SERVER_URL, normalizedUrl);
  }, []);

  const clearHistory = useCallback(async () => {
    await saveTransactions([]);
  }, [saveTransactions]);

  useEffect(() => {
    if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    syncIntervalRef.current = setInterval(() => {
      syncPending();
    }, 30000);
    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
    };
  }, [syncPending]);

  const pendingCount = transactions.filter((t) => !t.synced).length;

  return (
    <SyncContext.Provider
      value={{
        serverUrl,
        setServerUrl,
        transactions,
        pendingCount,
        isSubmitting,
        lastSyncResult,
        addTransaction,
        syncPending,
        clearHistory,
        testConnection,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
}

export function useSync() {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error("useSync must be used within SyncProvider");
  return ctx;
}
