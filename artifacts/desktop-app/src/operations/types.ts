export type UserRole = "STORE" | "ACCOUNTS" | "PRODUCTION" | "SALES" | "ADMIN";

export type Permission =
  | "AUTH_MANAGE_USERS"
  | "CATALOG_MANAGE"
  | "RECEIVE_MATERIAL"
  | "INSPECT_STOCK"
  | "MARK_FAULTY"
  | "SUPPLIER_RETURN"
  | "MATERIAL_ISSUE"
  | "PRODUCTION_RETURN"
  | "STOCK_COUNT"
  | "STOCK_ADJUST"
  | "SCRAP_STOCK"
  | "SYNC_EXCEPTION_RESOLVE"
  | "QR_MANAGE"
  | "PURCHASING_MANAGE"
  | "TALLY_REVIEW"
  | "RESTOCK_VIEW"
  | "RESTOCK_MANAGE"
  | "BOM_MANAGE"
  | "PRODUCT_ORDER_MANAGE"
  | "PRODUCTION_EXECUTE"
  | "CUSTOMER_RETURN_INITIATE"
  | "CUSTOMER_RETURN_RECEIVE"
  | "TRANSACTION_REVERSE"
  | "SETTINGS_MANAGE"
  | "INVENTORY_VIEW";

export type StockCondition =
  | "AVAILABLE"
  | "PENDING_INSPECTION"
  | "FAULTY"
  | "SCRAPPED"
  | "RETURNED_TO_SUPPLIER";

export type OnHandCondition = Exclude<StockCondition, "SCRAPPED" | "RETURNED_TO_SUPPLIER">;

export type MovementType =
  | "ACCEPTED_RECEIPT"
  | "PENDING_INSPECTION_RECEIPT"
  | "FAULTY_RECEIPT"
  | "INSPECTION_RELEASE"
  | "FAULT_DISCOVERED"
  | "MATERIAL_ISSUE"
  | "PRODUCTION_RETURN"
  | "SUPPLIER_RETURN"
  | "CUSTOMER_RETURN_RECEIPT"
  | "COUNT_ADJUSTMENT_GAIN"
  | "COUNT_ADJUSTMENT_LOSS"
  | "SCRAP"
  | "PRODUCTION_COMPLETION"
  | "FAULTY_PRODUCTION_OUTPUT"
  | "OPENING_STOCK_CORRECTION"
  | "TRANSACTION_REVERSAL"
  | "SYNCHRONIZATION_EXCEPTION"
  | "MANUAL_CORRECTION";

export type FaultDiscoveryPoint =
  | "AT_RECEIPT"
  | "IN_STORES"
  | "DURING_PRODUCTION"
  | "AFTER_PRODUCTION_RETURN"
  | "AFTER_CUSTOMER_RETURN";

export type FaultResolution =
  | "PENDING"
  | "RETURNED_TO_SUPPLIER"
  | "REPLACEMENT_EXPECTED"
  | "REPLACEMENT_RECEIVED"
  | "CREDIT_NOTE_EXPECTED"
  | "CREDIT_NOTE_RECEIVED"
  | "SCRAPPED"
  | "ACCEPTED_BACK_INTO_AVAILABLE"
  | "CLOSED_WITHOUT_FURTHER_ACTION";

export type CountReason =
  | "COUNT_SURPLUS"
  | "COUNT_SHORTAGE"
  | "DAMAGED_OR_FAULTY"
  | "EXPIRED"
  | "DATA_ENTRY_CORRECTION"
  | "UNRECORDED_RECEIPT"
  | "UNRECORDED_ISSUE"
  | "RECOVERED_STOCK"
  | "OPENING_STOCK_CORRECTION"
  | "OTHER";

export interface ActorContext {
  userId: string;
  username: string;
  displayName: string;
  auditIdentity: string;
  role: UserRole;
}

export interface AuthUser extends ActorContext {
  active: boolean;
  credentialType: "PASSWORD" | "PIN";
  mustResetCredential: boolean;
  lastLogin: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  token: string;
  expiresAt: string;
  user: AuthUser;
  permissions: Permission[];
}

export interface AuthState {
  needsBootstrap: boolean;
  currentUser: AuthUser | null;
  permissions: Permission[];
  users: AuthUser[];
}

export interface BootstrapAdminInput {
  displayName: string;
  username: string;
  credential: string;
  credentialType?: "PASSWORD" | "PIN";
}

