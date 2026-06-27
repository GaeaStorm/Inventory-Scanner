import { contextBridge, ipcRenderer } from "electron";

let sessionToken = "";
let remoteServerUrl = "";
let localComputerName = "";
let deploymentLoaded = false;

const OFFLINE_READ_DOMAINS: Record<string, "stores" | "planning" | "operations"> = {
  "stores:get-state": "stores",
  "planning:get-state": "planning",
  "operations:get-state": "operations",
};

// The mutation channels offline LAN clients may queue while Production is
// unreachable. Limited to Material In/Out, returns, counts, and
// condition/fault observations per the offline-continuity design; everything
// else stays "Production required" while offline.
const OFFLINE_QUEUE_TYPES: Record<string, string> = {
  "stores:bulk-vendor-receipt": "MATERIAL_IN",
  "operations:issue-production-material": "MATERIAL_OUT",
  "operations:production-return": "PRODUCTION_RETURN",
  "operations:supplier-return": "SUPPLIER_RETURN",
  "operations:initiate-customer-return": "INITIATE_CUSTOMER_RETURN",
  "operations:receive-customer-return": "RECEIVE_CUSTOMER_RETURN",
  "operations:record-count": "RECORD_COUNT",
  "operations:transition-condition": "CONDITION_TRANSITION",
  "operations:create-fault": "CREATE_FAULT",
  "operations:resolve-fault": "RESOLVE_FAULT",
};

function isNetworkFailure(error: unknown): boolean {
  // fetch() rejects with TypeError ("Failed to fetch" / "fetch failed") when
  // the connection itself fails, and DOMException("AbortError") on our
  // timeouts. A response that Production actually answered (even with a 4xx
  // /5xx) reaches `!response.ok` instead and throws a plain Error there - that
  // is Production *rejecting* the request, not Production being unreachable,
  // so it must not fall back to the offline cache/queue.
  return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}

async function getDeploymentState() {
  const state = await ipcRenderer.invoke("deployment:get-state") as {
    role: "UNCONFIGURED" | "PRODUCTION_SERVER" | "LAN_CLIENT";
    productionUrl: string;
    computerName: string;
  };
  remoteServerUrl = state.role === "LAN_CLIENT" ? state.productionUrl.replace(/\/+$/, "") : "";
  localComputerName = state.computerName ?? "";
  deploymentLoaded = true;
  return state;
}

async function ensureDeploymentLoaded(): Promise<void> {
  if (!deploymentLoaded) await getDeploymentState();
}

async function authenticatedSession(channel: string, ...args: unknown[]) {
  await ensureDeploymentLoaded();
  if (remoteServerUrl && (channel === "desktop:print-html" || channel === "desktop:print-html-to-pdf")) {
    return ipcRenderer.invoke(channel, sessionToken, ...args);
  }
  if (remoteServerUrl) return remoteChannel(channel, args);
  return ipcRenderer.invoke(channel, sessionToken, ...args);
}

async function remoteRequest(path: string, init?: RequestInit) {
  await ensureDeploymentLoaded();
  if (!remoteServerUrl) throw new Error("This computer is not configured as a LAN client.");
  const response = await fetch(`${remoteServerUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(sessionToken ? { "X-Inventory-Session": sessionToken } : {}),
      ...(localComputerName ? { "X-Inventory-Computer-Name": localComputerName } : {}),
      ...init?.headers,
    },
  });
  if (response.status === 204) return undefined;
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `Production server returned ${response.status}.`);
  return body;
}

function jsonBody(value: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(value ?? {}) };
}

async function remoteRequestText(path: string): Promise<string> {
  await ensureDeploymentLoaded();
  if (!remoteServerUrl) throw new Error("This computer is not configured as a LAN client.");
  const response = await fetch(`${remoteServerUrl}${path}`, {
    headers: {
      ...(sessionToken ? { "X-Inventory-Session": sessionToken } : {}),
      ...(localComputerName ? { "X-Inventory-Computer-Name": localComputerName } : {}),
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Production server returned ${response.status}.`);
  return body;
}

