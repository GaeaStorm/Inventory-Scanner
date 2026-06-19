import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type OpenDialogOptions,
} from "electron";
import express, { type Express } from "express";

import { ApplicationDatabase } from "./database/application-database";
import { TallyService } from "./tally/service";
import { createStoresRouter } from "./stores/router";
import { StoresDatabase } from "./stores/database";
import { StoresService } from "./stores/service";
import { createPlanningRouter } from "./planning/router";
import { PlanningService } from "./planning/service";

interface DesktopInfo {
  appVersion: string;
  apiBaseUrl: string;
  dataDirectory: string;
  excelPath: string;
  databasePath: string;
  port: number;
  scannerUrls: string[];
}

const DEFAULT_PORT = 5000;
const developmentRendererUrl = process.env.ELECTRON_RENDERER_URL;

function applicationIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app-logo.png")
    : path.join(__dirname, "..", "build", "public", "logo.png");
}

let mainWindow: BrowserWindow | null = null;
let apiServer: Server | null = null;
let desktopInfo: DesktopInfo | null = null;
let tallyService: TallyService | null = null;
let storesService: StoresService | null = null;
let planningService: PlanningService | null = null;
let applicationDatabase: ApplicationDatabase | null = null;

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

  // This must be assigned before importing the API because the workbook
  // module reads its initial location when it is loaded.
  process.env.EXCEL_PATH = excelPath;

  const { default: inventoryApi } = await import("../../api-server/src/app");
  const desktopApi = express();

  desktopApi.use(express.json({ limit: "2mb" }));
  desktopApi.use(express.urlencoded({ extended: true }));
  desktopApi.use((_request, response, next) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
    if (_request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }
    next();
  });

  if (!storesService) throw new Error("The Local Stores Database is unavailable.");
  desktopApi.use("/api/stores", createStoresRouter(storesService));
  if (!planningService) throw new Error("The Planning service is unavailable.");
  desktopApi.use("/api/planning", createPlanningRouter(planningService));

  // Keep the original endpoint compatible with older clients, but make the
  // SQLite Stores Catalog authoritative after Tally synchronization.
  desktopApi.get("/api/products", (_request, response, next) => {
    const stockItems = storesService?.getState().stockItems ?? [];
    if (stockItems.length === 0) {
      next();
      return;
    }
    response.json(stockItems.map((item) => ({
      id: item.tallyGuid,
      name: item.name,
      unit: "count",
    })));
  });
  desktopApi.use(inventoryApi);

  const requestedPort = preferredPort();
  try {
    apiServer = await listen(desktopApi, requestedPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    apiServer = await listen(desktopApi, 0);
  }

  const address = apiServer.address() as AddressInfo;
  const port = address.port;

  return {
    appVersion: app.getVersion(),
    apiBaseUrl: `http://127.0.0.1:${port}`,
    dataDirectory,
    excelPath,
    databasePath: storesService.database.databasePath,
    port,
    scannerUrls: localIpv4Addresses().map(
      (addressValue) => `http://${addressValue}:${port}`,
    ),
  };
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.normalize(value);
}

interface PrintResult {
  success: boolean;
  failureReason?: string;
}

function printableHtml(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Printable HTML is required.");
  }
  if (Buffer.byteLength(value, "utf8") > 25 * 1024 * 1024) {
    throw new Error("The print job is too large. Reduce the number of labels and try again.");
  }
  return value;
}

