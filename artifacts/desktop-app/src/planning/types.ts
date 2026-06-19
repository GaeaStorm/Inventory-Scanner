export type PlanningMethod = "MANUAL" | "USAGE_SUGGESTED";
export type RestockHealth =
  | "CRITICAL"
  | "REORDER_NOW"
  | "REORDER_SOON"
  | "HEALTHY"
  | "EXCESS"
  | "UNCONFIGURED";
export type RecommendationStatus =
  | "SUGGESTED"
  | "REVIEWED"
  | "APPROVED"
  | "EXPORTED";
export type BomStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";
export type ProductOrderStatus = "DRAFT" | "CONFIRMED" | "CANCELLED" | "COMPLETED";
export type OrderFeasibility =
  | "READY"
  | "READY_WITH_INCOMING"
  | "AT_RISK"
  | "SHORT_COMPONENTS"
  | "BOM_INCOMPLETE";

export interface RestockPolicyInput {
  tallyItemGuid: string;
  planningMethod: PlanningMethod;
  reorderPoint: number;
  targetStock: number;
  serviceReserve: number;
  preferredSupplierId?: number | null;
  leadTimeDays: number;
  safetyDays: number;
  minimumOrderQuantity: number;
  usageLookbackDays: number;
  notes?: string;
  updatedBy?: string;
}

export interface RestockPolicy {
  stockItemId: number;
  tallyItemGuid: string;
  itemName: string;
  groupName: string;
  catalogSource: "TALLY" | "LOCAL";
  planningMethod: PlanningMethod;
  reorderPoint: number;
  targetStock: number;
  serviceReserve: number;
  preferredSupplierId: number | null;
  preferredSupplierName: string;
  leadTimeDays: number;
  safetyDays: number;
  minimumOrderQuantity: number;
  usageLookbackDays: number;
  notes: string;
  updatedBy: string;
  updatedAt: string;
}

export interface RestockPlanningItem extends RestockPolicy {
  onHand: number;
  reserved: number;
  available: number;
  incoming: number;
  projected: number;
  averageDailyUsage: number;
  suggestedReorderPoint: number;
  effectiveLeadTimeDays: number;
  observedLeadTimeMedianDays: number | null;
  suggestedOrderQuantity: number;
  approvedOrderQuantity: number | null;
  recommendationStatus: RecommendationStatus;
  health: RestockHealth;
  dataWarnings: string[];
}

export interface PlanningSummary {
  critical: number;
  reorderNow: number;
  reorderSoon: number;
  healthy: number;
  excess: number;
  unconfigured: number;
  ordersAtRisk: number;
  ordersReady: number;
  missingBom: number;
}

export interface BomLine {
  id: number;
  componentStockItemId: number;
  componentTallyGuid: string;
  componentName: string;
  quantityPerProduct: number;
  lossBufferPercent: number;
}

export interface BomVersion {
  id: string;
  productStockItemId: number;
  productTallyGuid: string;
  productName: string;
  versionNumber: number;
  label: string;
  status: BomStatus;
  source: "TALLY" | "MANUAL" | "FILE_IMPORT";
  validFrom: string;
  createdAt: string;
  createdBy: string;
  lines: BomLine[];
}

export interface SaveBomInput {
  productTallyGuid: string;
  label?: string;
  validFrom?: string;
  source?: "MANUAL" | "FILE_IMPORT";
  activate?: boolean;
  createdBy?: string;
  lines: Array<{
    componentTallyGuid: string;
    quantityPerProduct: number;
    lossBufferPercent?: number;
  }>;
}

export interface ProductOrderRequirement {
  componentStockItemId: number;
  componentTallyGuid: string;
  componentName: string;
  baseQuantity: number;
  lossBufferPercent: number;
  requiredQuantity: number;
  reservedQuantity: number;
  availableBeforeOrder: number;
  incomingQuantity: number;
  shortageNow: number;
  shortageAfterIncoming: number;
}

export interface ProductOrder {
  id: string;
  externalReference: string;
  productStockItemId: number;
  productTallyGuid: string;
  productName: string;
  quantity: number;
  requiredDate: string;
  status: ProductOrderStatus;
  bomVersionId: string | null;
  bomVersionLabel: string;
  feasibility: OrderFeasibility;
  notes: string;
  createdAt: string;
  updatedAt: string;
  requirements: ProductOrderRequirement[];
}

export interface SaveProductOrderInput {
  id?: string;
  externalReference: string;
  productTallyGuid: string;
  quantity: number;
  requiredDate?: string;
  status?: "DRAFT" | "CONFIRMED";
  notes?: string;
}

export interface RecommendationDecisionInput {
  tallyItemGuid: string;
  status: "REVIEWED" | "APPROVED" | "SUGGESTED";
  approvedOrderQuantity?: number | null;
  reviewedBy?: string;
}

export interface PlanningExportInput {
  includeCsv: boolean;
  exportedBy?: string;
  statuses?: Array<"REVIEWED" | "APPROVED">;
}

export interface PlanningExportResult {
  schemaVersion: string;
  batchId: string;
  excelPath: string;
  csvPath: string | null;
  itemCount: number;
  warnings: string[];
}

export interface PlanningFreshness {
  localInventoryUpdatedAt: string;
  tallySyncedAt: string | null;
  tallyStale: boolean;
  tallyAgeDays: number | null;
  message: string;
}

export interface PlanningState {
  moduleVersion: number;
  exportSchemaVersion: string;
  generatedAt: string;
  freshness: PlanningFreshness;
  summary: PlanningSummary;
  items: RestockPlanningItem[];
  boms: BomVersion[];
  productOrders: ProductOrder[];
  groups: string[];
}