async function offlineFallback(channel: string, payload: unknown): Promise<unknown> {
  const cacheDomain = OFFLINE_READ_DOMAINS[channel];
  if (cacheDomain) {
    const cached = await ipcRenderer.invoke("sync:read-cache", cacheDomain) as { state: unknown; cachedAt: string } | null;
    if (!cached) throw new Error("Production is unreachable and no cached data is available yet on this computer.");
    return cached.state;
  }
  const queueType = OFFLINE_QUEUE_TYPES[channel];
  if (queueType) {
    const actorUserId = sessionToken;
    const enqueued = await ipcRenderer.invoke("sync:enqueue", {
      type: queueType,
      endpoint: channelEndpoint(channel, payload),
      payload,
      actorUserId,
    }) as { queued: boolean; operationId: string; result?: unknown };
    if (!enqueued.queued) return enqueued.result;
    return { offlineQueued: true, operationId: enqueued.operationId };
  }
  throw new Error("Production is unreachable. This action requires the Production server.");
}

async function remoteChannel(channel: string, args: unknown[]) {
  const [first, second] = args;
  try {
    return await remoteChannelRequest(channel, first, second, args);
  } catch (error) {
    if (!isNetworkFailure(error)) throw error;
    return offlineFallback(channel, first);
  }
}

function channelEndpoint(channel: string, _payload: unknown): string {
  switch (channel) {
    case "stores:bulk-vendor-receipt": return "/api/stores/vendor-receipts/bulk";
    case "operations:issue-production-material": return "/api/operations/production/issue";
    case "operations:production-return": return "/api/operations/returns/production";
    case "operations:supplier-return": return "/api/operations/returns/supplier";
    case "operations:initiate-customer-return": return "/api/operations/returns/customer/initiate";
    case "operations:receive-customer-return": return "/api/operations/returns/customer/receive";
    case "operations:record-count": return "/api/operations/counts/entries";
    case "operations:transition-condition": return "/api/operations/conditions/transition";
    case "operations:create-fault": return "/api/operations/faults";
    case "operations:resolve-fault": return "/api/operations/faults/resolve";
    default: throw new Error(`No queueable endpoint mapping for ${channel}.`);
  }
}

