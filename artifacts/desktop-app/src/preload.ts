import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  getInfo: () => ipcRenderer.invoke("desktop:get-info"),
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
    saveBox: (input: unknown) => ipcRenderer.invoke("stores:save-box", input),
    bulkVendorReceipt: (input: unknown) => ipcRenderer.invoke("stores:bulk-vendor-receipt", input),
    review: (input: unknown) => ipcRenderer.invoke("stores:review", input),
    exportBatch: (input: unknown) => ipcRenderer.invoke("stores:export-batch", input),
    confirmImport: (input: unknown) => ipcRenderer.invoke("stores:confirm-import", input),
    backupNow: () => ipcRenderer.invoke("stores:backup-now"),
    chooseFolder: (kind: "backup" | "export") =>
      ipcRenderer.invoke("stores:choose-folder", kind),
    openPath: (targetPath: string) => ipcRenderer.invoke("stores:open-path", targetPath),
  },
});
