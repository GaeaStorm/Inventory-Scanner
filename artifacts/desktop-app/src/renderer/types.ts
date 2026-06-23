export type AppTab = "tracker" | "operations" | "dashboard" | "administration" | "qr" | "settings" | "tally";

export interface DesktopInfo {
  appVersion: string;
  apiBaseUrl: string;
  computerName: string;
  deploymentRole: DeploymentRole;
  tallyComputerHost: string;
  dataDirectory: string;
  excelPath: string;
  databasePath: string;
  port: number;
  scannerUrls: string[];
}

export type DeploymentRole = "UNCONFIGURED" | "PRODUCTION_SERVER" | "LAN_CLIENT";

export interface DeploymentState {
  configured: boolean;
  role: DeploymentRole;
  productionHost: string;
  inventoryPort: number;
  tallyHost: string;
  tallyPort: number;
  accountsComputer: boolean;
  platform: string;
  productionUrl: string;
}

export interface SaveDeploymentInput {
  role: Exclude<DeploymentRole, "UNCONFIGURED">;
  productionHost: string;
  inventoryPort: number;
  tallyHost: string;
  tallyPort: number;
  accountsComputer: boolean;
  configureWindowsFirewall: boolean;
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
  SetCatalogStatusInput,
  SetCatalogClassificationInput,
  CatalogRole,
  GeneratedExportFile,
  StoresBackupResult,
  StoresBox,
  StoresState,
  StoresStockItem,
  StoresSupplier,
  VendorReceiptInput,
  MaterialOutInput,
  AdjustmentInput,
  OpeningQuantityInput,
  RenameStockItemInput,
  CatalogCleanupExportResult,
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
  ProductOrderFieldDefinition,
  ProductOrderFieldType,
  ProductOrderWorkflowState,
  SaveProductOrderFieldDefinitionInput,
  SaveProductOrderWorkflowStateInput,
  PlanningExportInput,
  PlanningExportResult,
} from "../planning/types";

export type {
  ActorContext,
  AuthSession,
  AuthState,
  AuthUser,
  BootstrapAdminInput,
  ConditionBalance,
  ConditionTransitionInput,
  CreateCountSessionInput,
  CreateFaultInput,
  CustomerReturnInput,
  FinalizeCountInput,
  ForgotCredentialInput,
  LoginInput,
  ManualTallyReview,
  OperationsMovement,
  OperationsState,
  Permission,
  ProductionCompletionInput,
  ProductionExecution,
  ProductionIssueInput,
  ProductionReturnInput,
  ReceiveCustomerReturnInput,
  RecordCountEntryInput,
  ResetCredentialInput,
  ResolveFaultInput,
  ResolveSyncExceptionInput,
  ReverseMovementInput,
  SaveUserInput,
  ScrapInput,
  StockCondition,
  StockCountDetail,
  SupplierFaultRecord,
  SupplierReturnInput,
  UserRole,
} from "../operations/types";
