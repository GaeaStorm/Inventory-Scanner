import { contextBridge, ipcRenderer } from "electron";

let sessionToken = "";
const remoteServerUrl = (process.env.INVENTORY_SCANNER_REMOTE_URL ?? "").trim().replace(/\/+$/, "");

async function authenticatedSession(channel: string, ...args: unknown[]) {
  if (remoteServerUrl && channel === "desktop:print-html") {
    return ipcRenderer.invoke(channel, sessionToken, ...args);
  }
  if (remoteServerUrl) return remoteChannel(channel, args);
  return ipcRenderer.invoke(channel, sessionToken, ...args);
}

async function remoteRequest(path: string, init?: RequestInit) {
  const response = await fetch(`${remoteServerUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(sessionToken ? { "X-Inventory-Session": sessionToken } : {}),
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

async function remoteChannel(channel: string, args: unknown[]) {
  const [first, second] = args;
  switch (channel) {
    case "stores:get-state": return remoteRequest("/api/stores/state");
    case "stores:create-local-stock-item": return remoteRequest("/api/stores/catalog/local-items", jsonBody(first));
    case "stores:set-catalog-status": return remoteRequest("/api/stores/catalog/status", jsonBody(first));
    case "stores:set-catalog-classification": return remoteRequest("/api/stores/catalog/classification", jsonBody(first));
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
    case "planning:get-state": return remoteRequest("/api/planning/state");
    case "planning:save-restock-policy": return remoteRequest("/api/planning/restock-policies", jsonBody(first));
    case "planning:recommendation-decision": return remoteRequest("/api/planning/recommendations/decision", jsonBody(first));
    case "planning:save-bom": return remoteRequest("/api/planning/boms", jsonBody(first));
    case "planning:activate-bom": return remoteRequest(`/api/planning/boms/${encodeURIComponent(String(first))}/activate`, jsonBody({}));
    case "planning:save-product-order": return remoteRequest("/api/planning/product-orders", jsonBody(first));
    case "planning:update-product-order-status": return remoteRequest(`/api/planning/product-orders/${encodeURIComponent(String(first))}/status`, jsonBody({ status: second }));
    case "planning:update-product-order-workflow-state": return remoteRequest(`/api/planning/product-orders/${encodeURIComponent(String(first))}/workflow-state`, jsonBody({ workflowStateId: second }));
    case "planning:save-product-order-workflow-state": return remoteRequest("/api/planning/product-order-workflow-states", jsonBody(first));
    case "planning:delete-product-order-workflow-state": return remoteRequest(`/api/planning/product-order-workflow-states/${encodeURIComponent(String(first))}`, { method: "DELETE" });
    case "planning:save-product-order-field-definition": return remoteRequest("/api/planning/product-order-fields", jsonBody(first));
    case "planning:delete-product-order-field-definition": return remoteRequest(`/api/planning/product-order-fields/${encodeURIComponent(String(first))}`, { method: "DELETE" });
    case "planning:export-restock": return remoteRequest("/api/planning/export", jsonBody(first));
    case "operations:get-state": return remoteRequest("/api/operations/state");
    case "operations:save-user": return remoteRequest("/api/operations/users", jsonBody(first));
    case "operations:reset-credential": return remoteRequest("/api/operations/users/reset-credential", jsonBody(first));
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

function rememberSession<T extends { token?: string }>(session: T): T {
  if (session?.token) sessionToken = session.token;
  return session;
}

contextBridge.exposeInMainWorld("desktop", {
  getInfo: () => ipcRenderer.invoke("desktop:get-info"),
  auth: {
    state: (token?: string) => remoteServerUrl
      ? remoteRequest("/api/operations/auth/state", { headers: token ? { "X-Inventory-Session": token } : undefined })
      : ipcRenderer.invoke("auth:state", token ?? sessionToken),
    bootstrap: async (input: unknown) => rememberSession(remoteServerUrl
      ? await remoteRequest("/api/operations/auth/bootstrap", jsonBody(input))
      : await ipcRenderer.invoke("auth:bootstrap", input)),
    login: async (input: unknown) => rememberSession(remoteServerUrl
      ? await remoteRequest("/api/operations/auth/login", jsonBody(input))
      : await ipcRenderer.invoke("auth:login", input)),
    forgotPassword: async (input: unknown) => {
      if (remoteServerUrl) {
        throw new Error("For security, forgotten credentials must be reset on the Production server computer or by an administrator.");
      }
      return ipcRenderer.invoke("auth:forgot-password", input);
    },
    resume: async (token: string) => {
      sessionToken = token;
      return rememberSession(remoteServerUrl
        ? await remoteRequest("/api/operations/auth/resume", jsonBody({ token }))
        : await ipcRenderer.invoke("auth:resume", token));
    },
    logout: async () => {
      if (remoteServerUrl) await remoteRequest("/api/operations/auth/logout", { method: "POST" });
      else await ipcRenderer.invoke("auth:logout", sessionToken);
      sessionToken = "";
    },
    token: () => sessionToken,
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
    setCatalogStatus: (input: unknown) => authenticatedSession("stores:set-catalog-status", input),
    setCatalogClassification: (input: unknown) => authenticatedSession("stores:set-catalog-classification", input),
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
  planning: {
    getState: () => authenticatedSession("planning:get-state"),
    saveRestockPolicy: (input: unknown) => authenticatedSession("planning:save-restock-policy", input),
    recommendationDecision: (input: unknown) => authenticatedSession("planning:recommendation-decision", input),
    saveBom: (input: unknown) => authenticatedSession("planning:save-bom", input),
    activateBom: (bomId: string) => authenticatedSession("planning:activate-bom", bomId),
    saveProductOrder: (input: unknown) => authenticatedSession("planning:save-product-order", input),
    updateProductOrderStatus: (orderId: string, status: string) => authenticatedSession("planning:update-product-order-status", orderId, status),
    updateProductOrderWorkflowState: (orderId: string, workflowStateId: string) => authenticatedSession("planning:update-product-order-workflow-state", orderId, workflowStateId),
    saveProductOrderWorkflowState: (input: unknown) => authenticatedSession("planning:save-product-order-workflow-state", input),
    deleteProductOrderWorkflowState: (stateId: string) => authenticatedSession("planning:delete-product-order-workflow-state", stateId),
    saveProductOrderFieldDefinition: (input: unknown) => authenticatedSession("planning:save-product-order-field-definition", input),
    deleteProductOrderFieldDefinition: (fieldId: string) => authenticatedSession("planning:delete-product-order-field-definition", fieldId),
    exportRestock: (input: unknown) => authenticatedSession("planning:export-restock", input),
  },
  operations: {
    getState: () => authenticatedSession("operations:get-state"),
    saveUser: (input: unknown) => authenticatedSession("operations:save-user", input),
    resetCredential: (input: unknown) => authenticatedSession("operations:reset-credential", input),
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
