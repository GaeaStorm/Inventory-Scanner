import type { ApplicationDatabase } from "../database/application-database";
import type { StoresService } from "../stores/service";
import type { ActorContext, Permission } from "../operations/types";
import type { TallySalesOrder } from "../tally/types";
import { requirePermission } from "../operations/permissions";
import { PlanningDatabase } from "./database";
import { PlanningExporter } from "./exporter";
import { buildCrfHtml } from "./crf-document";
import type {
  BulkProductOrderUpdateInput,
  PlanningExportInput,
  RecommendationDecisionInput,
  RestockPolicyInput,
  SalesOrderStage,
  SaveBomInput,
  SaveProductOrderFieldDefinitionInput,
  SaveProductOrderInput,
  SaveProductOrderWorkflowStateInput,
  SaveSalesOrderFulfilmentLineInput,
} from "./types";

export class PlanningService {
  readonly database: PlanningDatabase;
  readonly exporter: PlanningExporter;

  constructor(
    databaseHost: ApplicationDatabase,
    stores: StoresService,
  ) {
    this.database = new PlanningDatabase(
      databaseHost,
      () => { stores.backup("before-planning-migration"); },
    );
    this.exporter = new PlanningExporter(this.database, stores.database);
  }

  getState(actor?: ActorContext) {
    if (actor) requirePermission(actor, "RESTOCK_VIEW");
    return this.database.getState();
  }

  resetForCatalogReplacement(actor?: ActorContext) {
    if (actor) requirePermission(actor, "CATALOG_MANAGE");
    this.database.resetForCatalogReplacement();
  }

  saveRestockPolicy(input: RestockPolicyInput, actor: ActorContext) {
    requirePermission(actor, "RESTOCK_MANAGE");
    this.database.saveRestockPolicy(input);
    return this.getState();
  }

  decideRecommendation(input: RecommendationDecisionInput, actor: ActorContext) {
    requirePermission(actor, "RESTOCK_MANAGE");
    this.database.decideRecommendation(input);
    return this.getState();
  }

  saveBom(input: SaveBomInput, actor: ActorContext) {
    requirePermission(actor, "BOM_MANAGE");
    this.database.saveBom(input);
    return this.getState();
  }

  activateBom(bomId: string, actor: ActorContext) {
    requirePermission(actor, "BOM_MANAGE");
    this.database.activateBom(bomId);
    return this.getState();
  }

  saveProductOrder(input: SaveProductOrderInput, actor: ActorContext) {
    requirePermission(actor, "PRODUCT_ORDER_MANAGE");
    this.database.saveProductOrder(input, actor);
    return this.getState();
  }

  updateProductOrderStatus(orderId: string, status: "CANCELLED" | "COMPLETED" | "CONFIRMED" | "ON_HOLD", actor: ActorContext) {
    requirePermission(actor, "PRODUCT_ORDER_MANAGE");
    this.database.updateProductOrderStatus(orderId, status, actor);
    return this.getState();
  }

  updateProductOrderWorkflowState(orderId: string, workflowStateId: string, actor: ActorContext) {
    requirePermission(actor, "PRODUCT_ORDER_MANAGE");
    this.database.updateProductOrderWorkflowState(orderId, workflowStateId, actor);
    return this.getState();
  }

  bulkUpdateProductOrders(input: BulkProductOrderUpdateInput, actor: ActorContext) {
    requirePermission(actor, "PRODUCT_ORDER_MANAGE");
    this.database.bulkUpdateProductOrders(input, actor);
    return this.getState();
  }

  importTallySalesOrders(orders: TallySalesOrder[], actor: ActorContext) {
    requirePermission(actor, "TALLY_REVIEW");
    const lines = orders.flatMap((order) => order.lines
      .filter((line) => line.quantity != null && line.quantity > 0)
      .map((line) => ({
        tallyGuid: order.guid,
        voucherNumber: order.voucherNumber,
        voucherDate: order.voucherDate,
        customerName: order.customerName,
        reference: order.reference,
        productTallyGuid: line.itemGuid,
        productName: line.itemName,
        quantity: line.quantity!,
        value: line.value,
      })));
    return this.database.importTallySalesOrders(lines, actor);
  }

  /** Populates the new Sales Order aggregate alongside the legacy flat import above — neither replaces the other yet. */
  importTallySalesOrderAggregates(orders: TallySalesOrder[], actor: ActorContext) {
    requirePermission(actor, "TALLY_REVIEW");
    return this.database.importTallySalesOrderAggregates(orders, actor);
  }

  saveProductOrderWorkflowState(input: SaveProductOrderWorkflowStateInput, actor: ActorContext) {
    requirePermission(actor, "PRODUCT_ORDER_MANAGE");
    this.database.saveProductOrderWorkflowState(input);
    return this.getState();
  }

  deleteProductOrderWorkflowState(stateId: string, actor: ActorContext) {
    requirePermission(actor, "PRODUCT_ORDER_MANAGE");
    this.database.deleteProductOrderWorkflowState(stateId);
    return this.getState();
  }

  saveProductOrderFieldDefinition(input: SaveProductOrderFieldDefinitionInput, actor: ActorContext) {
    requirePermission(actor, "PRODUCT_ORDER_MANAGE");
    this.database.saveProductOrderFieldDefinition(input);
    return this.getState();
  }

  deleteProductOrderFieldDefinition(fieldId: string, actor: ActorContext) {
    requirePermission(actor, "PRODUCT_ORDER_MANAGE");
    this.database.deleteProductOrderFieldDefinition(fieldId);
    return this.getState();
  }

