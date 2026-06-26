export type StoresWorkflow =
  | "VENDOR_MATERIAL_IN"
  | "MATERIAL_OUT"
  | "ADJUSTMENT";

export type AdjustmentDirection = "RETURN_TO_STOCK" | "ADDITIONAL_OUT";
export type MaterialOutPurpose = "PRODUCTION" | "SERVICING" | "CUSTOMER_EXTRAS";

export type AdjustmentReason =
  | "UNUSED_MATERIAL"
  | "MISCOUNT"
  | "DATA_ENTRY_ERROR"
  | "DAMAGE_OR_LOSS"
  | "OTHER";

export type ReviewStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "NEEDS_CORRECTION"
  | "EXPORTED"
  | "CONFIRMED"
  | "EXCEPTION";

/** A single designation shared by Stock Groups and Stock Items — NEITHER is the default for everything. */
export type CatalogRole = "PRODUCT" | "SERVICE" | "NEITHER" | "IGNORED";

export interface StoresStockItem {
  id: number;
  tallyGuid: string;
  tallyName: string;
  name: string;
  /** Display-only "Group > Subgroup > Name" breadcrumb. Never use this to look up an item — identity is always tallyGuid/id. */
  qualifiedName: string;
  parentName: string;
  groupPath: string[];
  categoryName: string;
  baseUnits: string;
  primaryGroupName: string;
  secondaryGroupName: string;
  hasBom: boolean;
  tallyClosingQuantity: number;
  localAvailableQuantity: number;
  localPendingInspectionQuantity: number;
  localFaultyQuantity: number;
  expiredQuantity: number;
  expiringSoonQuantity: number;
  serializedQuantity: number;
  active: boolean;
  source: "TALLY" | "LOCAL";
  catalogStatus: "ACTIVE" | "DUPLICATE" | "OBSOLETE";
  isProduct: boolean;
  isService: boolean;
  /** This item's own explicit designation, if any — null means it inherits from the nearest ancestor Stock Group that has one set (or NEITHER if none do). */
  catalogRoleOverride: CatalogRole | null;
  /** The designation actually in effect for this item (its own override, else inherited from its Stock Group hierarchy, else NEITHER). */
  effectiveCatalogRole: CatalogRole;
  ignored: boolean;
  duplicateOfTallyGuid: string | null;
  duplicateOfName: string | null;
  /** Specification field values (field key -> typed value) for the additional hierarchy levels appended to the generated Tally name. */
  fieldValues: Record<string, string>;
}

/** An admin-defined specification field (e.g. "Pin count", "Color") appended in order to the generated Tally name for new local items. */
export interface ItemFieldDefinition {
  id: string;
  /** The Stock Group this field belongs to, or "" for the global/Primary scope that applies to every item. */
  groupName: string;
  key: string;
  label: string;
  required: boolean;
  position: number;
}

export interface SaveItemFieldDefinitionInput {
  groupName?: string;
  label: string;
  required: boolean;
}

export interface StoresSupplier {
  id: number;
  tallyGuid: string;
  name: string;
}

export interface StoresPurchaseOrderLine {
  id: number;
  stockItemId: number;
  itemName: string;
  tallyItemGuid: string;
  orderedQuantity: number;
  acceptedQuantity: number;
  receivedQuantity: number;
  outstandingQuantity: number;
  rate: number | null;
  value: number | null;
}

export interface StoresPurchaseOrder {
  id: number;
  tallyGuid: string;
  voucherNumber: string;
  voucherDate: string;
  supplierId: number | null;
  supplierName: string;
  status: "OPEN" | "CLOSED" | "UNKNOWN";
  lines: StoresPurchaseOrderLine[];
}

export interface StoresBoxItem {
  stockItemId: number;
  tallyItemGuid: string;
  itemName: string;
  sortOrder: number;
}

export interface StoresBox {
  boxId: string;
  companyId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  items: StoresBoxItem[];
}

