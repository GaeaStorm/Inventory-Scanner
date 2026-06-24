import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";

import { logger } from "./logger";

export type MovementType = "Restock" | "Use" | "Adjustment";
export type AdjustmentDirection = "in" | "out";

export interface StoredTransaction {
  id: string;
  refNo: string;
  movementType: MovementType;
  itemCode: string;
  itemName: string;
  quantity: number;
  unitRate: string;
  godown: string;
  batchNo: string;
  usedIn: string;
  adjustmentDirection?: AdjustmentDirection;
  timestamp: string;
}

export interface WorkbookPreview {
  exists: boolean;
  path: string;
  fileName: string;
  modifiedAt: string | null;
  totalRows: number;
  rows: Array<Record<string, unknown>>;
  error: string | null;
}

export interface WorkbookLocationResult {
  path: string;
  created: boolean;
}

const SHEET_NAME = "Transactions";
const DEFAULT_FILE_NAME = "stock_transactions.xlsx";
const SETTINGS_FILE_NAME = "settings.json";
const HEADERS = [
  "Date",
  "Timestamp in IST",
  "Ref No",
  "Movement Type",
  "Item Code",
  "Item Name",
  "In Qty",
  "Out Qty",
  "Unit Rate",
  "Godown",
  "Batch No",
  "Used In",
];

const COLUMN_WIDTHS = [
  { wch: 12 },
  { wch: 22 },
  { wch: 18 },
  { wch: 16 },
  { wch: 18 },
  { wch: 32 },
  { wch: 10 },
  { wch: 10 },
  { wch: 14 },
  { wch: 20 },
  { wch: 22 },
  { wch: 30 },
];

interface AppSettings {
  workbookPath?: string;
}

function getDefaultDataDirectory(): string {
  const override = process.env["INVENTORY_DATA_DIR"]?.trim();

  if (override) {
    return path.resolve(expandHomeDirectory(override));
  }

  if (process.platform === "win32" && process.env["APPDATA"]) {
    return path.join(process.env["APPDATA"], "Inventory Scanner");
  }

  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Inventory Scanner",
    );
  }

  return path.join(
    process.env["XDG_DATA_HOME"] ??
      path.join(os.homedir(), ".local", "share"),
    "inventory-scanner",
  );
}

function expandHomeDirectory(value: string): string {
  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function getDefaultWorkbookPath(): string {
  return path.join(getDefaultDataDirectory(), DEFAULT_FILE_NAME);
}

function getSettingsPath(): string {
  return path.join(getDefaultDataDirectory(), SETTINGS_FILE_NAME);
}

function readSavedWorkbookPath(): string | null {
  const settingsPath = getSettingsPath();

  if (!fs.existsSync(settingsPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      fs.readFileSync(settingsPath, "utf8"),
    ) as AppSettings;

    return typeof parsed.workbookPath === "string" &&
      parsed.workbookPath.trim().length > 0
      ? path.resolve(expandHomeDirectory(parsed.workbookPath.trim()))
      : null;
  } catch (error) {
    logger.warn(
      { err: error, path: settingsPath },
      "Workbook settings could not be read; using the default location",
    );
    return null;
  }
}

function saveWorkbookPath(workbookPath: string | null): void {
  const settingsPath = getSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  const settings: AppSettings = workbookPath
    ? { workbookPath }
    : {};

  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
}

function getFallbackWorkbookPath(): string {
  const environmentPath = process.env["EXCEL_PATH"]?.trim();

  if (environmentPath) {
    return path.resolve(expandHomeDirectory(environmentPath));
  }

  return getDefaultWorkbookPath();
}

function getInitialWorkbookPath(): string {
  return readSavedWorkbookPath() ?? getFallbackWorkbookPath();
}

let activeWorkbookPath = getInitialWorkbookPath();

export function getWorkbookPath(): string {
  return activeWorkbookPath;
}

function resolveRequestedWorkbookPath(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return getFallbackWorkbookPath();
  }

  const expanded = expandHomeDirectory(trimmed);
  let resolved = path.resolve(expanded);
  const endsWithSeparator = /[\\/]$/.test(trimmed);

  if (fs.existsSync(resolved)) {
    const stats = fs.statSync(resolved);

    if (stats.isDirectory()) {
      resolved = path.join(resolved, DEFAULT_FILE_NAME);
    } else if (!stats.isFile()) {
      throw new Error("The selected workbook location is not a regular file");
    }
  } else if (endsWithSeparator) {
    resolved = path.join(resolved, DEFAULT_FILE_NAME);
  }

  if (path.extname(resolved).toLowerCase() !== ".xlsx") {
    throw new Error(
      'Enter a path ending in ".xlsx", or enter an existing directory',
    );
  }

  return resolved;
}

