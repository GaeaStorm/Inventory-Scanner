import type {
  BulkVendorReceiptInput,
  BulkVendorReceiptResult,
  ConfirmImportInput,
  CreateLocalStockItemInput,
  DesktopInfo,
  ExportBatchInput,
  ExportBatchResult,
  OpeningQuantityInput,
  RenameStockItemInput,
  CatalogCleanupExportResult,
  ReviewDecisionInput,
  SaveBoxInput,
  SetCatalogStatusInput,
  StoresBackupResult,
  StoresRestoreResult,
  StoresBox,
  StoresState,
  TallyConnectionResult,
  TallyConnectionSettings,
  TallyState,
  PlanningState,
  RestockPolicyInput,
  RecommendationDecisionInput,
  SaveBomInput,
  SaveProductOrderInput,
  PlanningExportInput,
  PlanningExportResult,
} from "./types";

export {};

declare global {
  interface Window {
    desktop: {
      getInfo: () => Promise<DesktopInfo>;
      printHtml: (html: string) => Promise<{ success: boolean; failureReason?: string }>;
      chooseWorkbookFolder: (currentWorkbookPath?: string) => Promise<string | null>;
      openWorkbookFolder: (workbookPath: string) => Promise<string>;
      openExcelFile: (workbookPath: string) => Promise<string>;
      showExcelFile: (workbookPath: string) => Promise<boolean>;
      tally: {
        getState: () => Promise<TallyState>;
        testConnection: (settings: TallyConnectionSettings) => Promise<TallyConnectionResult>;
        syncStores: (settings: TallyConnectionSettings) => Promise<{
          snapshot: import("../tally/types").TallyStoresSnapshot;
          summary: import("../stores/types").StoresSyncSummary;
          state: StoresState;
        }>;
      };
      stores: {
        getState: () => Promise<StoresState>;
        createLocalStockItem: (input: CreateLocalStockItemInput) => Promise<StoresState>;
        setCatalogStatus: (input: SetCatalogStatusInput) => Promise<StoresState>;
        renameStockItem: (input: RenameStockItemInput) => Promise<StoresState>;
        exportCatalogCleanup: () => Promise<CatalogCleanupExportResult>;
        saveBox: (input: SaveBoxInput) => Promise<StoresBox>;
        deleteBox: (boxId: string, expectedRevision?: number) => Promise<StoresState>;
        bulkVendorReceipt: (input: BulkVendorReceiptInput) => Promise<BulkVendorReceiptResult>;
        review: (input: ReviewDecisionInput) => Promise<StoresState>;
        exportBatch: (input: ExportBatchInput) => Promise<ExportBatchResult>;
        confirmImport: (input: ConfirmImportInput) => Promise<StoresState>;
        backupNow: () => Promise<StoresBackupResult>;
        setOpeningQuantity: (input: OpeningQuantityInput) => Promise<StoresState>;
        chooseBackupFile: () => Promise<string | null>;
        restoreBackup: (backupPath: string) => Promise<StoresRestoreResult>;
        chooseFolder: (kind: "backup" | "export") => Promise<StoresState | null>;
        openPath: (targetPath: string) => Promise<string>;
      };
      planning: {
        getState: () => Promise<PlanningState>;
        saveRestockPolicy: (input: RestockPolicyInput) => Promise<PlanningState>;
        recommendationDecision: (input: RecommendationDecisionInput) => Promise<PlanningState>;
        saveBom: (input: SaveBomInput) => Promise<PlanningState>;
        activateBom: (bomId: string) => Promise<PlanningState>;
        saveProductOrder: (input: SaveProductOrderInput) => Promise<PlanningState>;
        updateProductOrderStatus: (
          orderId: string,
          status: "CANCELLED" | "COMPLETED" | "CONFIRMED",
        ) => Promise<PlanningState>;
        exportRestock: (input: PlanningExportInput) => Promise<PlanningExportResult>;
      };
    };
  }
}