export interface StoresPurchaseLot {
  id: number;
  itemName: string;
  tallyItemGuid: string;
  supplierName: string;
  sourceType: "GRN" | "LEGACY_OPENING" | "LOCAL_GRN";
  poNumber: string;
  grnNumber: string;
  receiptDate: string;
  challanNumber: string;
  quantityReceived: number;
  quantityRemaining: number;
  pendingInspectionQuantity: number;
  faultyQuantity: number;
  batchNumber: string;
  serialNumbers: string[];
  manufacturingDate: string;
  expiryDate: string;
  supplierLotReference: string;
  traceabilityNotes: string;
  rate: number | null;
  value: number | null;
  legacyWarning: boolean;
}

export interface StoresMovement {
  id: string;
  workflow: StoresWorkflow;
  eventDate: string;
  boxId: string;
  itemName: string;
  tallyItemGuid: string;
  quantity: number;
  destinationName: string;
  supplierName: string;
  poNumber: string;
  challanNumber: string;
  status: ReviewStatus;
  createdAt: string;
  adjustmentDirection: AdjustmentDirection | null;
  adjustmentReason: AdjustmentReason | null;
  adjustmentNote: string;
  referenceMovementId: string;
  operatorName: string;
  operatorRole: string;
  productOrderId: string;
  stockCondition: string;
  batchNumber: string;
  serialNumbers: string[];
}

export interface StoresFifoAllocation {
  id: number;
  movementId: string;
  purchaseLotId: number;
  itemName: string;
  supplierName: string;
  grnNumber: string;
  receiptDate: string;
  quantity: number;
  direction: "OUT" | "RESTORE";
}

export interface StoresReviewEntry {
  id: string;
  entityType: "GRN" | "MATERIAL_OUT" | "ADJUSTMENT_EXCEPTION";
  entityId: string;
  status: ReviewStatus;
  externalId: string;
  eventDate: string;
  title: string;
  supplierName: string;
  poNumber: string;
  challanNumber: string;
  issuedItemName: string;
  destinationName: string;
  quantity: number;
  fifoSummary: string;
  validationMessages: string[];
  contributingTransactions: number;
  tallyVoucherNumber: string;
}

export interface StoresSyncSummary {
  syncedAt: string | null;
  stockItemsImported: number;
  suppliersImported: number;
  openPurchaseOrdersImported: number;
  historicalGrnsImported: number;
  purchaseLotsReconstructed: number;
  openingLegacyItems: number;
  historicalVouchersScanned: number;
  inventoryVouchersScanned: number;
  receiptNotesDetected: number;
  receiptNoteTypeNames: string[];
  warnings: string[];
}

export interface StoresBackupInfo {
  path: string;
  fileName: string;
  createdAt: string;
  sizeBytes: number;
  valid: boolean;
  schemaVersion: number;
}

export interface StoresDatabaseStatus {
  path: string;
  schemaVersion: number;
  sizeBytes: number;
  integrity: "ok" | "error";
  backupFolder: string;
  exportFolder: string;
  latestBackup: string | null;
  hostId: string;
  writerMode: "AUTHORITATIVE_HOST";
  backups: StoresBackupInfo[];
}

export interface StoresOpeningQuantityAdjustment {
  id: string;
  tallyItemGuid: string;
  itemName: string;
  previousAvailableQuantity: number;
  targetAvailableQuantity: number;
  deltaQuantity: number;
  reason: string;
  adjustedBy: string;
  createdAt: string;
}

export type StoresDataMode = "empty" | "demo" | "local" | "tally";

export interface StoresCatalogGroup {
  name: string;
  parentName: string;
  primaryName: string;
  type: "PRIMARY" | "SECONDARY";
  level: number;
  path: string[];
  source: "TALLY" | "LOCAL";
  /** This group's own explicit designation — NEITHER when never explicitly set. */
  catalogRole: CatalogRole;
  /** The designation in effect for items in this group: this group's own role if set, else the nearest ancestor's, else NEITHER. */
  effectiveCatalogRole: CatalogRole;
  ignored: boolean;
  itemCount: number;
}

