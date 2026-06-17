import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  getInfo: () => ipcRenderer.invoke("desktop:get-info"),
  openDataFolder: () => ipcRenderer.invoke("desktop:open-data-folder"),
  showExcelFile: () => ipcRenderer.invoke("desktop:show-excel-file"),
});
