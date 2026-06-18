import type {
  BulkVendorReceiptInput,
  BulkVendorReceiptResult,
  ConfirmImportInput,
  DesktopInfo,
  ExportBatchInput,
  ExportBatchResult,
  ReviewDecisionInput,
  SaveBoxInput,
  StoresBackupResult,
  StoresBox,
  StoresState,
  TallyConnectionResult,
  TallyConnectionSettings,
  TallyState,
} from "./types";

export {};

declare global {
  interface Window {
    desktop: {
      getInfo: () => Promise<DesktopInfo>;
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
        saveBox: (input: SaveBoxInput) => Promise<StoresBox>;
        bulkVendorReceipt: (input: BulkVendorReceiptInput) => Promise<BulkVendorReceiptResult>;
        review: (input: ReviewDecisionInput) => Promise<StoresState>;
        exportBatch: (input: ExportBatchInput) => Promise<ExportBatchResult>;
        confirmImport: (input: ConfirmImportInput) => Promise<StoresState>;
        backupNow: () => Promise<StoresBackupResult>;
        chooseFolder: (kind: "backup" | "export") => Promise<StoresState | null>;
        openPath: (targetPath: string) => Promise<string>;
      };
    };
  }
}
