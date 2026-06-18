export type StoresWorkflow =
  | "VENDOR_MATERIAL_IN"
  | "MATERIAL_OUT"
  | "RETURN_UNUSED";

export type ReviewStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "NEEDS_CORRECTION"
  | "EXPORTED"
  | "CONFIRMED"
  | "EXCEPTION";

export interface StoresStockItem {
  id: number;
  tallyGuid: string;
  name: string;
  parentName: string;
  hasBom: boolean;
  tallyClosingQuantity: number;
  localAvailableQuantity: number;
  active: boolean;
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
  entityType: "GRN" | "MATERIAL_OUT" | "RETURN_EXCEPTION";
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

export interface StoresDatabaseStatus {
  path: string;
  schemaVersion: number;
  sizeBytes: number;
  integrity: "ok" | "error";
  backupFolder: string;
  exportFolder: string;
  latestBackup: string | null;
}

export type StoresDataMode = "empty" | "demo" | "tally";

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
  materialOutXmlConfigured: boolean;
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
  destinationTallyItemGuid: string;
  quantity: number;
  eventDate?: string;
}

export interface ReturnUnusedInput {
  clientTransactionId: string;
  boxId: string;
  tallyItemGuid: string;
  destinationTallyItemGuid: string;
  quantity: number;
  eventDate?: string;
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