export interface LoginInput {
  username: string;
  credential: string;
  deviceLabel?: string;
}

export interface ForgotCredentialInput {
  username: string;
  credential: string;
  credentialType?: "PASSWORD" | "PIN";
}

export interface SaveUserInput {
  id?: string;
  displayName: string;
  username: string;
  role: UserRole;
  active?: boolean;
  auditIdentity?: string;
  credential?: string;
  credentialType?: "PASSWORD" | "PIN";
  mustResetCredential?: boolean;
  expectedVersion?: number;
}

export interface ResetCredentialInput {
  userId: string;
  credential: string;
  credentialType?: "PASSWORD" | "PIN";
}

export interface TraceabilityInput {
  batchNumber?: string;
  serialNumbers?: string[];
  manufacturingDate?: string;
  expiryDate?: string;
  supplierLotReference?: string;
  traceabilityNotes?: string;
}

export interface ConditionBalance {
  lotId: string;
  purchaseLotId: number;
  tallyItemGuid: string;
  itemName: string;
  itemGroup: string;
  supplierId: number | null;
  supplierName: string;
  purchaseOrderId: number | null;
  poNumber: string;
  grnNumber: string;
  receiptDate: string;
  sourceType: string;
  sourceReference: string;
  condition: OnHandCondition;
  quantity: number;
  batchNumber: string;
  serialNumbers: string[];
  manufacturingDate: string;
  expiryDate: string;
  supplierLotReference: string;
  traceabilityNotes: string;
  expired: boolean;
  expiringSoon: boolean;
}

export interface MovementLotLine {
  lotId: string;
  purchaseLotId: number;
  quantity: number;
  sourceCondition: StockCondition | null;
  targetCondition: StockCondition | null;
  serialNumbers: string[];
  batchNumber: string;
}

export interface OperationsMovement {
  id: string;
  clientTransactionId: string;
  movementType: MovementType;
  eventDate: string;
  eventTimestamp: string;
  tallyItemGuid: string;
  itemName: string;
  itemGroup: string;
  quantity: number;
  sourceCondition: StockCondition | null;
  targetCondition: StockCondition | null;
  supplierId: number | null;
  supplierName: string;
  purchaseOrderId: number | null;
  purchaseOrderReference: string;
  receiptReference: string;
  productOrderId: string;
  productName: string;
  faultId: string;
  referenceMovementId: string;
  reversalOfMovementId: string;
  status: "APPLIED" | "REVERSED" | "EXCEPTION" | "MANUAL_REVIEW";
  notes: string;
  operator: string;
  operatorRole: UserRole;
  createdAt: string;
  reversibleQuantity: number;
  lines: MovementLotLine[];
}

export interface SupplierFaultResolutionEntry {
  id: string;
  resolution: FaultResolution;
  quantity: number;
  reference: string;
  notes: string;
  recordedBy: string;
  recordedAt: string;
}

export interface SupplierFaultRecord {
  id: string;
  supplierId: number | null;
  supplierName: string;
  tallyItemGuid: string;
  itemName: string;
  quantity: number;
  unresolvedQuantity: number;
  receiptReference: string;
  purchaseOrderReference: string;
  challanReference: string;
  purchaseLotId: number | null;
  lotId: string;
  batchNumber: string;
  serialNumbers: string[];
  dateDiscovered: string;
  discoveredBy: string;
  discoveryPoint: FaultDiscoveryPoint;
  faultReason: string;
  notes: string;
  status: "OPEN" | "PARTIALLY_RESOLVED" | "RESOLVED" | "CLOSED";
  currentResolution: FaultResolution;
  createdAt: string;
  updatedAt: string;
  version: number;
  resolutions: SupplierFaultResolutionEntry[];
}

export interface CreateFaultInput {
  clientTransactionId: string;
  tallyItemGuid: string;
  quantity: number;
  lotId?: string;
  sourceCondition?: "AVAILABLE" | "PENDING_INSPECTION" | "FAULTY";
  dateDiscovered?: string;
  discoveryPoint: FaultDiscoveryPoint;
  faultReason: string;
  notes?: string;
  serialNumbers?: string[];
}

export interface ResolveFaultInput {
  clientTransactionId: string;
  faultId: string;
  quantity: number;
  resolution: FaultResolution;
  reference?: string;
  notes?: string;
  targetCondition?: "AVAILABLE" | "PENDING_INSPECTION";
  expectedVersion?: number;
  serialNumbers?: string[];
}

