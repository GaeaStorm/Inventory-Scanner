import type {
  BulkVendorReceiptInput,
  BulkVendorReceiptResult,
  ConfirmImportInput,
  CreateLocalStockItemInput,
  CreateCatalogGroupInput,
  CreateStockCategoryInput,
  DesktopInfo,
  DeploymentState,
  SaveDeploymentInput,
  ExportBatchInput,
  ExportBatchResult,
  OpeningQuantityInput,
  RenameStockItemInput,
  CatalogCleanupExportResult,
  ReviewDecisionInput,
  SaveBoxInput,
  SetCatalogStatusInput,
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
  SaveProductOrderFieldDefinitionInput,
  SaveProductOrderWorkflowStateInput,
  SaveSalesOrderInput,
  SaveSalesOrderWorkflowStageInput,
  SalesOrderVoucherExportInput,
  SalesOrderVoucherExportResult,
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
  ConfirmCredentialRecoveryInput,
  RequestCredentialRecoveryInput,
  ProductionReturnInput,
  SupplierReturnInput,
  CustomerReturnInput,
  ReceiveCustomerReturnInput,
  ScrapInput,
  ProductionIssueInput,
  ProductionCompletionInput,
  ResolveSyncExceptionInput,
  ReverseMovementInput,
  ScannerDevice,
  ScannerPairing,
} from "./types";

export {};

