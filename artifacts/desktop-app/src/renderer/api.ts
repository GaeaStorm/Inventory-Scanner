import type { DashboardState, WorkbookLocationResponse } from "./types";

let apiBaseUrl = "";

export function setApiBaseUrl(value: string): void {
  apiBaseUrl = value.replace(/\/$/, "");
}

export function buildApiUrl(path: string): string {
  if (!apiBaseUrl) throw new Error("The local API address is unavailable.");
  return `${apiBaseUrl}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(buildApiUrl(path), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Inventory-Session": window.desktop.auth.token(),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string; message?: string };
      message = body.error ?? body.message ?? message;
    } catch {
      // Non-JSON response.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export function getDashboard(limit = 100): Promise<DashboardState> {
  return request<DashboardState>(`/api/dashboard?limit=${limit}`);
}

export function setWorkbookLocation(workbookPath: string): Promise<WorkbookLocationResponse> {
  return request<WorkbookLocationResponse>("/api/workbook/location", {
    method: "PUT",
    body: JSON.stringify({ path: workbookPath }),
  });
}

export function getScannerQrUrl(scannerUrl: string): string {
  return buildApiUrl(`/api/connect/qr.svg?url=${encodeURIComponent(scannerUrl)}`);
}
