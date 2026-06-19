export type AppTab = "tracker" | "dashboard" | "qr" | "settings" | "tally";

export interface DesktopInfo {
  appVersion: string;
  apiBaseUrl: string;
  dataDirectory: string;
  excelPath: string;
  databasePath: string;
  port: number;
  scannerUrls: string[];
}

export interface Product {
  id: string;
  name: string;
  unit: string;
}

export type WorkbookCell = string | number | boolean | null;
export type WorkbookRow = Record<string, WorkbookCell>;

export interface WorkbookPreview {
  exists: boolean;
  path: string;
  fileName: string;
  modifiedAt: string | null;
  totalRows: number;
  rows: WorkbookRow[];
  error: string | null;
}

export interface DashboardState {
  status: "ok";
  scannerUrls: string[];
  workbook: WorkbookPreview;
}

export interface WorkbookLocationResponse {
  created: boolean;
  workbook: WorkbookPreview;
}

export type {
  TallyCompany,
  TallyConnectionResult,
  TallyConnectionSettings,
  TallyState,
  TallyStoresSnapshot,
} from "../tally/types";

export type {
  BulkVendorReceiptInput,
  BulkVendorReceiptLineInput,
  BulkVendorReceiptResult,
  ConfirmImportInput,
  CreateLocalStockItemInput,
  ExportBatchInput,
  ExportBatchResult,
  ReviewDecisionInput,
  SaveBoxInput,
  StoresBackupResult,
  StoresBox,
  StoresState,
  StoresStockItem,
  StoresSupplier,
  VendorReceiptInput,
  MaterialOutInput,
  AdjustmentInput,
  OpeningQuantityInput,
  StoresRestoreResult,
  AdjustmentContext,
} from "../stores/types";

export type {
  PlanningState,
  RestockPlanningItem,
  RestockPolicyInput,
  RecommendationDecisionInput,
  SaveBomInput,
  BomVersion,
  SaveProductOrderInput,
  ProductOrder,
  PlanningExportInput,
  PlanningExportResult,
} from "../planning/types";
