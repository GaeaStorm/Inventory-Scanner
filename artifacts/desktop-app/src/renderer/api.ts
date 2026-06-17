import type {
  CreateTransactionInput,
  InventoryTransaction,
  Product,
} from "./types";

let apiBaseUrl = "";

export function setApiBaseUrl(value: string): void {
  apiBaseUrl = value.replace(/\/$/, "");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!apiBaseUrl) throw new Error("The local API address is unavailable.");

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      message = body.error ?? body.message ?? message;
    } catch {
      // The server did not return JSON.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export function getProducts(): Promise<Product[]> {
  return request<Product[]>("/api/products");
}

export function getTransactions(): Promise<InventoryTransaction[]> {
  return request<InventoryTransaction[]>("/api/transactions");
}

export function createTransaction(
  input: CreateTransactionInput,
): Promise<InventoryTransaction> {
  return request<InventoryTransaction>("/api/transactions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
