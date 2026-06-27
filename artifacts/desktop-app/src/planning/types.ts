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
export type ProductOrderStatus = "DRAFT" | "CONFIRMED" | "ON_HOLD" | "CANCELLED" | "COMPLETED";
export type ProductOrderType = "PRODUCTION" | "SERVICE";
export type WarrantyStatus = "IN_WARRANTY" | "OUT_OF_WARRANTY" | "NOT_APPLICABLE";
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
  /** Display-only "Group > Subgroup > Name" breadcrumb. Never use this to look up an item. */
  qualifiedName: string;
  groupName: string;
  groupPath: string[];
  primaryGroupName: string;
  secondaryGroupName: string;
  catalogSource: "TALLY" | "LOCAL";
  catalogStatus: "ACTIVE" | "OBSOLETE";
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
  orderType: ProductOrderType;
  serialNumber: string;
  warrantyStatus: WarrantyStatus;
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
  activity: ProductOrderActivity[];
  bomVersionId: string | null;
  bomVersionLabel: string;
  feasibility: OrderFeasibility;
  notes: string;
  customFields: Record<string, string | number | boolean | null>;
  createdAt: string;
  updatedAt: string;
  requirements: ProductOrderRequirement[];
}

export interface ProductOrderActivity {
  id: string;
  eventType: "CREATED" | "UPDATED" | "STAGE_CHANGED" | "STATUS_CHANGED" | "TALLY_IMPORTED";
  actorName: string;
  actorRole: string;
  summary: string;
  createdAt: string;
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
  orderType?: ProductOrderType;
  serialNumber?: string;
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
  orderType: ProductOrderType;
  stockGroupName: string;
  name: string;
  color: string;
  position: number;
  terminal: boolean;
  requiredPermissions: string[];
}

export interface ProductOrderFieldDefinition {
  id: string;
  key: string;
  label: string;
  type: ProductOrderFieldType;
  position: number;
}

export interface SaveProductOrderWorkflowStateInput {
  id?: string;
  orderType?: ProductOrderType;
  stockGroupName?: string;
  name: string;
  color?: string;
  position?: number;
  terminal?: boolean;
  requiredPermissions?: string[];
}

export interface BulkProductOrderUpdateInput {
  orderIds: string[];
  workflowStateId?: string;
  responsiblePerson?: string;
  priority?: string;
}

