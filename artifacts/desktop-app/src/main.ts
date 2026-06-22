import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
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
import express, { type Express, type NextFunction, type Request, type Response } from "express";

import { ApplicationDatabase } from "./database/application-database";
import { TallyService } from "./tally/service";
import { createStoresRouter } from "./stores/router";
import { StoresDatabase } from "./stores/database";
import { StoresService } from "./stores/service";
import { createPlanningRouter } from "./planning/router";
import { PlanningService } from "./planning/service";
import { createOperationsRouter } from "./operations/router";
import { OperationsService } from "./operations/service";
import type { Permission } from "./operations/types";

interface DesktopInfo {
  appVersion: string;
  apiBaseUrl: string;
  computerName: string;
  deploymentRole: "PRODUCTION_SERVER" | "LAN_CLIENT";
  tallyComputerHost: string;
  dataDirectory: string;
  excelPath: string;
  databasePath: string;
  port: number;
  scannerUrls: string[];
}

const DEFAULT_PORT = 5000;
const AUTOMATIC_BACKUP_INTERVAL_MS = 2 * 60 * 60 * 1000;
const developmentRendererUrl = process.env.ELECTRON_RENDERER_URL;
const remoteServerUrl = (process.env.INVENTORY_SCANNER_REMOTE_URL ?? "").trim().replace(/\/+$/, "");

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
let operationsService: OperationsService | null = null;
let applicationDatabase: ApplicationDatabase | null = null;
let automaticBackupTimer: NodeJS.Timeout | null = null;

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
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Inventory-Session");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    if (_request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }
    next();
  });

  if (!storesService || !operationsService) throw new Error("The Local Stores Database is unavailable.");
  const requireHttpPermission = (permission: Permission) => (request: Request, _response: Response, next: NextFunction) => {
    try {
      const token = String(request.header("x-inventory-session") ?? request.header("authorization") ?? "")
        .replace(/^Bearer\s+/i, "")
        .trim();
      operationsService?.requireActor(token, permission);
      next();
    } catch (error) {
      next(error);
    }
  };
  desktopApi.use("/api/dashboard", requireHttpPermission("INVENTORY_VIEW"));
  desktopApi.use("/api/workbook", requireHttpPermission("SETTINGS_MANAGE"));
  desktopApi.use("/api/operations", createOperationsRouter(operationsService));
  desktopApi.use("/api/stores", createStoresRouter(storesService, operationsService));
  if (!planningService) throw new Error("The Planning service is unavailable.");
  desktopApi.use("/api/planning", createPlanningRouter(planningService, operationsService));
  desktopApi.get("/api/tally/state", requireHttpPermission("TALLY_REVIEW"), async (_request, response) => {
    if (!tallyService) throw new Error("The Tally service is unavailable.");
    response.json(await tallyService.getState());
  });
  desktopApi.post("/api/tally/test", requireHttpPermission("PURCHASING_MANAGE"), async (request, response) => {
    if (!tallyService) throw new Error("The Tally service is unavailable.");
    response.json(await tallyService.testConnection(request.body));
  });
  desktopApi.post("/api/tally/sync", requireHttpPermission("PURCHASING_MANAGE"), async (request, response) => {
    if (!tallyService || !storesService) throw new Error("The Tally or Stores service is unavailable.");
    const snapshot = await tallyService.syncStores(request.body);
    if (snapshot.stockItems.length > 0 && storesService.getState().dataMode === "demo") {
      planningService?.resetForCatalogReplacement();
    }
    const summary = storesService.sync(snapshot);
    operationsService?.database.reconcileLegacyLots();
    response.json({ snapshot, summary, state: storesService.getState() });
  });
  desktopApi.post("/api/stores/review", requireHttpPermission("TALLY_REVIEW"), (request, response) => {
    response.json(storesService!.review(request.body, operationsService!.requireActor(
      String(request.header("x-inventory-session") ?? "").trim(),
      "TALLY_REVIEW",
    )));
  });
  desktopApi.post("/api/stores/export-batch", requireHttpPermission("TALLY_REVIEW"), (request, response) => {
    response.json(storesService!.exportBatch(request.body, operationsService!.requireActor(
      String(request.header("x-inventory-session") ?? "").trim(),
      "TALLY_REVIEW",
    )));
  });
  desktopApi.post("/api/stores/confirm-import", requireHttpPermission("TALLY_REVIEW"), (request, response) => {
    response.json(storesService!.confirmImport(request.body, operationsService!.requireActor(
      String(request.header("x-inventory-session") ?? "").trim(),
      "TALLY_REVIEW",
    )));
  });
  desktopApi.post("/api/stores/backup", requireHttpPermission("SETTINGS_MANAGE"), (request, response) => {
    response.json(storesService!.backup("manual", operationsService!.requireActor(
      String(request.header("x-inventory-session") ?? "").trim(),
      "SETTINGS_MANAGE",
    )));
  });
  desktopApi.get("/api/stores/generated-files", requireHttpPermission("TALLY_REVIEW"), (_request, response) => {
    const folder = storesService!.getState().database.exportFolder;
    const files = existsSync(folder) ? readdirSync(folder)
      .filter((name) => /\.(xlsx|xls|csv|xml)$/i.test(name))
      .map((name) => {
        const filePath = path.join(folder, name);
        const stats = statSync(filePath);
        return { path: filePath, name, extension: path.extname(name).slice(1).toLocaleLowerCase(), sizeBytes: stats.size, modifiedAt: stats.mtime.toISOString() };
      })
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt)) : [];
    response.json(files);
  });

  // Keep the original endpoint compatible with older clients, but make the
  // SQLite Stores Catalog authoritative after Tally synchronization.
  desktopApi.get("/api/products", (request, response, next) => {
    const token = String(request.header("x-inventory-session") ?? request.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    operationsService?.requireActor(token, "INVENTORY_VIEW");
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
  desktopApi.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    response.status(/sign in|permission/i.test(message) ? 401 : 400).json({ error: message });
  });

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
    computerName: os.hostname(),
    deploymentRole: "PRODUCTION_SERVER",
    tallyComputerHost: process.env.INVENTORY_TALLY_HOST?.trim() || "accounts",
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
  const requireActor = (token: unknown, permission?: Permission) => {
    if (!operationsService) throw new Error("The inventory operations service is unavailable.");
    return operationsService.requireActor(String(token ?? ""), permission);
  };

  ipcMain.handle("desktop:get-info", () => {
    if (!desktopInfo) throw new Error("The local server has not started yet.");
    return desktopInfo;
  });

  ipcMain.handle("auth:state", (_event, token: unknown) => {
    if (!operationsService) throw new Error("The inventory operations service is unavailable.");
    return operationsService.authState(String(token ?? ""));
  });
  ipcMain.handle("auth:bootstrap", (_event, input: unknown) => {
    if (!operationsService) throw new Error("The inventory operations service is unavailable.");
    return operationsService.bootstrapAdmin(input as never);
  });
  ipcMain.handle("auth:login", (_event, input: unknown) => {
    if (!operationsService) throw new Error("The inventory operations service is unavailable.");
    return operationsService.login(input as never);
  });
  ipcMain.handle("auth:update-email", (_event, token: unknown, input: unknown) => {
    if (!operationsService) throw new Error("The inventory operations service is unavailable.");
    return operationsService.updateOwnEmail(input as never, requireActor(token));
  });
  ipcMain.handle("auth:forgot-password", (_event, input: unknown) => {
    if (!operationsService) throw new Error("The inventory operations service is unavailable.");
    return operationsService.forgotCredential(input as never);
  });
  ipcMain.handle("auth:resume", (_event, token: unknown) => {
    if (!operationsService) throw new Error("The inventory operations service is unavailable.");
    return operationsService.resume(String(token ?? ""));
  });
  ipcMain.handle("auth:logout", (_event, token: unknown) => {
    if (!operationsService) throw new Error("The inventory operations service is unavailable.");
    operationsService.logout(String(token ?? ""));
  });

  ipcMain.handle("desktop:print-html", async (_event, token: unknown, html: unknown) => {
    requireActor(token, "QR_MANAGE");
    return printHtmlDocument(printableHtml(html));
  });
  ipcMain.handle("desktop:choose-workbook-folder", async (_event, token: unknown, currentWorkbookPath?: string) => {
    requireActor(token, "SETTINGS_MANAGE");
    const fallbackPath = desktopInfo?.dataDirectory ?? app.getPath("documents");
    const requestedPath = typeof currentWorkbookPath === "string" && path.isAbsolute(currentWorkbookPath)
      ? path.dirname(currentWorkbookPath)
      : fallbackPath;
    const options: OpenDialogOptions = {
      title: "Choose the Inventory Scanner data folder",
      buttonLabel: "Use this folder",
      defaultPath: requestedPath,
      properties: ["openDirectory", "createDirectory"],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("desktop:open-workbook-folder", async (_event, token: unknown, workbookPath: unknown) => {
    requireActor(token, "INVENTORY_VIEW");
    const resolvedPath = absolutePath(workbookPath, "Workbook path");
    return shell.openPath(path.dirname(resolvedPath));
  });
  ipcMain.handle("desktop:open-excel-file", async (_event, token: unknown, workbookPath: unknown) => {
    requireActor(token, "INVENTORY_VIEW");
    return shell.openPath(absolutePath(workbookPath, "Workbook path"));
  });
  ipcMain.handle("desktop:show-excel-file", async (_event, token: unknown, workbookPath: unknown) => {
    requireActor(token, "INVENTORY_VIEW");
    const resolvedPath = absolutePath(workbookPath, "Workbook path");
    if (existsSync(resolvedPath)) {
      shell.showItemInFolder(resolvedPath);
      return true;
    }
    await shell.openPath(path.dirname(resolvedPath));
    return false;
  });

  ipcMain.handle("tally:get-state", async (_event, token: unknown) => {
    requireActor(token, "TALLY_REVIEW");
    if (!tallyService) throw new Error("The Tally service is unavailable.");
    return tallyService.getState();
  });
  ipcMain.handle("tally:test-connection", async (_event, token: unknown, settings: unknown) => {
    requireActor(token, "PURCHASING_MANAGE");
    if (!tallyService) throw new Error("The Tally service is unavailable.");
    return tallyService.testConnection(settings);
  });
  ipcMain.handle("tally:sync-stores", async (_event, token: unknown, settings: unknown) => {
    const actor = requireActor(token, "PURCHASING_MANAGE");
    if (!tallyService || !storesService) throw new Error("The Tally or Stores service is unavailable.");
    const snapshot = await tallyService.syncStores(settings);
    if (snapshot.stockItems.length > 0 && storesService.getState().dataMode === "demo") {
      planningService?.resetForCatalogReplacement(actor);
    }
    const summary = storesService.sync(snapshot, actor);
    operationsService?.database.reconcileLegacyLots();
    return { snapshot, summary, state: storesService.getState() };
  });

  ipcMain.handle("stores:get-state", (_event, token: unknown) => {
    requireActor(token, "INVENTORY_VIEW");
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.getState();
  });
  ipcMain.handle("stores:create-local-stock-item", (_event, token: unknown, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.createLocalStockItem(input as never, requireActor(token, "CATALOG_MANAGE"));
  });
  ipcMain.handle("stores:set-catalog-status", (_event, token: unknown, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.setCatalogStatus(input as never, requireActor(token, "CATALOG_MANAGE"));
  });
  ipcMain.handle("stores:set-catalog-classification", (_event, token: unknown, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.setCatalogClassification(input as never, requireActor(token, "CATALOG_MANAGE"));
  });
  ipcMain.handle("stores:rename-stock-item", (_event, token: unknown, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.renameStockItem(input as never, requireActor(token, "CATALOG_MANAGE"));
  });
  ipcMain.handle("stores:export-catalog-cleanup", (_event, token: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.exportCatalogCleanup(requireActor(token, "CATALOG_MANAGE"));
  });
  ipcMain.handle("stores:save-box", (_event, token: unknown, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.saveBox(input as never, requireActor(token, "QR_MANAGE"));
  });
  ipcMain.handle("stores:delete-box", (_event, token: unknown, boxId: unknown, expectedRevision: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.deleteBox(String(boxId ?? ""), expectedRevision == null ? undefined : Number(expectedRevision), requireActor(token, "QR_MANAGE"));
  });
  ipcMain.handle("stores:bulk-vendor-receipt", (_event, token: unknown, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.bulkVendorReceipt(input as never, requireActor(token, "RECEIVE_MATERIAL"));
  });
  ipcMain.handle("stores:review", (_event, token: unknown, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.review(input as never, requireActor(token, "TALLY_REVIEW"));
  });
  ipcMain.handle("stores:export-batch", (_event, token: unknown, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.exportBatch(input as never, requireActor(token, "TALLY_REVIEW"));
  });
  ipcMain.handle("stores:confirm-import", (_event, token: unknown, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.confirmImport(input as never, requireActor(token, "TALLY_REVIEW"));
  });
  ipcMain.handle("stores:backup-now", (_event, token: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.backup("manual", requireActor(token, "SETTINGS_MANAGE"));
  });
  ipcMain.handle("stores:set-opening-quantity", (_event, token: unknown, input: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.setOpeningQuantity(input as never, requireActor(token, "STOCK_ADJUST"));
  });
  ipcMain.handle("stores:choose-backup-file", async (_event, token: unknown) => {
    requireActor(token, "SETTINGS_MANAGE");
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    const options: OpenDialogOptions = {
      title: "Choose an Inventory Scanner SQLite backup",
      buttonLabel: "Choose backup",
      defaultPath: storesService.getState().database.backupFolder,
      properties: ["openFile"],
      filters: [{ name: "SQLite database", extensions: ["sqlite", "db"] }],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("stores:restore-backup", (_event, token: unknown, backupPath: unknown) => {
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    return storesService.restoreBackup(absolutePath(backupPath, "Backup path"), requireActor(token, "SETTINGS_MANAGE"));
  });
  ipcMain.handle("stores:choose-folder", async (_event, token: unknown, kind: "backup" | "export") => {
    const actor = requireActor(token, "SETTINGS_MANAGE");
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    const state = storesService.getState();
    const defaultPath = kind === "backup" ? state.database.backupFolder : path.join(app.getPath("userData"), "exports");
    const options: OpenDialogOptions = {
      title: kind === "backup" ? "Choose SQLite backup folder" : "Choose Tally export folder",
      buttonLabel: "Use this folder",
      defaultPath,
      properties: ["openDirectory", "createDirectory"],
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return kind === "backup" ? storesService.setBackupFolder(result.filePaths[0], actor) : storesService.setExportFolder(result.filePaths[0], actor);
  });
  ipcMain.handle("stores:open-path", async (_event, token: unknown, targetPath: unknown) => {
    requireActor(token, "INVENTORY_VIEW");
    const resolvedPath = absolutePath(targetPath, "Path");
    return shell.openPath(existsSync(resolvedPath) ? resolvedPath : path.dirname(resolvedPath));
  });
  ipcMain.handle("stores:list-generated-files", (_event, token: unknown) => {
    requireActor(token, "TALLY_REVIEW");
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    const folder = storesService.getState().database.exportFolder;
    if (!existsSync(folder)) return [];
    return readdirSync(folder)
      .filter((name) => /\.(xlsx|xls|csv|xml)$/i.test(name))
      .map((name) => {
        const filePath = path.join(folder, name);
        const stats = statSync(filePath);
        return {
          path: filePath,
          name,
          extension: path.extname(name).slice(1).toLocaleLowerCase(),
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        };
      })
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  });
  ipcMain.handle("stores:download-generated-file", async (_event, token: unknown, sourcePath: unknown) => {
    requireActor(token, "TALLY_REVIEW");
    if (!storesService) throw new Error("The Local Stores Database is unavailable.");
    const source = absolutePath(sourcePath, "Generated file");
    const exportFolder = path.resolve(storesService.getState().database.exportFolder);
    if (!path.resolve(source).startsWith(`${exportFolder}${path.sep}`) || !existsSync(source)) {
      throw new Error("The selected generated file is unavailable.");
    }
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, {
      title: "Download Tally import file",
      defaultPath: path.join(app.getPath("downloads"), path.basename(source)),
      buttonLabel: "Download",
    }) : await dialog.showSaveDialog({
      title: "Download Tally import file",
      defaultPath: path.join(app.getPath("downloads"), path.basename(source)),
      buttonLabel: "Download",
    });
    if (result.canceled || !result.filePath) return null;
    copyFileSync(source, result.filePath);
    return result.filePath;
  });

  ipcMain.handle("planning:get-state", (_event, token: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.getState(requireActor(token, "RESTOCK_VIEW"));
  });
  ipcMain.handle("planning:save-restock-policy", (_event, token: unknown, input: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.saveRestockPolicy(input as never, requireActor(token, "RESTOCK_MANAGE"));
  });
  ipcMain.handle("planning:recommendation-decision", (_event, token: unknown, input: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.decideRecommendation(input as never, requireActor(token, "RESTOCK_MANAGE"));
  });
  ipcMain.handle("planning:save-bom", (_event, token: unknown, input: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.saveBom(input as never, requireActor(token, "BOM_MANAGE"));
  });
  ipcMain.handle("planning:activate-bom", (_event, token: unknown, bomId: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.activateBom(String(bomId ?? ""), requireActor(token, "BOM_MANAGE"));
  });
  ipcMain.handle("planning:save-product-order", (_event, token: unknown, input: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.saveProductOrder(input as never, requireActor(token, "PRODUCT_ORDER_MANAGE"));
  });
  ipcMain.handle("planning:update-product-order-status", (_event, token: unknown, orderId: unknown, status: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.updateProductOrderStatus(String(orderId ?? ""), String(status ?? "") as "CANCELLED" | "COMPLETED" | "CONFIRMED", requireActor(token, "PRODUCT_ORDER_MANAGE"));
  });
  ipcMain.handle("planning:update-product-order-workflow-state", (_event, token: unknown, orderId: unknown, workflowStateId: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.updateProductOrderWorkflowState(String(orderId ?? ""), String(workflowStateId ?? ""), requireActor(token, "PRODUCT_ORDER_MANAGE"));
  });
  ipcMain.handle("planning:save-product-order-workflow-state", (_event, token: unknown, input: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.saveProductOrderWorkflowState(input as never, requireActor(token, "PRODUCT_ORDER_MANAGE"));
  });
  ipcMain.handle("planning:delete-product-order-workflow-state", (_event, token: unknown, stateId: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.deleteProductOrderWorkflowState(String(stateId ?? ""), requireActor(token, "PRODUCT_ORDER_MANAGE"));
  });
  ipcMain.handle("planning:save-product-order-field-definition", (_event, token: unknown, input: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.saveProductOrderFieldDefinition(input as never, requireActor(token, "PRODUCT_ORDER_MANAGE"));
  });
  ipcMain.handle("planning:delete-product-order-field-definition", (_event, token: unknown, fieldId: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.deleteProductOrderFieldDefinition(String(fieldId ?? ""), requireActor(token, "PRODUCT_ORDER_MANAGE"));
  });
  ipcMain.handle("planning:export-restock", (_event, token: unknown, input: unknown) => {
    if (!planningService) throw new Error("The Planning service is unavailable.");
    return planningService.exportRestock(input as never, requireActor(token, "RESTOCK_MANAGE"));
  });

  ipcMain.handle("operations:get-state", (_event, token: unknown) => {
    if (!operationsService) throw new Error("The inventory operations service is unavailable.");
    return operationsService.getState(requireActor(token, "INVENTORY_VIEW"));
  });
  const operation = (channel: string, permission: Permission | undefined, action: (input: never, actor: ReturnType<typeof requireActor>) => unknown) => {
    ipcMain.handle(channel, (_event, token: unknown, input: unknown) => action(input as never, requireActor(token, permission)));
  };
  operation("operations:save-user", "AUTH_MANAGE_USERS", (input, actor) => operationsService!.saveUser(input, actor));
  operation("operations:reset-credential", "AUTH_MANAGE_USERS", (input, actor) => operationsService!.resetCredential(input, actor));
  operation("operations:transition-condition", undefined, (input, actor) => operationsService!.transitionCondition(input, actor));
  operation("operations:create-fault", "MARK_FAULTY", (input, actor) => operationsService!.createFault(input, actor));
  operation("operations:resolve-fault", undefined, (input, actor) => operationsService!.resolveFault(input, actor));
  operation("operations:create-count", "STOCK_COUNT", (input, actor) => operationsService!.createCountSession(input, actor));
  operation("operations:record-count", "STOCK_COUNT", (input, actor) => operationsService!.recordCountEntry(input, actor));
  operation("operations:finalize-count", "STOCK_ADJUST", (input, actor) => operationsService!.finalizeCount(input, actor));
  operation("operations:production-return", "PRODUCTION_RETURN", (input, actor) => operationsService!.productionReturn(input, actor));
  operation("operations:supplier-return", "SUPPLIER_RETURN", (input, actor) => operationsService!.supplierReturn(input, actor));
  operation("operations:update-supplier-return", "PURCHASING_MANAGE", (input, actor) => operationsService!.updateSupplierReturn(input, actor));
  operation("operations:initiate-customer-return", "CUSTOMER_RETURN_INITIATE", (input, actor) => operationsService!.initiateCustomerReturn(input, actor));
  operation("operations:receive-customer-return", "CUSTOMER_RETURN_RECEIVE", (input, actor) => operationsService!.receiveCustomerReturn(input, actor));
  operation("operations:scrap", "SCRAP_STOCK", (input, actor) => operationsService!.scrap(input, actor));
  operation("operations:release-product-order", "PRODUCTION_EXECUTE", (input, actor) => operationsService!.releaseProductOrder(input, actor));
  operation("operations:issue-production-material", "PRODUCTION_EXECUTE", (input, actor) => operationsService!.issueProductionMaterial(input, actor));
  operation("operations:production-completion", "PRODUCTION_EXECUTE", (input, actor) => operationsService!.productionCompletion(input, actor));
  operation("operations:set-product-order-status", "PRODUCTION_EXECUTE", (input, actor) => operationsService!.setProductOrderExecutionStatus(input, actor));
  operation("operations:resolve-sync-exception", "SYNC_EXCEPTION_RESOLVE", (input, actor) => operationsService!.resolveSyncException(input, actor));
  operation("operations:reverse-movement", "TRANSACTION_REVERSE", (input, actor) => operationsService!.reverseMovement(input, actor));
  operation("operations:review-manual-tally", "TALLY_REVIEW", (input, actor) => operationsService!.reviewManualTally(input, actor));
}

function registerRemoteClientIpcHandlers(): void {
  ipcMain.handle("desktop:get-info", () => {
    if (!desktopInfo) throw new Error("The Production server address is unavailable.");
    return desktopInfo;
  });
  ipcMain.handle("desktop:print-html", async (_event, _token: unknown, html: unknown) =>
    printHtmlDocument(printableHtml(html)));
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

function runAutomaticBackup(): void {
  if (!storesService) return;
  try {
    storesService.database.backupIfDue(AUTOMATIC_BACKUP_INTERVAL_MS);
  } catch (error) {
    console.error(
      "Automatic Inventory Scanner backup failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function startAutomaticBackups(): void {
  runAutomaticBackup();
  automaticBackupTimer = setInterval(
    runAutomaticBackup,
    AUTOMATIC_BACKUP_INTERVAL_MS,
  );
  automaticBackupTimer.unref();
}

async function bootstrap(): Promise<void> {
  Menu.setApplicationMenu(null);
  if (remoteServerUrl) {
    const parsed = new URL(remoteServerUrl);
    desktopInfo = {
      appVersion: app.getVersion(),
      apiBaseUrl: remoteServerUrl,
      computerName: os.hostname(),
      deploymentRole: "LAN_CLIENT",
      tallyComputerHost: "accounts",
      dataDirectory: "",
      excelPath: "",
      databasePath: "",
      port: Number(parsed.port || 80),
      scannerUrls: [remoteServerUrl],
    };
    registerRemoteClientIpcHandlers();
    await createWindow();
    return;
  }
  applicationDatabase = new ApplicationDatabase(
    StoresDatabase.databasePathFor(app.getPath("userData")),
  );
  storesService = new StoresService(app.getPath("userData"), applicationDatabase);
  operationsService = new OperationsService(applicationDatabase, storesService);
  storesService.bindOperations(operationsService);
  storesService.ensureDemoData();
  operationsService.database.reconcileLegacyLots();
  planningService = new PlanningService(applicationDatabase, storesService);
  operationsService.bindPlanning(planningService);
  tallyService = new TallyService(app.getPath("userData"));
  if (process.platform === "darwin") app.dock?.setIcon(applicationIconPath());
  process.env.TALLY_CACHE_PATH = tallyService.cachePath;
  desktopInfo = await startApi();
  registerIpcHandlers();
  startAutomaticBackups();
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
  if (automaticBackupTimer) clearInterval(automaticBackupTimer);
  automaticBackupTimer = null;
  apiServer?.close();
  apiServer = null;
  planningService = null;
  operationsService = null;
  storesService?.close();
  storesService = null;
  applicationDatabase?.close();
  applicationDatabase = null;
});
