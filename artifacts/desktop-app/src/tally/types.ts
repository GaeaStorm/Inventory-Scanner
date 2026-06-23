export interface TallyConnectionSettings {
  host: string;
  port: number;
  company: string;
  timeoutMs: number;
  historyFrom: string;
  fullVoucherHistory: boolean;
}

export interface TallyCompany {
  name: string;
  guid: string;
  booksFrom: string;
  startingFrom: string;
  endingAt: string;
}

export interface TallyNamedMaster {
  name: string;
  parent: string;
  guid: string;
  alterId: string;
}

export interface TallyVoucherType extends TallyNamedMaster {
  reservedName: string;
}

export interface TallyStockItem {
  code: string;
  name: string;
  guid: string;
  alterId: string;
  parent: string;
  category: string;
  partNumber: string;
  description: string;
  openingBalance: string;
  closingBalance: string;
  openingQuantity: number | null;
  closingQuantity: number | null;
  openingValue: string;
  closingValue: string;
  openingValueNumber: number | null;
  closingValueNumber: number | null;
  standardCost: string;
  standardPrice: string;
  hasBom: boolean;
}

export interface TallyBomComponent {
  productCode: string;
  productName: string;
  productGuid: string;
  bomName: string;
  componentCode: string;
  componentName: string;
  componentGuid: string;
  quantity: string;
  quantityNumber: number | null;
}

export interface TallySupplier {
  name: string;
  guid: string;
  alterId: string;
  parent: string;
}

export interface TallyVoucherInventoryLine {
  itemName: string;
  itemGuid: string;
  quantity: number | null;
  rate: number | null;
  value: number | null;
  orderNumber: string;
  trackingNumber: string;
}

export interface TallyPurchaseOrder {
  guid: string;
  voucherNumber: string;
  voucherDate: string;
  supplierName: string;
  supplierGuid: string;
  reference: string;
  lines: TallyVoucherInventoryLine[];
}

export interface TallySalesOrder {
  guid: string;
  voucherNumber: string;
  voucherDate: string;
  customerName: string;
  reference: string;
  lines: TallyVoucherInventoryLine[];
}

export interface TallyGrn {
  guid: string;
  voucherNumber: string;
  voucherDate: string;
  supplierName: string;
  supplierGuid: string;
  poNumber: string;
  trackingNumber: string;
  challanNumber: string;
  challanDate: string;
  lines: TallyVoucherInventoryLine[];
}

export interface TallyHistoryScanSummary {
  fromDate: string;
  toDate: string;
  dateChunks: number;
  vouchersScanned: number;
  inventoryVouchersScanned: number;
  purchaseOrdersFound: number;
  receiptNotesFound: number;
  purchaseVouchersFound: number;
  voucherTypesFound: number;
  purchaseOrderTypeNames: string[];
  receiptNoteTypeNames: string[];
  purchaseTypeNames: string[];
  inventoryVoucherTypeNames: string[];
}

export interface TallyStoresSnapshot {
  schemaVersion: 2;
  syncedAt: string;
  endpoint: string;
  company: string;
  companyGuid: string;
  companies: TallyCompany[];
  stockGroups: TallyNamedMaster[];
  stockCategories: TallyNamedMaster[];
  stockItems: TallyStockItem[];
  bomComponents: TallyBomComponent[];
  suppliers: TallySupplier[];
  purchaseOrders: TallyPurchaseOrder[];
  salesOrders?: TallySalesOrder[];
  grns: TallyGrn[];
  voucherTypes?: TallyVoucherType[];
  historyScan?: TallyHistoryScanSummary;
  warnings: string[];
}

export interface TallyState {
  settings: TallyConnectionSettings;
  cache: TallyStoresSnapshot | null;
  cachePath: string;
}

export interface TallyConnectionResult {
  settings: TallyConnectionSettings;
  endpoint: string;
  latencyMs: number;
  companies: TallyCompany[];
  warning: string | null;
}