export interface StoresStockCategory {
  name: string;
  parentName: string;
  level: number;
  path: string[];
  source: "TALLY" | "LOCAL";
  itemCount: number;
}

export interface StoresQualifiedNameCollision {
  qualifiedName: string;
  itemIds: number[];
}

export interface StoresState {
  database: StoresDatabaseStatus;
  dataMode: StoresDataMode;
  companyGuid: string;
  companyName: string;
  sync: StoresSyncSummary;
  stockItems: StoresStockItem[];
  suppliers: StoresSupplier[];
  purchaseOrders: StoresPurchaseOrder[];
  boxes: StoresBox[];
  purchaseLots: StoresPurchaseLot[];
  recentMovements: StoresMovement[];
  reviewEntries: StoresReviewEntry[];
  openingQuantityAdjustments: StoresOpeningQuantityAdjustment[];
  catalogGroups: StoresCatalogGroup[];
  stockCategories: StoresStockCategory[];
  qualifiedNameCollisions: StoresQualifiedNameCollision[];
  exportSchemaVersion: string;
  materialOutXmlConfigured: boolean;
  itemFieldDefinitions: ItemFieldDefinition[];
}

export interface CreateLocalStockItemInput {
  name: string;
  parentName?: string;
  categoryName?: string;
  baseUnits?: string;
  /** Specification field values (field key -> typed value), used to build a unique generated Tally name. */
  fieldValues?: Record<string, string>;
}

export interface CreateCatalogGroupInput {
  name: string;
  parentName?: string;
}

export interface DeleteCatalogGroupInput {
  name: string;
}

export interface CreateStockCategoryInput {
  name: string;
  parentName?: string;
}

export interface DeleteStockCategoryInput {
  name: string;
}

export interface DeleteStockItemInput {
  tallyItemGuid: string;
}

export interface SetCatalogStatusInput {
  tallyItemGuid: string;
  status: "ACTIVE" | "DUPLICATE" | "OBSOLETE";
  duplicateOfTallyGuid?: string | null;
}

export interface SetCatalogRoleInput {
  tallyItemGuid: string;
  /** Null clears the item's own override so it inherits from its Stock Group again. */
  role: CatalogRole | null;
}

export interface SetGroupRoleInput {
  groupName: string;
  role: CatalogRole;
}