declare global {
  interface Window {
    desktop: {
      deployment: {
        getState: () => Promise<DeploymentState>;
        testProduction: (input: Pick<SaveDeploymentInput, "productionHost" | "inventoryPort">) => Promise<{ ok: true; url: string; message: string }>;
        save: (input: SaveDeploymentInput) => Promise<DeploymentState>;
      };
      getInfo: () => Promise<DesktopInfo>;
      sync: {
        status: () => Promise<{
          online: boolean;
          queuedCount: number;
          reviewable: Array<{ operationId: string; type: string; status: string; result: unknown; createdAt: string }>;
        }>;
      };
      auth: {
        state: (token?: string) => Promise<AuthState>;
        bootstrap: (input: BootstrapAdminInput) => Promise<AuthSession>;
        login: (input: LoginInput) => Promise<AuthSession>;
        updateEmail: (input: { email: string }) => Promise<import("../operations/types").AuthUser>;
        requestRecovery: (input: RequestCredentialRecoveryInput) => Promise<void>;
        confirmRecovery: (input: ConfirmCredentialRecoveryInput) => Promise<void>;
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
          orderImport: { imported: number; skipped: number; unmatched: number };
          state: StoresState;
        }>;
      };
      stores: {
        getState: () => Promise<StoresState>;
        createLocalStockItem: (input: CreateLocalStockItemInput) => Promise<StoresState>;
        deleteLocalStockItem: (tallyItemGuid: string) => Promise<StoresState>;
        saveItemFieldDefinition: (input: { groupName?: string; label: string; required: boolean }) => Promise<StoresState>;
        deleteItemFieldDefinition: (fieldId: string) => Promise<StoresState>;
        reorderItemFieldDefinitions: (orderedIds: string[], groupName: string) => Promise<StoresState>;
        createCatalogGroup: (input: CreateCatalogGroupInput) => Promise<StoresState>;
        deleteCatalogGroup: (name: string) => Promise<StoresState>;
        createStockCategory: (input: CreateStockCategoryInput) => Promise<StoresState>;
        deleteStockCategory: (name: string) => Promise<StoresState>;
        setCatalogStatus: (input: SetCatalogStatusInput) => Promise<StoresState>;
        setGroupCatalogRole: (input: { groupName: string; role: string }) => Promise<StoresState>;
        setCatalogRole: (input: { tallyItemGuid: string; role: string | null }) => Promise<StoresState>;
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
      scanners: {
        createPairing: (label: string) => Promise<ScannerPairing>;
        list: () => Promise<ScannerDevice[]>;
        revoke: (deviceId: string) => Promise<void>;
      };
      planning: {
        getState: () => Promise<PlanningState>;
        saveRestockPolicy: (input: RestockPolicyInput) => Promise<PlanningState>;
        recommendationDecision: (input: RecommendationDecisionInput) => Promise<PlanningState>;
        saveBom: (input: SaveBomInput) => Promise<PlanningState>;
        activateBom: (bomId: string) => Promise<PlanningState>;
        saveProductOrder: (input: SaveProductOrderInput) => Promise<PlanningState>;
        saveSalesOrder: (input: SaveSalesOrderInput) => Promise<PlanningState>;
        updateProductOrderStatus: (
          orderId: string,
          status: "CANCELLED" | "COMPLETED" | "CONFIRMED" | "ON_HOLD",
        ) => Promise<PlanningState>;
        updateProductOrderWorkflowState: (orderId: string, workflowStateId: string) => Promise<PlanningState>;
        bulkUpdateProductOrders: (input: import("../planning/types").BulkProductOrderUpdateInput) => Promise<PlanningState>;
        saveProductOrderWorkflowState: (input: SaveProductOrderWorkflowStateInput) => Promise<PlanningState>;
        saveSalesOrderWorkflowStage: (input: SaveSalesOrderWorkflowStageInput) => Promise<PlanningState>;
        deleteProductOrderWorkflowState: (stateId: string) => Promise<PlanningState>;
        deleteSalesOrderWorkflowStage: (input: { id: string; orderKind: import("../planning/types").SalesOrderKind; stockGroupName?: string }) => Promise<PlanningState>;
        saveProductOrderFieldDefinition: (input: SaveProductOrderFieldDefinitionInput) => Promise<PlanningState>;
        deleteProductOrderFieldDefinition: (fieldId: string) => Promise<PlanningState>;
        exportRestock: (input: PlanningExportInput) => Promise<PlanningExportResult>;
        exportSalesOrderVouchers: (input: SalesOrderVoucherExportInput) => Promise<SalesOrderVoucherExportResult>;
        addSalesOrderFulfilmentLine: (input: import("../planning/types").SaveSalesOrderFulfilmentLineInput) => Promise<PlanningState>;
        advanceFulfilmentLineStage: (fulfilmentLineId: string, targetStage: string) => Promise<PlanningState>;
        assignResaleSupplier: (fulfilmentLineId: string, supplierId: number) => Promise<PlanningState>;
        setFulfilmentLineServiceDone: (fulfilmentLineId: string, done: boolean) => Promise<PlanningState>;
        requestPoApproval: (salesOrderId: string) => Promise<PlanningState>;
        setSalesOrderDueDate: (salesOrderId: string, dueDate: string) => Promise<PlanningState>;
        setSalesOrderHoldStatus: (salesOrderId: string, holdStatus: "NONE" | "ON_HOLD" | "CANCELLED") => Promise<PlanningState>;
        setFulfilmentLineHoldStatus: (fulfilmentLineId: string, holdStatus: "NONE" | "ON_HOLD" | "CANCELLED") => Promise<PlanningState>;
        submitCrfForApproval: (salesOrderId: string) => Promise<PlanningState>;
        decideApproval: (requestId: string, decision: "APPROVE" | "REJECT", comment: string) => Promise<PlanningState>;
        saveChecklistTemplate: (input: import("../planning/types").SaveChecklistTemplateInput) => Promise<PlanningState>;
        waiveChecklistRequirement: (salesOrderId: string, requirementId: string, reason: string) => Promise<PlanningState>;
        getChecklistResultsForOrder: (salesOrderId: string) => Promise<import("../planning/types").ChecklistResult[]>;
        advanceSalesOrderStage: (orderId: string, targetStage: import("../planning/types").SalesOrderStage) => Promise<PlanningState>;
        applySourceAmendment: (amendmentId: string) => Promise<PlanningState>;
        requestCrfReapproval: (salesOrderId: string) => Promise<PlanningState>;
        getCrfHtml: (revisionId: string) => Promise<string>;
        printCrfToPdf: (html: string, suggestedName: string) => Promise<{ savedPath: string | null }>;
      };
      operations: {
        getState: () => Promise<OperationsState>;
        saveUser: (input: SaveUserInput) => Promise<import("../operations/types").AuthUser>;
        resetCredential: (input: ResetCredentialInput) => Promise<void>;
        listRoles: () => Promise<Array<{ name: string; isSystem: boolean }>>;
        createRole: (name: string) => Promise<Array<{ name: string; isSystem: boolean }>>;
        deleteRole: (name: string) => Promise<Array<{ name: string; isSystem: boolean }>>;
        getRolePermissions: () => Promise<Array<{ roleName: string; permission: string; enabled: boolean }>>;
        setRolePermission: (input: { roleName: string; permission: string; enabled: boolean }) => Promise<Array<{ roleName: string; permission: string; enabled: boolean }>>;
        getComputerRestrictions: () => Promise<Array<{ permission: string; computerNames: string[] }>>;
        setComputerRestriction: (input: { permission: string; computerNames: string[] }) => Promise<Array<{ permission: string; computerNames: string[] }>>;
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