function createEmptyWorkbook(workbookPath: string): void {
  fs.mkdirSync(path.dirname(workbookPath), { recursive: true });

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([HEADERS]);
  worksheet["!cols"] = COLUMN_WIDTHS;
  XLSX.utils.book_append_sheet(workbook, worksheet, SHEET_NAME);
  XLSX.writeFile(workbook, workbookPath);
}

function validateExistingWorkbook(workbookPath: string): void {
  const workbook = XLSX.readFile(workbookPath);

  if (workbook.SheetNames.length === 0) {
    throw new Error("The selected Excel file does not contain any worksheets");
  }
}

export function ensureWorkbookExists(): WorkbookLocationResult {
  const workbookPath = getWorkbookPath();

  if (fs.existsSync(workbookPath)) {
    validateExistingWorkbook(workbookPath);
    return { path: workbookPath, created: false };
  }

  createEmptyWorkbook(workbookPath);
  logger.info({ path: workbookPath }, "Created Excel workbook");
  return { path: workbookPath, created: true };
}

export function setWorkbookPath(value: string): WorkbookLocationResult {
  const useDefaultLocation = value.trim().length === 0;
  const nextPath = resolveRequestedWorkbookPath(value);
  const previousPath = activeWorkbookPath;

  activeWorkbookPath = nextPath;

  try {
    const result = ensureWorkbookExists();
    saveWorkbookPath(useDefaultLocation ? null : nextPath);

    logger.info(
      {
        path: nextPath,
        previousPath,
        created: result.created,
      },
      "Excel workbook location changed",
    );

    return result;
  } catch (error) {
    activeWorkbookPath = previousPath;
    throw error;
  }
}

function getIstDateTime(timestamp: string): {
  date: string;
  timestampIst: string;
} {
  const date = new Date(timestamp);
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const getPart = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  const day = getPart("day");
  const month = getPart("month");
  const year = getPart("year");
  const hour = getPart("hour");
  const minute = getPart("minute");
  const second = getPart("second");

  return {
    date: `${day}/${month}/${year}`,
    timestampIst: `${day}/${month}/${year} ${hour}:${minute}:${second}`,
  };
}

function getInOutQuantity(transaction: StoredTransaction): {
  inQuantity: number | "";
  outQuantity: number | "";
} {
  if (transaction.movementType === "Restock") {
    return { inQuantity: transaction.quantity, outQuantity: "" };
  }

  if (transaction.movementType === "Use") {
    return { inQuantity: "", outQuantity: transaction.quantity };
  }

  if (transaction.adjustmentDirection === "out") {
    return { inQuantity: "", outQuantity: transaction.quantity };
  }

  return { inQuantity: transaction.quantity, outQuantity: "" };
}

export function appendTransactionToWorkbook(
  transaction: StoredTransaction,
): void {
  const { path: workbookPath } = ensureWorkbookExists();
  const workbook = XLSX.readFile(workbookPath);
  const worksheet = workbook.Sheets[SHEET_NAME];
  const existingRows = worksheet
    ? XLSX.utils.sheet_to_json<Record<string, string | number>>(worksheet, {
        defval: "",
      })
    : [];

  const { date, timestampIst } = getIstDateTime(transaction.timestamp);
  const { inQuantity, outQuantity } = getInOutQuantity(transaction);

  existingRows.push({
    Date: date,
    "Timestamp in IST": timestampIst,
    "Ref No": transaction.refNo,
    "Movement Type": transaction.movementType,
    "Item Code": transaction.itemCode,
    "Item Name": transaction.itemName,
    "In Qty": inQuantity,
    "Out Qty": outQuantity,
    "Unit Rate": transaction.unitRate,
    Godown: transaction.godown,
    "Batch No": transaction.batchNo,
    "Used In": transaction.usedIn,
  });

  const updatedWorksheet = XLSX.utils.json_to_sheet(existingRows, {
    header: HEADERS,
  });

  updatedWorksheet["!cols"] = COLUMN_WIDTHS;
  workbook.Sheets[SHEET_NAME] = updatedWorksheet;

  if (!workbook.SheetNames.includes(SHEET_NAME)) {
    workbook.SheetNames.push(SHEET_NAME);
  }

  XLSX.writeFile(workbook, workbookPath);

  logger.info(
    { id: transaction.id, path: workbookPath },
    "Transaction written to Excel",
  );
}

export function readWorkbookPreview(limit = 12): WorkbookPreview {
  const { path: workbookPath } = ensureWorkbookExists();
  const workbook = XLSX.readFile(workbookPath);
  const worksheet = workbook.Sheets[SHEET_NAME];
  const allRows = worksheet
    ? XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
        defval: "",
        raw: false,
      })
    : [];
  const stats = fs.statSync(workbookPath);
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);

  return {
    exists: true,
    path: workbookPath,
    fileName: path.basename(workbookPath),
    modifiedAt: stats.mtime.toISOString(),
    totalRows: allRows.length,
    rows: allRows.slice(-safeLimit).reverse(),
    error: null,
  };
}
