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
export type ProductOrderFieldType = "TEXT" | "NUMBER" | "DATE" | "BOOLEAN";
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
  primaryGroupName: string;
  secondaryGroupName: string;
  catalogSource: "TALLY" | "LOCAL";
  catalogStatus: "ACTIVE" | "OBSOLETE";
  catalogRole: import("../stores/types").CatalogRole;
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
  yearsOfStock: number | null;
  suggestedObsoleteTarget: number;
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
  versionNumber?: number;
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
  fileNumber: string;
  organisation: string;
  externalReference: string;
  purchaseOrderDate: string;
  lastDispatchDate: string;
  productStockItemId: number;
  productTallyGuid: string;
  productName: string;
  quantity: number;
  pendingQuantity: number | null;
  valueIncludingGst: number | null;
  pendingMaterial: string;
  rawMaterialToOrder: string;
  crfStatus: string;
  cracStatus: string;
  taskRemarks: string;
  responsiblePerson: string;
  followUpDate: string;
  dispatchSchedule: string;
  priority: string;
  requiredDate: string;
  status: ProductOrderStatus;
  workflowStateId: string;
  workflowStateName: string;
  workflowStateColor: string;
  stageHistory: ProductOrderStageHistory[];
  bomVersionId: string | null;
  bomVersionLabel: string;
  feasibility: OrderFeasibility;
  notes: string;
  customFields: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
  requirements: ProductOrderRequirement[];
}

export interface ProductOrderStageHistory {
  id: string;
  stateId: string;
  stateName: string;
  enteredAt: string;
  exitedAt: string | null;
  durationHours: number;
}

export interface SaveProductOrderInput {
  id?: string;
  fileNumber?: string;
  organisation?: string;
  externalReference: string;
  purchaseOrderDate?: string;
  lastDispatchDate?: string;
  productTallyGuid: string;
  quantity: number;
  pendingQuantity?: number | null;
  valueIncludingGst?: number | null;
  pendingMaterial?: string;
  rawMaterialToOrder?: string;
  crfStatus?: string;
  cracStatus?: string;
  taskRemarks?: string;
  responsiblePerson?: string;
  followUpDate?: string;
  dispatchSchedule?: string;
  priority?: string;
  requiredDate?: string;
  status?: "DRAFT" | "CONFIRMED";
  workflowStateId?: string;
  notes?: string;
  customFields?: Record<string, string | number | boolean | null>;
}

export interface ProductOrderWorkflowState {
  id: string;
  name: string;
  color: string;
  position: number;
  terminal: boolean;
}

export interface ProductOrderFieldDefinition {
  id: string;
  key: string;
  label: string;
  type: ProductOrderFieldType;
  position: number;
}

export interface SaveProductOrderWorkflowStateInput {
  name: string;
  color?: string;
  terminal?: boolean;
}

export interface SaveProductOrderFieldDefinitionInput {
  label: string;
  type: ProductOrderFieldType;
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
  productOrderWorkflowStates: ProductOrderWorkflowState[];
  productOrderFieldDefinitions: ProductOrderFieldDefinition[];
  groups: string[];
  primaryGroups: string[];
  secondaryGroups: string[];
}