async function printHtmlDocument(html: string): Promise<PrintResult> {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "inventory-scanner-print-"),
  );
  const printFilePath = path.join(temporaryDirectory, "labels.html");
  await writeFile(printFilePath, html, "utf8");

  const printWindow = new BrowserWindow({
    title: "Print Inventory Labels",
    width: 1100,
    height: 800,
    show: false,
    parent: mainWindow ?? undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      javascript: false,
    },
  });

  try {
    await printWindow.loadFile(printFilePath);

    return await new Promise<PrintResult>((resolve) => {
      printWindow.webContents.print(
        {
          silent: false,
          printBackground: true,
        },
        (success, failureReason) => {
          resolve({
            success,
            failureReason: success
              ? undefined
              : failureReason || "The operating system did not accept the print job.",
          });
        },
      );
    });
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle("desktop:get-info", () => {
    if (!desktopInfo) throw new Error("The local server has not started yet.");
    return desktopInfo;
  });

  ipcMain.handle("desktop:print-html", async (_event, html: unknown) =>
    printHtmlDocument(printableHtml(html)),
  );

  ipcMain.handle(
    "desktop:choose-workbook-folder",
    async (_event, currentWorkbookPath?: string) => {
      const fallbackPath = desktopInfo?.dataDirectory ?? app.getPath("documents");
      const requestedPath =
        typeof currentWorkbookPath === "string" &&
        path.isAbsolute(currentWorkbookPath)
          ? path.dirname(currentWorkbookPath)
          : fallbackPath;
      const options: OpenDialogOptions = {
        title: "Choose the Inventory Scanner data folder",
        buttonLabel: "Use this folder",
        defaultPath: requestedPath,
        properties: ["openDirectory", "createDirectory"],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);

      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );

  ipcMain.handle(
    "desktop:open-workbook-folder",
    async (_event, workbookPath: unknown) => {
      const resolvedPath = absolutePath(workbookPath, "Workbook path");
      return shell.openPath(path.dirname(resolvedPath));
    },
  );

  ipcMain.handle(
    "desktop:open-excel-file",
    async (_event, workbookPath: unknown) => {
      const resolvedPath = absolutePath(workbookPath, "Workbook path");
      return shell.openPath(resolvedPath);
    },
  );

  ipcMain.handle(
    "desktop:show-excel-file",
    async (_event, workbookPath: unknown) => {
      const resolvedPath = absolutePath(workbookPath, "Workbook path");
      if (existsSync(resolvedPath)) {
        shell.showItemInFolder(resolvedPath);
        return true;
      }
      await shell.openPath(path.dirname(resolvedPath));
      return false;
    },
  );

  ipcMain.handle("tally:get-state", async () => {
    if (!tallyService) throw new Error("The Tally service is unavailable.");
    return tallyService.getState();
  });

  ipcMain.handle("tally:test-connection", async (_event, settings: unknown) => {
    if (!tallyService) throw new Error("The Tally service is unavailable.");
    return tallyService.testConnection(settings);
  });

  ipcMain.handle("tally:sync-stores", async (_event, settings: unknown) => {
    if (!tallyService || !storesService) throw new Error("The Tally or Stores service is unavailable.");
    const snapshot = await tallyService.syncStores(settings);
    if (snapshot.stockItems.length > 0 && storesService.getState().dataMode === "demo") {
      planningService?.resetForCatalogReplacement();
    }
    const summary = storesService.sync(snapshot);
    return { snapshot, summary, state: storesService.getState() };
  });

  ipcMain.handle("stores:get-state", () => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.getState();
  });

  ipcMain.handle("stores:create-local-stock-item", (_event, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.createLocalStockItem(input as never);
  });

  ipcMain.handle("stores:save-box", (_event, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.saveBox(input as never);
  });

  ipcMain.handle("stores:delete-box", (_event, boxId: unknown, expectedRevision: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.deleteBox(
      String(boxId ?? ""),
      expectedRevision == null ? undefined : Number(expectedRevision),
    );
  });

  ipcMain.handle("stores:bulk-vendor-receipt", (_event, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.bulkVendorReceipt(input as never);
  });

  ipcMain.handle("stores:review", (_event, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.review(input as never);
  });

  ipcMain.handle("stores:export-batch", (_event, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.exportBatch(input as never);
  });

  ipcMain.handle("stores:confirm-import", (_event, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.confirmImport(input as never);
  });

  ipcMain.handle("stores:backup-now", () => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.backup("manual");
  });

  ipcMain.handle("stores:set-opening-quantity", (_event, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.setOpeningQuantity(input as never);
  });

  ipcMain.handle("stores:choose-backup-file", async () => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    const options: OpenDialogOptions = {
      title: "Choose an Inventory Scanner SQLite backup",
      buttonLabel: "Choose backup",
      defaultPath: storesService.getState().database.backupFolder,
      properties: ["openFile"],
      filters: [{ name: "SQLite database", extensions: ["sqlite", "db"] }],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle("stores:restore-backup", (_event, backupPath: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.restoreBackup(absolutePath(backupPath, "Backup path"));
  });

  ipcMain.handle("stores:choose-folder", async (_event, kind: "backup" | "export") => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    const state = storesService.getState();
    const defaultPath = kind === "backup"
      ? state.database.backupFolder
      : path.join(app.getPath("userData"), "exports");
    const options: OpenDialogOptions = {
      title: kind === "backup" ? "Choose SQLite backup folder" : "Choose Tally export folder",
      buttonLabel: "Use this folder",
      defaultPath,
      properties: ["openDirectory", "createDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const folder = result.filePaths[0];
    return kind === "backup"
      ? storesService.setBackupFolder(folder)
      : storesService.setExportFolder(folder);
  });

  ipcMain.handle("stores:open-path", async (_event, targetPath: unknown) => {
    const resolvedPath = absolutePath(targetPath, "Path");
    return shell.openPath(existsSync(resolvedPath) ? resolvedPath : path.dirname(resolvedPath));
  });

  ipcMain.handle("planning:get-state", () => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.getState();
  });

  ipcMain.handle("planning:save-restock-policy", (_event, input: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.saveRestockPolicy(input as never);
  });

  ipcMain.handle("planning:recommendation-decision", (_event, input: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.decideRecommendation(input as never);
  });

  ipcMain.handle("planning:save-bom", (_event, input: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.saveBom(input as never);
  });

  ipcMain.handle("planning:activate-bom", (_event, bomId: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.activateBom(String(bomId ?? ""));
  });

  ipcMain.handle("planning:save-product-order", (_event, input: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.saveProductOrder(input as never);
  });

  ipcMain.handle("planning:update-product-order-status", (_event, orderId: unknown, status: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.updateProductOrderStatus(
      String(orderId ?? ""),
      String(status ?? "") as "CANCELLED" | "COMPLETED" | "CONFIRMED",
    );
  });

  ipcMain.handle("planning:export-restock", (_event, input: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.exportRestock(input as never);
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
    icon: applicationIconPath(),
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
    await mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  }
}

async function bootstrap(): Promise<void> {
  Menu.setApplicationMenu(null);
  applicationDatabase = new ApplicationDatabase(
    StoresDatabase.databasePathFor(app.getPath("userData")),
  );
  storesService = new StoresService(app.getPath("userData"), applicationDatabase);
  storesService.ensureDemoData();
  planningService = new PlanningService(applicationDatabase, storesService);
  tallyService = new TallyService(app.getPath("userData"));
  if (process.platform === "darwin") app.dock?.setIcon(applicationIconPath());
  process.env.TALLY_CACHE_PATH = tallyService.cachePath;
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
    const message =
      error instanceof Error ? error.stack ?? error.message : String(error);
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
  planningService = null;
  storesService?.close();
  storesService = null;
  applicationDatabase?.close();
  applicationDatabase = null;
});