export interface GeneratedExportFile {
  path: string;
  name: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface RenameStockItemInput {
  tallyItemGuid: string;
  name: string;
}

export interface CatalogCleanupExportResult {
  workbookPath: string;
  renameXmlPath: string | null;
  groupCount: number;
  categoryCount: number;
  itemCount: number;
  renameCount: number;
  duplicateCount: number;
  obsoleteCount: number;
  warnings: string[];
}

export interface SaveBoxInput {
  boxId: string;
  companyId: string;
  expectedRevision?: number;
  tallyItemGuids: string[];
}

export interface VendorReceiptInput {
  clientTransactionId: string;
  boxId: string;
  tallyItemGuid: string;
  supplierId: number;
  purchaseOrderId?: number | null;
  challanNumber: string;
  challanDate: string;
  quantity: number;
  receiptDate?: string;
  nonPoException?: boolean;
}

export interface BulkVendorReceiptLineInput {
  tallyItemGuid: string;
  quantity: number;
  rejectedQuantity?: number;
  acceptedQuantity?: number;
  pendingInspectionQuantity?: number;
  faultyQuantity?: number;
  expectedQuantity?: number;
  discrepancyType?: "" | "SHORT_DELIVERY" | "EXCESS_DELIVERY" | "WRONG_ITEM" | "DAMAGED" | "NON_FUNCTIONAL" | "OTHER";
  wrongItemTallyGuid?: string;
  faultReason?: string;
  batchNumber?: string;
  serialNumbers?: string[];
  availableSerialNumbers?: string[];
  pendingSerialNumbers?: string[];
  faultySerialNumbers?: string[];
  manufacturingDate?: string;
  expiryDate?: string;
  supplierLotReference?: string;
  traceabilityNotes?: string;
}

export interface BulkVendorReceiptInput {
  clientTransactionId: string;
  supplierId: number;
  purchaseOrderId?: number | null;
  challanNumber: string;
  challanDate: string;
  receiptDate?: string;
  nonPoException?: boolean;
  lines: BulkVendorReceiptLineInput[];
}

export interface BulkVendorReceiptResult {
  grnNumber: string;
  movements: StoresMovement[];
}

export interface MaterialOutInput {
  clientTransactionId: string;
  boxId: string;
  tallyItemGuid: string;
  purpose?: MaterialOutPurpose;
  destinationTallyItemGuid?: string;
  quantity: number;
  eventDate?: string;
  productOrderId?: string;
  substitutionForTallyGuid?: string;
  additionalConsumption?: boolean;
  notes?: string;
  serialNumbers?: string[];
}

export interface AdjustmentInput {
  clientTransactionId: string;
  boxId: string;
  tallyItemGuid: string;
  destinationTallyItemGuid?: string;
  quantity: number;
  direction: AdjustmentDirection;
  reason: AdjustmentReason;
  note?: string;
  eventDate?: string;
  targetCondition?: "AVAILABLE" | "PENDING_INSPECTION" | "FAULTY";
  serialNumbers?: string[];
  productOrderId?: string;
}

export interface AdjustmentContext {
  materialOutVoucherId: string;
  eventDate: string;
  issuedItemName: string;
  destinationName: string;
  pendingQuantity: number;
  latestMovementId: string;
  latestMovementQuantity: number;
  latestMovementCreatedAt: string;
  status: ReviewStatus;
  tallyVoucherNumber: string;
}

export interface OpeningQuantityInput {
  clientTransactionId: string;
  tallyItemGuid: string;
  targetQuantity: number;
  reason: string;
  adjustedBy?: string;
}

export type StoresOfflineOperation =
  | { type: "MATERIAL_OUT"; clientTransactionId: string; payload: MaterialOutInput }
  | { type: "ADJUSTMENT"; clientTransactionId: string; payload: AdjustmentInput };

export interface StoresOfflineBatchInput {
  deviceId: string;
  operator?: string;
  localTimestamp?: string;
  operations: StoresOfflineOperation[];
}

export interface StoresOfflineBatchItemResult {
  clientTransactionId: string;
  status: "ACCEPTED" | "REJECTED" | "RETRY";
  movement?: StoresMovement;
  error?: string;
  exceptionId?: string;
}

export interface StoresOfflineBatchResult {
  receivedAt: string;
  results: StoresOfflineBatchItemResult[];
}

export interface ReviewDecisionInput {
  entryId: string;
  status: "APPROVED" | "REJECTED" | "NEEDS_CORRECTION";
  reviewedBy: string;
  note?: string;
}

export interface ExportBatchInput {
  reviewedBy: string;
  includeCsv: boolean;
}

export interface ConfirmImportInput {
  entryId: string;
  tallyVoucherNumber: string;
  recordedBy: string;
  note?: string;
}

export interface ExportBatchResult {
  schemaVersion: string;
  batchId: string;
  excelPath: string;
  csvPath: string | null;
  xmlPath: string;
  warnings: string[];
}

export interface StoresBackupResult {
  path: string;
  createdAt: string;
  valid: boolean;
}

export interface StoresRestoreResult {
  restoredFrom: string;
  safetyBackupPath: string;
  restoredAt: string;
  state: StoresState;
}