async function remoteChannelRequest(channel: string, first: unknown, second: unknown, args: unknown[]) {
  switch (channel) {
    case "stores:get-state": {
      const state = await remoteRequest("/api/stores/state");
      void ipcRenderer.invoke("sync:write-cache", "stores", state);
      return state;
    }
    case "scanners:create-pairing": return remoteRequest("/api/scanners/pairing", jsonBody({ label: first }));
    case "scanners:list": return remoteRequest("/api/scanners");
    case "scanners:revoke": return remoteRequest(`/api/scanners/${encodeURIComponent(String(first))}`, { method: "DELETE" });
    case "stores:create-local-stock-item": return remoteRequest("/api/stores/catalog/local-items", jsonBody(first));
    case "stores:delete-local-stock-item": return remoteRequest(`/api/stores/catalog/local-items/${encodeURIComponent(String(first))}`, { method: "DELETE" });
    case "stores:save-item-field-definition": return remoteRequest("/api/stores/catalog/item-fields", jsonBody(first));
    case "stores:delete-item-field-definition": return remoteRequest(`/api/stores/catalog/item-fields/${encodeURIComponent(String(first))}`, { method: "DELETE" });
    case "stores:reorder-item-field-definitions": return remoteRequest("/api/stores/catalog/item-fields/reorder", jsonBody({ orderedIds: first, groupName: second }));
    case "stores:create-catalog-group": return remoteRequest("/api/stores/catalog/groups", jsonBody(first));
    case "stores:delete-catalog-group": return remoteRequest(`/api/stores/catalog/groups/${encodeURIComponent(String(first))}`, { method: "DELETE" });
    case "stores:create-stock-category": return remoteRequest("/api/stores/catalog/categories", jsonBody(first));
    case "stores:delete-stock-category": return remoteRequest(`/api/stores/catalog/categories/${encodeURIComponent(String(first))}`, { method: "DELETE" });
    case "stores:set-catalog-status": return remoteRequest("/api/stores/catalog/status", jsonBody(first));
    case "stores:set-group-catalog-role": return remoteRequest("/api/stores/catalog/group-role", jsonBody(first));
    case "stores:set-catalog-role": return remoteRequest("/api/stores/catalog/role", jsonBody(first));
    case "stores:rename-stock-item": return remoteRequest("/api/stores/catalog/rename", jsonBody(first));
    case "stores:export-catalog-cleanup": return remoteRequest("/api/stores/catalog/export-cleanup", jsonBody({}));
    case "stores:save-box": return remoteRequest("/api/stores/boxes", jsonBody(first));
    case "stores:delete-box": return remoteRequest(`/api/stores/boxes/${encodeURIComponent(String(first))}${second == null ? "" : `?revision=${encodeURIComponent(String(second))}`}`, { method: "DELETE" });
    case "stores:bulk-vendor-receipt": return remoteRequest("/api/stores/vendor-receipts/bulk", jsonBody(first));
    case "stores:review": return remoteRequest("/api/stores/review", jsonBody(first));
    case "stores:export-batch": return remoteRequest("/api/stores/export-batch", jsonBody(first));
    case "stores:confirm-import": return remoteRequest("/api/stores/confirm-import", jsonBody(first));
    case "stores:backup-now": return remoteRequest("/api/stores/backup", jsonBody({}));
    case "stores:set-opening-quantity": return remoteRequest("/api/stores/opening-quantity", jsonBody(first));
    case "stores:list-generated-files": return remoteRequest("/api/stores/generated-files");
    case "stores:open-path": return "This folder is on the Production server.";
    case "stores:choose-backup-file":
    case "stores:restore-backup":
    case "stores:choose-folder":
    case "stores:download-generated-file":
      throw new Error("This file operation must be performed on the Production server computer.");
    case "planning:get-state": {
      const state = await remoteRequest("/api/planning/state");
      void ipcRenderer.invoke("sync:write-cache", "planning", state);
      return state;
    }
    case "planning:save-restock-policy": return remoteRequest("/api/planning/restock-policies", jsonBody(first));
    case "planning:recommendation-decision": return remoteRequest("/api/planning/recommendations/decision", jsonBody(first));
    case "planning:save-bom": return remoteRequest("/api/planning/boms", jsonBody(first));
    case "planning:activate-bom": return remoteRequest(`/api/planning/boms/${encodeURIComponent(String(first))}/activate`, jsonBody({}));
    case "planning:save-product-order": return remoteRequest("/api/planning/product-orders", jsonBody(first));
    case "planning:save-sales-order": return remoteRequest("/api/planning/sales-orders", jsonBody(first));
    case "planning:update-product-order-status": return remoteRequest(`/api/planning/product-orders/${encodeURIComponent(String(first))}/status`, jsonBody({ status: second }));
    case "planning:update-product-order-workflow-state": return remoteRequest(`/api/planning/product-orders/${encodeURIComponent(String(first))}/workflow-state`, jsonBody({ workflowStateId: second }));
    case "planning:bulk-update-product-orders": return remoteRequest("/api/planning/product-orders/bulk-update", jsonBody(first));
    case "planning:save-product-order-workflow-state": return remoteRequest("/api/planning/product-order-workflow-states", jsonBody(first));
    case "planning:save-sales-order-workflow-stage": return remoteRequest("/api/planning/sales-order-workflow-stages", jsonBody(first));
    case "planning:delete-product-order-workflow-state": return remoteRequest(`/api/planning/product-order-workflow-states/${encodeURIComponent(String(first))}`, { method: "DELETE" });
    case "planning:save-product-order-field-definition": return remoteRequest("/api/planning/product-order-fields", jsonBody(first));
    case "planning:delete-product-order-field-definition": return remoteRequest(`/api/planning/product-order-fields/${encodeURIComponent(String(first))}`, { method: "DELETE" });
    case "planning:export-restock": return remoteRequest("/api/planning/export", jsonBody(first));
    case "planning:export-sales-order-vouchers": return remoteRequest("/api/planning/sales-orders/export-vouchers", jsonBody(first));
    case "planning:add-sales-order-fulfilment-line": return remoteRequest("/api/planning/sales-orders/fulfilment-lines", jsonBody(first));
    case "planning:advance-fulfilment-line-stage": return remoteRequest(`/api/planning/sales-orders/fulfilment-lines/${encodeURIComponent(String(first))}/stage`, jsonBody({ stage: second }));
    case "planning:assign-resale-supplier": return remoteRequest(`/api/planning/sales-orders/fulfilment-lines/${encodeURIComponent(String(first))}/supplier`, jsonBody({ supplierId: second }));
    case "planning:set-fulfilment-line-service-done": return remoteRequest(`/api/planning/sales-orders/fulfilment-lines/${encodeURIComponent(String(first))}/service-done`, jsonBody({ done: second }));
    case "planning:request-po-approval": return remoteRequest(`/api/planning/sales-orders/${encodeURIComponent(String(first))}/request-po-approval`, jsonBody({}));
    case "planning:set-sales-order-due-date": return remoteRequest(`/api/planning/sales-orders/${encodeURIComponent(String(first))}/due-date`, jsonBody({ dueDate: second }));
    case "planning:set-sales-order-hold-status": return remoteRequest(`/api/planning/sales-orders/${encodeURIComponent(String(first))}/hold-status`, jsonBody({ holdStatus: second }));
    case "planning:set-fulfilment-line-hold-status": return remoteRequest(`/api/planning/sales-orders/fulfilment-lines/${encodeURIComponent(String(first))}/hold-status`, jsonBody({ holdStatus: second }));
    case "planning:submit-crf-for-approval": return remoteRequest(`/api/planning/sales-orders/${encodeURIComponent(String(first))}/submit-crf`, jsonBody({}));
    case "planning:decide-approval": return remoteRequest(`/api/planning/approval-requests/${encodeURIComponent(String(first))}/decisions`, jsonBody({ decision: second, comment: args[2] }));
    case "planning:save-checklist-template": return remoteRequest("/api/planning/checklist-templates", jsonBody(first));
    case "planning:waive-checklist-requirement": return remoteRequest(`/api/planning/sales-orders/${encodeURIComponent(String(first))}/checklist/${encodeURIComponent(String(second))}/waive`, jsonBody({ reason: args[2] }));
    case "planning:get-checklist-results-for-order": return remoteRequest(`/api/planning/sales-orders/${encodeURIComponent(String(first))}/checklist`);
    case "planning:advance-sales-order-stage": return remoteRequest(`/api/planning/sales-orders/${encodeURIComponent(String(first))}/stage`, jsonBody({ stage: second }));
    case "planning:apply-source-amendment": return remoteRequest(`/api/planning/sales-orders/source-amendments/${encodeURIComponent(String(first))}/apply`, jsonBody({}));
    case "planning:request-crf-reapproval": return remoteRequest(`/api/planning/sales-orders/${encodeURIComponent(String(first))}/request-crf-reapproval`, jsonBody({}));
    case "planning:get-crf-html": return remoteRequestText(`/api/planning/crf-revisions/${encodeURIComponent(String(first))}/html`);
    case "operations:get-state": {
      const state = await remoteRequest("/api/operations/state");
      void ipcRenderer.invoke("sync:write-cache", "operations", state);
      return state;
    }
    case "operations:save-user": return remoteRequest("/api/operations/users", jsonBody(first));
    case "operations:reset-credential": return remoteRequest("/api/operations/users/reset-credential", jsonBody(first));
    case "operations:list-roles": return remoteRequest("/api/operations/roles");
    case "operations:create-role": return remoteRequest("/api/operations/roles", jsonBody({ name: first }));
    case "operations:get-role-permissions": return remoteRequest("/api/operations/role-permissions");
    case "operations:set-role-permission": return remoteRequest("/api/operations/role-permissions", jsonBody(first));
    case "operations:get-computer-restrictions": return remoteRequest("/api/operations/computer-restrictions");
    case "operations:set-computer-restriction": return remoteRequest("/api/operations/computer-restrictions", jsonBody(first));
    case "operations:transition-condition": return remoteRequest("/api/operations/conditions/transition", jsonBody(first));
    case "operations:create-fault": return remoteRequest("/api/operations/faults", jsonBody(first));
    case "operations:resolve-fault": return remoteRequest("/api/operations/faults/resolve", jsonBody(first));
    case "operations:create-count": return remoteRequest("/api/operations/counts", jsonBody(first));
    case "operations:record-count": return remoteRequest("/api/operations/counts/entries", jsonBody(first));
    case "operations:finalize-count": return remoteRequest("/api/operations/counts/finalize", jsonBody(first));
    case "operations:production-return": return remoteRequest("/api/operations/returns/production", jsonBody(first));
    case "operations:supplier-return": return remoteRequest("/api/operations/returns/supplier", jsonBody(first));
    case "operations:update-supplier-return": return remoteRequest("/api/operations/returns/supplier", { method: "PATCH", body: JSON.stringify(first) });
    case "operations:initiate-customer-return": return remoteRequest("/api/operations/returns/customer/initiate", jsonBody(first));
    case "operations:receive-customer-return": return remoteRequest("/api/operations/returns/customer/receive", jsonBody(first));
    case "operations:scrap": return remoteRequest("/api/operations/scrap", jsonBody(first));
    case "operations:release-product-order": return remoteRequest("/api/operations/production/release", jsonBody(first));
    case "operations:issue-production-material": return remoteRequest("/api/operations/production/issue", jsonBody(first));
    case "operations:production-completion": return remoteRequest("/api/operations/production/complete", jsonBody(first));
    case "operations:set-product-order-status": return remoteRequest("/api/operations/production/status", jsonBody(first));
    case "operations:resolve-sync-exception": return remoteRequest("/api/operations/sync-exceptions/resolve", jsonBody(first));
    case "operations:reverse-movement": return remoteRequest("/api/operations/movements/reverse", jsonBody(first));
    case "operations:review-manual-tally": return remoteRequest("/api/operations/tally-reviews", jsonBody(first));
    case "tally:get-state": return remoteRequest("/api/tally/state");
    case "tally:test-connection": return remoteRequest("/api/tally/test", jsonBody(first));
    case "tally:sync-stores": return remoteRequest("/api/tally/sync", jsonBody(first));
    default: throw new Error(`LAN client operation is not available: ${channel}`);
  }
}

