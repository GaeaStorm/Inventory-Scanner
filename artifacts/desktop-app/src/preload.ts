import { contextBridge, ipcRenderer } from "electron";

let sessionToken = "";

async function authenticatedSession(channel: string, ...args: unknown[]) {
  return ipcRenderer.invoke(channel, sessionToken, ...args);
}

function rememberSession<T extends { token?: string }>(session: T): T {
  if (session?.token) sessionToken = session.token;
  return session;
}

contextBridge.exposeInMainWorld("desktop", {
  getInfo: () => ipcRenderer.invoke("desktop:get-info"),
  auth: {
    state: (token?: string) => ipcRenderer.invoke("auth:state", token ?? sessionToken),
    bootstrap: async (input: unknown) => rememberSession(await ipcRenderer.invoke("auth:bootstrap", input)),
    login: async (input: unknown) => rememberSession(await ipcRenderer.invoke("auth:login", input)),
    resume: async (token: string) => rememberSession(await ipcRenderer.invoke("auth:resume", token)),
    logout: async () => {
      await ipcRenderer.invoke("auth:logout", sessionToken);
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
    saveProductOrderFieldDefinition: (input: unknown) => authenticatedSession("planning:save-product-order-field-definition", input),
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
