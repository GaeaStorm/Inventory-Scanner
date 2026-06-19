import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  getInfo: () => ipcRenderer.invoke("desktop:get-info"),
  printHtml: (html: string) => ipcRenderer.invoke("desktop:print-html", html),
  chooseWorkbookFolder: (currentWorkbookPath?: string) =>
    ipcRenderer.invoke("desktop:choose-workbook-folder", currentWorkbookPath),
  openWorkbookFolder: (workbookPath: string) =>
    ipcRenderer.invoke("desktop:open-workbook-folder", workbookPath),
  openExcelFile: (workbookPath: string) =>
    ipcRenderer.invoke("desktop:open-excel-file", workbookPath),
  showExcelFile: (workbookPath: string) =>
    ipcRenderer.invoke("desktop:show-excel-file", workbookPath),
  tally: {
    getState: () => ipcRenderer.invoke("tally:get-state"),
    testConnection: (settings: unknown) =>
      ipcRenderer.invoke("tally:test-connection", settings),
    syncStores: (settings: unknown) =>
      ipcRenderer.invoke("tally:sync-stores", settings),
  },
  stores: {
    getState: () => ipcRenderer.invoke("stores:get-state"),
    createLocalStockItem: (input: unknown) => ipcRenderer.invoke("stores:create-local-stock-item", input),
    saveBox: (input: unknown) => ipcRenderer.invoke("stores:save-box", input),
    deleteBox: (boxId: string, expectedRevision?: number) =>
      ipcRenderer.invoke("stores:delete-box", boxId, expectedRevision),
    bulkVendorReceipt: (input: unknown) => ipcRenderer.invoke("stores:bulk-vendor-receipt", input),
    review: (input: unknown) => ipcRenderer.invoke("stores:review", input),
    exportBatch: (input: unknown) => ipcRenderer.invoke("stores:export-batch", input),
    confirmImport: (input: unknown) => ipcRenderer.invoke("stores:confirm-import", input),
    backupNow: () => ipcRenderer.invoke("stores:backup-now"),
    setOpeningQuantity: (input: unknown) => ipcRenderer.invoke("stores:set-opening-quantity", input),
    chooseBackupFile: () => ipcRenderer.invoke("stores:choose-backup-file"),
    restoreBackup: (backupPath: string) => ipcRenderer.invoke("stores:restore-backup", backupPath),
    chooseFolder: (kind: "backup" | "export") =>
      ipcRenderer.invoke("stores:choose-folder", kind),
    openPath: (targetPath: string) => ipcRenderer.invoke("stores:open-path", targetPath),
  },
  planning: {
    getState: () => ipcRenderer.invoke("planning:get-state"),
    saveRestockPolicy: (input: unknown) => ipcRenderer.invoke("planning:save-restock-policy", input),
    recommendationDecision: (input: unknown) => ipcRenderer.invoke("planning:recommendation-decision", input),
    saveBom: (input: unknown) => ipcRenderer.invoke("planning:save-bom", input),
    activateBom: (bomId: string) => ipcRenderer.invoke("planning:activate-bom", bomId),
    saveProductOrder: (input: unknown) => ipcRenderer.invoke("planning:save-product-order", input),
    updateProductOrderStatus: (orderId: string, status: string) =>
      ipcRenderer.invoke("planning:update-product-order-status", orderId, status),
    exportRestock: (input: unknown) => ipcRenderer.invoke("planning:export-restock", input),
  },
});