interface RememberableSession {
  token?: string;
  expiresAt?: string;
  user?: { userId: string; displayName: string; role: string };
  permissions?: string[];
}

function rememberSession<T>(session: T): T {
  const candidate = session as unknown as RememberableSession;
  if (candidate?.token) {
    sessionToken = candidate.token;
    if (remoteServerUrl) {
      void ipcRenderer.invoke("sync:set-session", sessionToken);
      void saveOfflinePermissionSnapshot(candidate);
    }
  }
  return session;
}

async function saveOfflinePermissionSnapshot(session: RememberableSession): Promise<void> {
  if (!session.user || !session.permissions || !session.expiresAt || !sessionToken) return;
  const deviceFingerprint = await ipcRenderer.invoke("sync:device-id") as string;
  await ipcRenderer.invoke("sync:save-permission-snapshot", {
    sessionToken,
    deviceFingerprint,
    userId: session.user.userId,
    displayName: session.user.displayName,
    role: session.user.role,
    permissions: session.permissions,
    expiresAt: session.expiresAt,
  });
}

async function offlineAuthFallback(token: string): Promise<unknown> {
  const deviceFingerprint = await ipcRenderer.invoke("sync:device-id") as string;
  const snapshot = await ipcRenderer.invoke("sync:read-permission-snapshot") as {
    sessionToken: string;
    deviceFingerprint: string;
    userId: string;
    displayName: string;
    role: string;
    permissions: string[];
    expiresAt: string;
  } | null;
  if (
    !snapshot
    || snapshot.sessionToken !== token
    || snapshot.deviceFingerprint !== deviceFingerprint
    || snapshot.expiresAt <= new Date().toISOString()
  ) {
    throw new Error("Production is unreachable and no valid offline session was found on this computer. Reconnect to Production to sign in.");
  }
  return {
    token,
    expiresAt: snapshot.expiresAt,
    user: { userId: snapshot.userId, displayName: snapshot.displayName, role: snapshot.role },
    permissions: snapshot.permissions,
    offline: true,
  };
}