export interface ConditionTransitionInput {
  clientTransactionId: string;
  tallyItemGuid: string;
  lotId: string;
  quantity: number;
  fromCondition: "AVAILABLE" | "PENDING_INSPECTION" | "FAULTY";
  toCondition: StockCondition;
  eventDate?: string;
  reason: string;
  notes?: string;
  faultDiscoveryPoint?: FaultDiscoveryPoint;
  serialNumbers?: string[];
}

export interface StockCountSessionSummary {
  id: string;
  name: string;
  scope: "FULL" | "CYCLE";
  status: "DRAFT" | "COUNTING" | "FINALIZED" | "CANCELLED";
  startedAt: string;
  finalizedAt: string | null;
  startedBy: string;
  finalizedBy: string;
  itemCount: number;
  countedLines: number;
  varianceUnits: number;
  movementsAfterSnapshot: number;
  version: number;
}

export interface StockCountLine {
  sessionId: string;
  tallyItemGuid: string;
  itemName: string;
  condition: "AVAILABLE" | "FAULTY";
  snapshotExpected: number;
  postSnapshotMovement: number;
  currentExpected: number;
  countedQuantity: number | null;
  variance: number | null;
  reason: CountReason | null;
  notes: string;
  countedBy: string;
  countedAt: string | null;
  entryCount: number;
}

export interface StockCountDetail extends StockCountSessionSummary {
  lines: StockCountLine[];
}

export interface CreateCountSessionInput {
  clientTransactionId: string;
  name: string;
  scope: "FULL" | "CYCLE";
  tallyItemGuids?: string[];
  includeAvailable?: boolean;
  includeFaulty?: boolean;
}

export interface RecordCountEntryInput {
  clientTransactionId: string;
  sessionId: string;
  tallyItemGuid: string;
  condition: "AVAILABLE" | "FAULTY";
  countedQuantity: number;
  reason: CountReason;
  notes?: string;
  expectedVersion?: number;
}

export interface FinalizeCountInput {
  clientTransactionId: string;
  sessionId: string;
  expectedVersion?: number;
}

export interface ProductionReturnInput {
  clientTransactionId: string;
  tallyItemGuid: string;
  quantity: number;
  originalMovementId?: string;
  productOrderId?: string;
  lotId?: string;
  targetCondition: "AVAILABLE" | "PENDING_INSPECTION" | "FAULTY";
  explanation?: string;
  eventDate?: string;
  serialNumbers?: string[];
}

export interface SupplierReturnInput {
  clientTransactionId: string;
  tallyItemGuid: string;
  quantity: number;
  lotId: string;
  sourceCondition: "AVAILABLE" | "PENDING_INSPECTION" | "FAULTY";
  faultId?: string;
  supplierReturnReference: string;
  returnDate?: string;
  notes?: string;
  replacementStatus?: string;
  creditStatus?: string;
  serialNumbers?: string[];
}

export interface UpdateSupplierReturnInput {
  returnId: string;
  replacementStatus: string;
  creditStatus: string;
  notes?: string;
  expectedVersion?: number;
}

export interface CustomerReturnInput extends TraceabilityInput {
  clientTransactionId: string;
  externalReference: string;
  tallyItemGuid: string;
  quantity: number;
  notes?: string;
}

export interface ReceiveCustomerReturnInput extends TraceabilityInput {
  clientTransactionId: string;
  returnId: string;
  condition: "AVAILABLE" | "PENDING_INSPECTION" | "FAULTY";
  receiptDate?: string;
}

export interface ScrapInput {
  clientTransactionId: string;
  tallyItemGuid: string;
  quantity: number;
  lotId?: string;
  sourceCondition: "AVAILABLE" | "PENDING_INSPECTION" | "FAULTY";
  productOrderId?: string;
  reason: string;
  notes?: string;
  faultId?: string;
  eventDate?: string;
  serialNumbers?: string[];
}

export interface ReleaseProductOrderInput {
  clientTransactionId: string;
  productOrderId: string;
  notes?: string;
}

export interface ProductionIssueInput {
  clientTransactionId: string;
  productOrderId: string;
  tallyItemGuid: string;
  destinationTallyItemGuid: string;
  quantity: number;
  boxId?: string;
  substitutionForTallyGuid?: string;
  additionalConsumption?: boolean;
  notes?: string;
  serialNumbers?: string[];
  eventDate?: string;
}