  exportRestock(input: PlanningExportInput, actor: ActorContext) {
    requirePermission(actor, "RESTOCK_MANAGE");
    return this.exporter.generate(input);
  }

  addSalesOrderFulfilmentLine(input: SaveSalesOrderFulfilmentLineInput, actor: ActorContext) {
    requirePermission(actor, "SALES_ORDER_EDIT_CRF");
    this.database.addSalesOrderFulfilmentLine(input, actor);
    return this.getState();
  }

  advanceFulfilmentLineStage(fulfilmentLineId: string, targetStage: string, actor: ActorContext) {
    requirePermission(actor, "SALES_ORDER_LINE_PROGRESS");
    this.database.advanceFulfilmentLineStage(fulfilmentLineId, targetStage, actor);
    return this.getState();
  }

  assignResaleSupplier(fulfilmentLineId: string, supplierId: number, actor: ActorContext) {
    requirePermission(actor, "SALES_ORDER_EDIT_CRF");
    this.database.assignResaleSupplier(fulfilmentLineId, supplierId, actor);
    return this.getState();
  }

  setFulfilmentLineServiceDone(fulfilmentLineId: string, done: boolean, actor: ActorContext) {
    requirePermission(actor, "SALES_ORDER_LINE_PROGRESS");
    this.database.setFulfilmentLineServiceDone(fulfilmentLineId, done, actor);
    return this.getState();
  }

  setSalesOrderDueDate(salesOrderId: string, dueDate: string, actor: ActorContext) {
    requirePermission(actor, "SALES_ORDER_EDIT_CRF");
    this.database.setSalesOrderDueDate(salesOrderId, dueDate, actor);
    return this.getState();
  }

  setSalesOrderHoldStatus(salesOrderId: string, holdStatus: "NONE" | "ON_HOLD" | "CANCELLED", actor: ActorContext) {
    requirePermission(actor, "SALES_ORDER_EDIT_CRF");
    this.database.setSalesOrderHoldStatus(salesOrderId, holdStatus, actor);
    return this.getState();
  }

  setFulfilmentLineHoldStatus(fulfilmentLineId: string, holdStatus: "NONE" | "ON_HOLD" | "CANCELLED", actor: ActorContext) {
    requirePermission(actor, "SALES_ORDER_LINE_PROGRESS");
    this.database.setFulfilmentLineHoldStatus(fulfilmentLineId, holdStatus, actor);
    return this.getState();
  }

  requestPoApproval(salesOrderId: string, actor: ActorContext) {
    requirePermission(actor, "SALES_ORDER_APPROVE_PO");
    this.database.requestPoApproval(salesOrderId, actor);
    return this.getState();
  }

  submitCrfForApproval(salesOrderId: string, actor: ActorContext) {
    requirePermission(actor, "SALES_ORDER_SUBMIT_CRF");
    this.database.resolveChecklistForOrder(salesOrderId, actor);
    this.database.submitCrfForApproval(salesOrderId, actor);
    return this.getState();
  }

  /**
   * Coarse gate only — actor must hold at least one approval-deciding
   * permission. The database layer enforces the exact role required for
   * this specific request's entity type (PO vs CRF), since that depends on
   * data only it has loaded.
   */
  decideApproval(requestId: string, decision: "APPROVE" | "REJECT", comment: string, actor: ActorContext) {
    const hasAnyApprovalPermission = ["SALES_ORDER_APPROVE_PO", "SALES_ORDER_APPROVE_CRF_ACCOUNTS", "SALES_ORDER_APPROVE_CRF_SALES"]
      .some((permission) => actor.permissions?.includes(permission as Permission));
    if (!hasAnyApprovalPermission) {
      throw new Error(`${actor.role} does not have permission to perform this operation.`);
    }
    this.database.decideApproval(requestId, decision, comment, actor);
    return this.getState();
  }

  saveChecklistTemplate(input: Parameters<PlanningDatabase["saveChecklistTemplate"]>[0], actor: ActorContext) {
    requirePermission(actor, "SALES_ORDER_CHECKLIST_CONFIGURE");
    this.database.saveChecklistTemplate(input, actor);
    return this.getState();
  }

  waiveChecklistRequirement(salesOrderId: string, requirementId: string, reason: string, actor: ActorContext) {
    requirePermission(actor, "SALES_ORDER_CHECKLIST_WAIVE");
    this.database.waiveChecklistRequirement(salesOrderId, requirementId, reason, actor);
    return this.getState();
  }

  getChecklistResultsForOrder(salesOrderId: string, actor: ActorContext) {
    requirePermission(actor, "SALES_ORDER_VIEW");
    return this.database.getChecklistResultsForOrder(salesOrderId);
  }

  advanceSalesOrderStage(orderId: string, targetStage: SalesOrderStage, actor: ActorContext) {
    requirePermission(actor, "SALES_ORDER_EDIT_CRF");
    this.database.advanceSalesOrderStage(orderId, targetStage, actor);
    return this.getState();
  }

  getCrfHtml(revisionId: string, actor: ActorContext): string {
    requirePermission(actor, "SALES_ORDER_PRINT_CRF");
    const revision = this.database.getCrfRevision(revisionId);
    return buildCrfHtml(revision.payload);
  }

  applySourceAmendment(amendmentId: string, actor: ActorContext) {
    requirePermission(actor, "SALES_ORDER_APPROVE_PO");
    this.database.applySourceAmendment(amendmentId, actor);
    return this.getState();
  }

  requestCrfReapproval(salesOrderId: string, actor: ActorContext) {
    requirePermission(actor, "SALES_ORDER_SUBMIT_CRF");
    this.database.requestCrfReapproval(salesOrderId, actor);
    return this.getState();
  }
}