contextBridge.exposeInMainWorld("desktop", {
  deployment: {
    getState: () => getDeploymentState(),
    testProduction: (input: unknown) => ipcRenderer.invoke("deployment:test-production", input),
    save: (input: unknown) => ipcRenderer.invoke("deployment:save", input),
  },
  getInfo: async () => {
    const info = await ipcRenderer.invoke("desktop:get-info");
    remoteServerUrl = info.deploymentRole === "LAN_CLIENT" ? String(info.apiBaseUrl).replace(/\/+$/, "") : "";
    deploymentLoaded = true;
    return info;
  },
  auth: {
    state: async (token?: string) => {
      await ensureDeploymentLoaded();
      if (!remoteServerUrl) return ipcRenderer.invoke("auth:state", token ?? sessionToken);
      try {
        return await remoteRequest("/api/operations/auth/state", { headers: token ? { "X-Inventory-Session": token } : undefined });
      } catch (error) {
        if (!isNetworkFailure(error) || !(token ?? sessionToken)) throw error;
        return offlineAuthFallback(token ?? sessionToken);
      }
    },
    bootstrap: async (input: unknown) => {
      await ensureDeploymentLoaded();
      return rememberSession(remoteServerUrl
        ? await remoteRequest("/api/operations/auth/bootstrap", jsonBody(input))
        : await ipcRenderer.invoke("auth:bootstrap", input));
    },
    login: async (input: unknown) => {
      await ensureDeploymentLoaded();
      return rememberSession(remoteServerUrl
        ? await remoteRequest("/api/operations/auth/login", jsonBody(input))
        : await ipcRenderer.invoke("auth:login", input));
    },
    updateEmail: async (input: unknown) => {
      await ensureDeploymentLoaded();
      return remoteServerUrl
        ? remoteRequest("/api/operations/auth/email", jsonBody(input))
        : ipcRenderer.invoke("auth:update-email", sessionToken, input);
    },
    requestRecovery: async (input: unknown) => {
      await ensureDeploymentLoaded();
      return remoteServerUrl
        ? remoteRequest("/api/operations/auth/recovery/request", jsonBody(input))
        : ipcRenderer.invoke("auth:request-recovery", input);
    },
    confirmRecovery: async (input: unknown) => {
      await ensureDeploymentLoaded();
      return remoteServerUrl
        ? remoteRequest("/api/operations/auth/recovery/confirm", jsonBody(input))
        : ipcRenderer.invoke("auth:confirm-recovery", input);
    },
    resume: async (token: string) => {
      await ensureDeploymentLoaded();
      sessionToken = token;
      if (!remoteServerUrl) return rememberSession(await ipcRenderer.invoke("auth:resume", token));
      try {
        return rememberSession(await remoteRequest("/api/operations/auth/resume", jsonBody({ token })));
      } catch (error) {
        if (!isNetworkFailure(error)) throw error;
        void ipcRenderer.invoke("sync:set-session", token);
        return offlineAuthFallback(token);
      }
    },
    logout: async () => {
      await ensureDeploymentLoaded();
      if (remoteServerUrl) {
        try {
          await remoteRequest("/api/operations/auth/logout", { method: "POST" });
        } catch (error) {
          if (!isNetworkFailure(error)) throw error;
        }
        void ipcRenderer.invoke("sync:clear-permission-snapshot");
      } else {
        await ipcRenderer.invoke("auth:logout", sessionToken);
      }
      sessionToken = "";
    },
    token: () => sessionToken,
  },
  sync: {
    status: async () => {
      await ensureDeploymentLoaded();
      if (!remoteServerUrl) return { online: true, queuedCount: 0, reviewable: [] };
      return ipcRenderer.invoke("sync:status");
    },
  },
  printHtml: (html: string) => authenticatedSession("desktop:print-html", html),
  chooseWorkbookFolder: (currentWorkbookPath?: string) => authenticatedSession("desktop:choose-workbook-folder", currentWorkbookPath),
  openWorkbookFolder: (workbookPath: string) => authenticatedSession("desktop:open-workbook-folder", workbookPath),
  openExcelFile: (workbookPath: string) => authenticatedSession("desktop:open-excel-file", workbookPath),
  showExcelFile: (workbookPath: string) => authenticatedSession("desktop:show-excel-file", workbookPath),
  tally: {
    getState: () => authenticatedSession("tally:get-state"),
    testConnection: (settings: unknown) => authenticatedSession("tally:test-connection", settings),
    syncStores: (settings: unknown) => authenticatedSession("tally:sync-stores", settings),
  },
  stores: {
    getState: () => authenticatedSession("stores:get-state"),
    createLocalStockItem: (input: unknown) => authenticatedSession("stores:create-local-stock-item", input),
    deleteLocalStockItem: (tallyItemGuid: string) => authenticatedSession("stores:delete-local-stock-item", tallyItemGuid),
    saveItemFieldDefinition: (input: { groupName?: string; label: string; required: boolean }) => authenticatedSession("stores:save-item-field-definition", input),
    deleteItemFieldDefinition: (fieldId: string) => authenticatedSession("stores:delete-item-field-definition", fieldId),
    reorderItemFieldDefinitions: (orderedIds: string[], groupName: string) => authenticatedSession("stores:reorder-item-field-definitions", orderedIds, groupName),
    createCatalogGroup: (input: unknown) => authenticatedSession("stores:create-catalog-group", input),
    deleteCatalogGroup: (name: string) => authenticatedSession("stores:delete-catalog-group", name),
    createStockCategory: (input: unknown) => authenticatedSession("stores:create-stock-category", input),
    deleteStockCategory: (name: string) => authenticatedSession("stores:delete-stock-category", name),
    setCatalogStatus: (input: unknown) => authenticatedSession("stores:set-catalog-status", input),
    setGroupCatalogRole: (input: { groupName: string; role: string }) => authenticatedSession("stores:set-group-catalog-role", input),
    setCatalogRole: (input: { tallyItemGuid: string; role: string | null }) => authenticatedSession("stores:set-catalog-role", input),
    renameStockItem: (input: unknown) => authenticatedSession("stores:rename-stock-item", input),
    exportCatalogCleanup: () => authenticatedSession("stores:export-catalog-cleanup"),
    saveBox: (input: unknown) => authenticatedSession("stores:save-box", input),
    deleteBox: (boxId: string, expectedRevision?: number) => authenticatedSession("stores:delete-box", boxId, expectedRevision),
    bulkVendorReceipt: (input: unknown) => authenticatedSession("stores:bulk-vendor-receipt", input),
    review: (input: unknown) => authenticatedSession("stores:review", input),
    exportBatch: (input: unknown) => authenticatedSession("stores:export-batch", input),
    confirmImport: (input: unknown) => authenticatedSession("stores:confirm-import", input),
    backupNow: () => authenticatedSession("stores:backup-now"),
    setOpeningQuantity: (input: unknown) => authenticatedSession("stores:set-opening-quantity", input),
    chooseBackupFile: () => authenticatedSession("stores:choose-backup-file"),
    restoreBackup: (backupPath: string) => authenticatedSession("stores:restore-backup", backupPath),
    chooseFolder: (kind: "backup" | "export") => authenticatedSession("stores:choose-folder", kind),
    openPath: (targetPath: string) => authenticatedSession("stores:open-path", targetPath),
    listGeneratedFiles: () => authenticatedSession("stores:list-generated-files"),
    downloadGeneratedFile: (sourcePath: string) => authenticatedSession("stores:download-generated-file", sourcePath),
  },
  scanners: {
    createPairing: (label: string) => authenticatedSession("scanners:create-pairing", label),
    list: () => authenticatedSession("scanners:list"),
    revoke: (deviceId: string) => authenticatedSession("scanners:revoke", deviceId),
  },
  planning: {
    getState: () => authenticatedSession("planning:get-state"),
    saveRestockPolicy: (input: unknown) => authenticatedSession("planning:save-restock-policy", input),
    recommendationDecision: (input: unknown) => authenticatedSession("planning:recommendation-decision", input),
    saveBom: (input: unknown) => authenticatedSession("planning:save-bom", input),
    activateBom: (bomId: string) => authenticatedSession("planning:activate-bom", bomId),
    saveProductOrder: (input: unknown) => authenticatedSession("planning:save-product-order", input),
    saveSalesOrder: (input: unknown) => authenticatedSession("planning:save-sales-order", input),
    updateProductOrderStatus: (orderId: string, status: string) => authenticatedSession("planning:update-product-order-status", orderId, status),
    updateProductOrderWorkflowState: (orderId: string, workflowStateId: string) => authenticatedSession("planning:update-product-order-workflow-state", orderId, workflowStateId),
    bulkUpdateProductOrders: (input: unknown) => authenticatedSession("planning:bulk-update-product-orders", input),
    saveProductOrderWorkflowState: (input: unknown) => authenticatedSession("planning:save-product-order-workflow-state", input),
    saveSalesOrderWorkflowStage: (input: unknown) => authenticatedSession("planning:save-sales-order-workflow-stage", input),
    deleteProductOrderWorkflowState: (stateId: string) => authenticatedSession("planning:delete-product-order-workflow-state", stateId),
    deleteSalesOrderWorkflowStage: (input: unknown) => authenticatedSession("planning:delete-sales-order-workflow-stage", input),
    saveProductOrderFieldDefinition: (input: unknown) => authenticatedSession("planning:save-product-order-field-definition", input),
    deleteProductOrderFieldDefinition: (fieldId: string) => authenticatedSession("planning:delete-product-order-field-definition", fieldId),
    exportRestock: (input: unknown) => authenticatedSession("planning:export-restock", input),
    exportSalesOrderVouchers: (input: unknown) => authenticatedSession("planning:export-sales-order-vouchers", input),
    addSalesOrderFulfilmentLine: (input: unknown) => authenticatedSession("planning:add-sales-order-fulfilment-line", input),
    advanceFulfilmentLineStage: (fulfilmentLineId: string, targetStage: string) => authenticatedSession("planning:advance-fulfilment-line-stage", fulfilmentLineId, targetStage),
    assignResaleSupplier: (fulfilmentLineId: string, supplierId: number) => authenticatedSession("planning:assign-resale-supplier", fulfilmentLineId, supplierId),
    setFulfilmentLineServiceDone: (fulfilmentLineId: string, done: boolean) => authenticatedSession("planning:set-fulfilment-line-service-done", fulfilmentLineId, done),
    requestPoApproval: (salesOrderId: string) => authenticatedSession("planning:request-po-approval", salesOrderId),
    setSalesOrderDueDate: (salesOrderId: string, dueDate: string) => authenticatedSession("planning:set-sales-order-due-date", salesOrderId, dueDate),
    setSalesOrderHoldStatus: (salesOrderId: string, holdStatus: "NONE" | "ON_HOLD" | "CANCELLED") => authenticatedSession("planning:set-sales-order-hold-status", salesOrderId, holdStatus),
    setFulfilmentLineHoldStatus: (fulfilmentLineId: string, holdStatus: "NONE" | "ON_HOLD" | "CANCELLED") => authenticatedSession("planning:set-fulfilment-line-hold-status", fulfilmentLineId, holdStatus),
    submitCrfForApproval: (salesOrderId: string) => authenticatedSession("planning:submit-crf-for-approval", salesOrderId),
    decideApproval: (requestId: string, decision: "APPROVE" | "REJECT", comment: string) => authenticatedSession("planning:decide-approval", requestId, decision, comment),
    saveChecklistTemplate: (input: unknown) => authenticatedSession("planning:save-checklist-template", input),
    waiveChecklistRequirement: (salesOrderId: string, requirementId: string, reason: string) => authenticatedSession("planning:waive-checklist-requirement", salesOrderId, requirementId, reason),
    getChecklistResultsForOrder: (salesOrderId: string) => authenticatedSession("planning:get-checklist-results-for-order", salesOrderId),
    advanceSalesOrderStage: (orderId: string, targetStage: string) => authenticatedSession("planning:advance-sales-order-stage", orderId, targetStage),
    applySourceAmendment: (amendmentId: string) => authenticatedSession("planning:apply-source-amendment", amendmentId),
    requestCrfReapproval: (salesOrderId: string) => authenticatedSession("planning:request-crf-reapproval", salesOrderId),
    getCrfHtml: (revisionId: string) => authenticatedSession("planning:get-crf-html", revisionId),
    printCrfToPdf: (html: string, suggestedName: string) => authenticatedSession("desktop:print-html-to-pdf", html, suggestedName),
  },
  operations: {
    getState: () => authenticatedSession("operations:get-state"),
    saveUser: (input: unknown) => authenticatedSession("operations:save-user", input),
    resetCredential: (input: unknown) => authenticatedSession("operations:reset-credential", input),
    listRoles: () => authenticatedSession("operations:list-roles"),
    createRole: (name: string) => authenticatedSession("operations:create-role", name),
    deleteRole: (name: string) => authenticatedSession("operations:delete-role", name),
    getRolePermissions: () => authenticatedSession("operations:get-role-permissions"),
    setRolePermission: (input: { roleName: string; permission: string; enabled: boolean }) => authenticatedSession("operations:set-role-permission", input),
    getComputerRestrictions: () => authenticatedSession("operations:get-computer-restrictions"),
    setComputerRestriction: (input: { permission: string; computerNames: string[] }) => authenticatedSession("operations:set-computer-restriction", input),
    transitionCondition: (input: unknown) => authenticatedSession("operations:transition-condition", input),
    createFault: (input: unknown) => authenticatedSession("operations:create-fault", input),
    resolveFault: (input: unknown) => authenticatedSession("operations:resolve-fault", input),
    createCount: (input: unknown) => authenticatedSession("operations:create-count", input),
    recordCount: (input: unknown) => authenticatedSession("operations:record-count", input),
    finalizeCount: (input: unknown) => authenticatedSession("operations:finalize-count", input),
    productionReturn: (input: unknown) => authenticatedSession("operations:production-return", input),
    supplierReturn: (input: unknown) => authenticatedSession("operations:supplier-return", input),
    updateSupplierReturn: (input: unknown) => authenticatedSession("operations:update-supplier-return", input),
    initiateCustomerReturn: (input: unknown) => authenticatedSession("operations:initiate-customer-return", input),
    receiveCustomerReturn: (input: unknown) => authenticatedSession("operations:receive-customer-return", input),
    scrap: (input: unknown) => authenticatedSession("operations:scrap", input),
    releaseProductOrder: (input: unknown) => authenticatedSession("operations:release-product-order", input),
    issueProductionMaterial: (input: unknown) => authenticatedSession("operations:issue-production-material", input),
    productionCompletion: (input: unknown) => authenticatedSession("operations:production-completion", input),
    setProductOrderStatus: (input: unknown) => authenticatedSession("operations:set-product-order-status", input),
    resolveSyncException: (input: unknown) => authenticatedSession("operations:resolve-sync-exception", input),
    reverseMovement: (input: unknown) => authenticatedSession("operations:reverse-movement", input),
    reviewManualTally: (input: unknown) => authenticatedSession("operations:review-manual-tally", input),
  },
});