export interface ProductionCompletionInput extends TraceabilityInput {
  clientTransactionId: string;
  productOrderId: string;
  tallyItemGuid: string;
  completedQuantity: number;
  availableQuantity?: number;
  pendingInspectionQuantity?: number;
  faultyQuantity?: number;
  completionDate?: string;
  notes?: string;
  availableSerialNumbers?: string[];
  pendingSerialNumbers?: string[];
  faultySerialNumbers?: string[];
}

export interface ProductionExecution {
  productOrderId: string;
  externalReference: string;
  productTallyGuid: string;
  productName: string;
  orderedQuantity: number;
  status: "PLANNED" | "RELEASED" | "IN_PROGRESS" | "CANCELLED" | "CLOSED";
  expectedComponents: Array<{
    tallyItemGuid: string;
    itemName: string;
    expectedQuantity: number;
    reservedQuantity: number;
    issuedQuantity: number;
    returnedQuantity: number;
    scrappedQuantity: number;
    netConsumed: number;
    variance: number;
  }>;
  finishedQuantity: number;
  faultyFinishedQuantity: number;
  notes: string;
  updatedAt: string;
  version: number;
}

export interface SyncExceptionRecord {
  id: string;
  clientTransactionId: string;
  deviceId: string;
  operator: string;
  localTimestamp: string;
  serverTimestamp: string;
  operationType: string;
  tallyItemGuid: string;
  itemName: string;
  requestedQuantity: number;
  productOrderId: string;
  reason: string;
  availableQuantity: number;
  status: "OPEN" | "RESOLVED" | "CANCELLED" | "REPLACED";
  resolutionAction: string;
  resolutionNotes: string;
  resolvedBy: string;
  resolvedAt: string | null;
  originalPayload: Record<string, unknown>;
  version: number;
}

export type SyncResolutionAction =
  | "RETRY"
  | "APPLY_AFTER_MISSING_RECEIPT"
  | "AUTHORIZED_SHORTAGE"
  | "REDUCE_TO_AVAILABLE"
  | "CANCEL"
  | "REPLACE_WITH_CORRECTED";

export interface ResolveSyncExceptionInput {
  clientTransactionId: string;
  exceptionId: string;
  action: SyncResolutionAction;
  notes?: string;
  correctedPayload?: Record<string, unknown>;
  expectedVersion?: number;
}

export interface ReverseMovementInput {
  clientTransactionId: string;
  movementId: string;
  quantity: number;
  reason: string;
  notes?: string;
  eventDate?: string;
  serialNumbers?: string[];
}

export interface ManualTallyReview {
  id: string;
  movementId: string;
  movementType: MovementType;
  eventDate: string;
  itemName: string;
  quantity: number;
  status: "PENDING" | "APPROVED" | "PROCESSED" | "REVERSED" | "FAILED";
  reviewReason: string;
  tallyVoucherReference: string;
  reviewedBy: string;
  reviewedAt: string | null;
  notes: string;
}

export interface ReviewManualTallyInput {
  reviewId: string;
  status: "APPROVED" | "PROCESSED" | "FAILED";
  tallyVoucherReference?: string;
  notes?: string;
}

export interface SupplierFaultSummary {
  supplierId: number | null;
  supplierName: string;
  tallyItemGuid: string;
  itemName: string;
  totalFaulty: number;
  unresolved: number;
  faultCount: number;
}

export interface OperationsState {
  moduleVersion: number;
  generatedAt: string;
  balances: ConditionBalance[];
  movements: OperationsMovement[];
  faults: SupplierFaultRecord[];
  faultSummary: SupplierFaultSummary[];
  countSessions: StockCountSessionSummary[];
  countDetails: StockCountDetail[];
  supplierReturns: Array<Record<string, unknown>>;
  customerReturns: Array<Record<string, unknown>>;
  scrapRecords: Array<Record<string, unknown>>;
  productionExecutions: ProductionExecution[];
  syncExceptions: SyncExceptionRecord[];
  manualTallyReviews: ManualTallyReview[];
  reports: {
    available: number;
    pendingInspection: number;
    faulty: number;
    expired: number;
    expiringSoon: number;
    serialized: number;
    unresolvedFaults: number;
    unresolvedSyncExceptions: number;
  };
}
