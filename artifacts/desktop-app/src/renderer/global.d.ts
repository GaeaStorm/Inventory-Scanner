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
  SetCatalogClassificationInput,
  GeneratedExportFile,
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
  AuthSession,
  AuthState,
  BootstrapAdminInput,
  LoginInput,
  OperationsState,
  SaveUserInput,
  ResetCredentialInput,
  ConditionTransitionInput,
  CreateFaultInput,
  ResolveFaultInput,
  CreateCountSessionInput,
  RecordCountEntryInput,
  FinalizeCountInput,
  ProductionReturnInput,
  SupplierReturnInput,
  CustomerReturnInput,
  ReceiveCustomerReturnInput,
  ScrapInput,
  ProductionIssueInput,
  ProductionCompletionInput,
  ResolveSyncExceptionInput,
  ReverseMovementInput,
} from "./types";

export {};

declare global {
  interface Window {
    desktop: {
      getInfo: () => Promise<DesktopInfo>;
      auth: {
        state: (token?: string) => Promise<AuthState>;
        bootstrap: (input: BootstrapAdminInput) => Promise<AuthSession>;
        login: (input: LoginInput) => Promise<AuthSession>;
        resume: (token: string) => Promise<AuthSession>;
        logout: () => Promise<void>;
        token: () => string;
      };
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
        setCatalogClassification: (input: SetCatalogClassificationInput) => Promise<StoresState>;
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
        listGeneratedFiles: () => Promise<GeneratedExportFile[]>;
        downloadGeneratedFile: (sourcePath: string) => Promise<string | null>;
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
      operations: {
        getState: () => Promise<OperationsState>;
        saveUser: (input: SaveUserInput) => Promise<import("../operations/types").AuthUser>;
        resetCredential: (input: ResetCredentialInput) => Promise<void>;
        transitionCondition: (input: ConditionTransitionInput) => Promise<import("../operations/types").OperationsMovement>;
        createFault: (input: CreateFaultInput) => Promise<import("../operations/types").SupplierFaultRecord>;
        resolveFault: (input: ResolveFaultInput) => Promise<import("../operations/types").SupplierFaultRecord>;
        createCount: (input: CreateCountSessionInput) => Promise<import("../operations/types").StockCountDetail>;
        recordCount: (input: RecordCountEntryInput) => Promise<import("../operations/types").StockCountDetail>;
        finalizeCount: (input: FinalizeCountInput) => Promise<import("../operations/types").StockCountDetail>;
        productionReturn: (input: ProductionReturnInput) => Promise<import("../operations/types").OperationsMovement>;
        supplierReturn: (input: SupplierReturnInput) => Promise<import("../operations/types").OperationsMovement>;
        updateSupplierReturn: (input: import("../operations/types").UpdateSupplierReturnInput) => Promise<Record<string, unknown>>;
        initiateCustomerReturn: (input: CustomerReturnInput) => Promise<Record<string, unknown>>;
        receiveCustomerReturn: (input: ReceiveCustomerReturnInput) => Promise<Record<string, unknown>>;
        scrap: (input: ScrapInput) => Promise<import("../operations/types").OperationsMovement>;
        releaseProductOrder: (input: { clientTransactionId: string; productOrderId: string; notes?: string }) => Promise<import("../operations/types").ProductionExecution>;
        issueProductionMaterial: (input: ProductionIssueInput) => Promise<import("../stores/types").StoresMovement>;
        productionCompletion: (input: ProductionCompletionInput) => Promise<import("../operations/types").ProductionExecution>;
        setProductOrderStatus: (input: { clientTransactionId: string; productOrderId: string; status: "CANCELLED" | "CLOSED"; notes?: string }) => Promise<import("../operations/types").ProductionExecution>;
        resolveSyncException: (input: ResolveSyncExceptionInput) => Promise<import("../operations/types").SyncExceptionRecord>;
        reverseMovement: (input: ReverseMovementInput) => Promise<import("../operations/types").OperationsMovement>;
        reviewManualTally: (input: import("../operations/types").ReviewManualTallyInput) => Promise<import("../operations/types").ManualTallyReview>;
      };
    };
  }
}
