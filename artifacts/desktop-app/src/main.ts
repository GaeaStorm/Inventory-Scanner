import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
} from "electron";
import type { Express } from "express";

interface DesktopInfo {
  appVersion: string;
  apiBaseUrl: string;
  dataDirectory: string;
  excelPath: string;
  port: number;
  scannerUrls: string[];
}

const DEFAULT_PORT = 5000;
const developmentRendererUrl = process.env.ELECTRON_RENDERER_URL;

let mainWindow: BrowserWindow | null = null;
let apiServer: Server | null = null;
let desktopInfo: DesktopInfo | null = null;

function preferredPort(): number {
  const configured = Number(process.env.INVENTORY_SCANNER_PORT ?? DEFAULT_PORT);
  return Number.isInteger(configured) && configured > 0 && configured <= 65_535
    ? configured
    : DEFAULT_PORT;
}

function localIpv4Addresses(): string[] {
  const addresses = new Set<string>();

  for (const network of Object.values(os.networkInterfaces())) {
    for (const address of network ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        addresses.add(address.address);
      }
    }
  }

  return [...addresses].sort();
}

function listen(expressApp: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = expressApp.listen(port, "0.0.0.0");

    const handleError = (error: NodeJS.ErrnoException) => {
      server.close();
      reject(error);
    };

    server.once("error", handleError);
    server.once("listening", () => {
      server.off("error", handleError);
      resolve(server);
    });
  });
}

async function startApi(): Promise<DesktopInfo> {
  const dataDirectory = path.join(app.getPath("userData"), "data");
  const excelPath = path.join(dataDirectory, "stock_transactions.xlsx");

  await mkdir(dataDirectory, { recursive: true });

  // This must be assigned before importing the API because the transactions
  // route reads EXCEL_PATH when its module is initialized.
  process.env.EXCEL_PATH = excelPath;

  const { default: inventoryApi } = await import("../../api-server/src/app");


  const requestedPort = preferredPort();
  try {
    apiServer = await listen(inventoryApi, requestedPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    apiServer = await listen(inventoryApi, 0);
  }

  const address = apiServer.address() as AddressInfo;
  const port = address.port;

  return {
    appVersion: app.getVersion(),
    apiBaseUrl: `http://127.0.0.1:${port}`,
    dataDirectory,
    excelPath,
    port,
    scannerUrls: localIpv4Addresses().map(
      (addressValue) => `http://${addressValue}:${port}`,
    ),
  };
}

function registerIpcHandlers(): void {
  ipcMain.handle("desktop:get-info", () => {
    if (!desktopInfo) throw new Error("The local server has not started yet.");
    return desktopInfo;
  });

  ipcMain.handle("desktop:open-data-folder", async () => {
    if (!desktopInfo) return "The local server has not started yet.";
    return shell.openPath(desktopInfo.dataDirectory);
  });

  ipcMain.handle("desktop:show-excel-file", async () => {
    if (!desktopInfo) return false;

    if (existsSync(desktopInfo.excelPath)) {
      shell.showItemInFolder(desktopInfo.excelPath);
    } else {
      await shell.openPath(desktopInfo.dataDirectory);
    }

    return true;
  });
}

async function createWindow(): Promise<void> {
  if (!desktopInfo) throw new Error("Desktop information is unavailable.");

  mainWindow = new BrowserWindow({
    title: "Inventory Scanner",
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    backgroundColor: "#f5f7fb",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  if (developmentRendererUrl) {
    await mainWindow.loadURL(developmentRendererUrl);
  } else {
    await mainWindow.loadFile(
      path.join(__dirname, "renderer", "index.html"),
    );
  }
}

async function bootstrap(): Promise<void> {
  Menu.setApplicationMenu(null);
  desktopInfo = await startApi();
  registerIpcHandlers();
  await createWindow();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    dialog.showErrorBox("Inventory Scanner could not start", message);
    app.quit();
  });
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && desktopInfo) {
    void createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  apiServer?.close();
  apiServer = null;
});