export interface TallySalesOrderImportLine {
  tallyGuid: string;
  voucherNumber: string;
  voucherDate: string;
  customerName: string;
  reference: string;
  productTallyGuid: string;
  productName: string;
  quantity: number;
  value: number | null;
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

/** Derived from a Tally Stock Group's top-level ancestry; never set manually. */
export type ItemFamily = "MANUFACTURED" | "RESALE" | "SERVICE" | "RAW_MATERIAL" | "UNKNOWN";

export type SalesOrderStage = string;
export type SalesOrderKind = "SALES" | "SERVICE";

/** Independent of orderStage/stage — putting something on hold or cancelling it never writes a stage-history row, so no duration is ever attributed to the hold period. */
export type HoldStatus = "NONE" | "ON_HOLD" | "CANCELLED";

export type FulfilmentConsumptionMode = "SOLD_DIRECT" | "INTERNAL_CONSUMPTION";

/** A read-only Tally voucher line. Sales builds fulfilment lines separately; these are never edited. */
export interface SalesOrderSourceLine {
  id: string;
  tallyVoucherLineGuid: string;
  itemId: number;
  itemTallyGuid: string;
  itemNameSnapshot: string;
  itemQualifiedNameSnapshot: string;
  family: ItemFamily;
  quantity: number;
  value: number | null;
}

export interface SalesOrderFulfilmentLine {
  id: string;
  salesOrderId: string;
  parentFulfilmentLineId: string | null;
  family: Exclude<ItemFamily, "UNKNOWN">;
  itemId: number;
  itemTallyGuid: string;
  itemName: string;
  itemQualifiedName: string;
  quantity: number;
  consumptionMode: FulfilmentConsumptionMode;
  stage: string;
  holdStatus: HoldStatus;
  serviceDone: boolean;
  resaleSupplierId: number | null;
  resaleSupplierName: string;
  notes: string;
  stageHistory: SalesOrderStageHistory[];
  createdAt: string;
  updatedAt: string;
}

export type ApprovalEntityType = "SALES_ORDER_PO" | "SALES_ORDER_CRF" | "SALES_ORDER_STAGE";
export type ApprovalRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "SUPERSEDED";

export interface ApprovalDecision {
  id: string;
  decidedByUserId: string;
  decidedByName: string;
  decidedByRole: string;
  decision: "APPROVE" | "REJECT";
  comment: string;
  decidedAt: string;
}

export interface ApprovalRequest {
  id: string;
  entityType: ApprovalEntityType;
  entityId: string;
  targetStage: string;
  status: ApprovalRequestStatus;
  payloadHash: string;
  createdByUserId: string;
  createdAt: string;
  decisions: ApprovalDecision[];
}

export interface SalesOrderWorkflowStage {
  id: string;
  orderKind: SalesOrderKind;
  stockGroupName: string;
  name: string;
  color: string;
  position: number;
  terminal: boolean;
  requiredPermissions: string[];
}

export type ChecklistRequirementStatus = "SATISFIED" | "WAIVED" | "UNSATISFIED";

export interface ChecklistResult {
  requirementId: string;
  targetType: string;
  targetValue: string;
  description: string;
  status: ChecklistRequirementStatus;
  waiverReason: string;
  waiverActorName: string;
  waiverRole: string;
  waiverAt: string;
}

export interface SalesOrder {
  id: string;
  orderKind: SalesOrderKind;
  tallyVoucherGuid: string;
  customerName: string;
  customerTallyGuid: string;
  poReference: string;
  poValue: number | null;
  voucherNumber: string;
  voucherDate: string;
  dueDate: string;
  ownerUserId: string;
  orderStage: SalesOrderStage;
  holdStatus: HoldStatus;
  sourceChanged: boolean;
  stageHistory: SalesOrderStageHistory[];
  sourceLines: SalesOrderSourceLine[];
  fulfilmentLines: SalesOrderFulfilmentLine[];
  approvalRequests: ApprovalRequest[];
  crfRevisions: Array<{ id: string; revisionNumber: number; createdAt: string; supersededAt: string | null }>;
  pendingSourceAmendment: SalesOrderSourceAmendment | null;
  createdAt: string;
  updatedAt: string;
}

export interface SalesOrderStageHistory {
  id: string;
  scope: "ORDER" | "FULFILMENT_LINE";
  scopeId: string;
  stageId: string;
  stageName: string;
  enteredAt: string;
  exitedAt: string | null;
  durationHours: number;
}

export interface SaveSalesOrderInput {
  id?: string;
  orderKind?: SalesOrderKind;
  customerName: string;
  customerTallyGuid?: string;
  poReference: string;
  poValue?: number | null;
  voucherNumber?: string;
  voucherDate?: string;
  dueDate?: string;
  ownerUserId?: string;
  sourceLines: Array<{
    itemTallyGuid: string;
    quantity: number;
    value?: number | null;
  }>;
}

export interface SaveSalesOrderWorkflowStageInput {
  id?: string;
  orderKind?: SalesOrderKind;
  stockGroupName?: string;
  name: string;
  color?: string;
  position?: number;
  terminal?: boolean;
  requiredPermissions?: string[];
}

export interface SalesOrderVoucherExportInput {
  salesOrderIds: string[];
  exportedBy?: string;
}

export interface SalesOrderVoucherExportResult {
  schemaVersion: string;
  batchId: string;
  excelPath: string;
  xmlPath: string;
  itemCount: number;
  warnings: string[];
}

export interface SaveSalesOrderFulfilmentLineInput {
  id?: string;
  salesOrderId: string;
  parentFulfilmentLineId?: string | null;
  itemTallyGuid: string;
  quantity: number;
  consumptionMode?: FulfilmentConsumptionMode;
  notes?: string;
}

export interface ChecklistTemplate {
  id: string;
  name: string;
  version: number;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  requirements: Array<{ id: string; targetType: string; targetValue: string; description: string }>;
  createdAt: string;
}

export interface CrfPayload {
  revisionNumber: number;
  generatedAt: string;
  order: {
    id: string;
    customerName: string;
    poReference: string;
    poValue: number | null;
    voucherNumber: string;
    voucherDate: string;
    orderStage: SalesOrderStage;
  };
  sourceLines: SalesOrderSourceLine[];
  fulfilmentLines: SalesOrderFulfilmentLine[];
  checklist: ChecklistResult[];
  approvalRequests: ApprovalRequest[];
}

export interface CrfRevision {
  id: string;
  salesOrderId: string;
  revisionNumber: number;
  payload: CrfPayload;
  payloadHash: string;
  createdAt: string;
  supersededAt: string | null;
}

export interface SalesOrderSourceAmendment {
  id: string;
  salesOrderId: string;
  newSourceLines: SalesOrderSourceLine[];
  diffSummary: string;
  detectedAt: string;
  applied: boolean;
  appliedAt: string | null;
}

export interface SaveChecklistTemplateInput {
  name: string;
  requirements: Array<{ targetType: string; targetValue: string; description: string }>;
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
  salesOrderWorkflowStages: SalesOrderWorkflowStage[];
  groups: string[];
  primaryGroups: string[];
  secondaryGroups: string[];
  salesOrders: SalesOrder[];
  checklistTemplates: ChecklistTemplate[];
}
