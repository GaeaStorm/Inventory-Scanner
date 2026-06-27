import { Router, type NextFunction, type Request, type Response } from "express";

import { DatabaseBusyError } from "../database/application-database";
import type { OperationsService } from "../operations/service";
import type { PlanningService } from "./service";

function tokenFrom(request: Request): string {
  const header = request.header("x-inventory-session") ?? request.header("authorization") ?? "";
  return header.replace(/^Bearer\s+/i, "").trim();
}

function computerNameFrom(request: Request): string {
  return (request.header("x-inventory-computer-name") ?? "").trim();
}

export function createPlanningRouter(service: PlanningService, operations: OperationsService): Router {
  const router = Router();
  const actor = (request: Request, permission?: Parameters<OperationsService["requireActor"]>[1]) =>
    operations.requireActor(tokenFrom(request), permission, computerNameFrom(request));

  router.get("/state", (request, response) => response.json(service.getState(actor(request, "RESTOCK_VIEW"))));
  router.post("/restock-policies", (request, response) => response.json(service.saveRestockPolicy(request.body, actor(request, "RESTOCK_MANAGE"))));
  router.post("/recommendations/decision", (request, response) => response.json(service.decideRecommendation(request.body, actor(request, "RESTOCK_MANAGE"))));
  router.post("/boms", (request, response) => response.status(201).json(service.saveBom(request.body, actor(request, "BOM_MANAGE"))));
  router.post("/boms/:bomId/activate", (request, response) => response.json(service.activateBom(request.params.bomId, actor(request, "BOM_MANAGE"))));
  router.post("/product-orders", (request, response) => response.status(201).json(service.saveProductOrder(request.body, actor(request, "PRODUCT_ORDER_MANAGE"))));
  router.post("/sales-orders", (request, response) => response.status(201).json(service.saveSalesOrder(request.body, actor(request, "SALES_ORDER_EDIT_CRF"))));
  router.post("/product-orders/bulk-update", (request, response) => response.json(
    service.bulkUpdateProductOrders(request.body, actor(request, "PRODUCT_ORDER_MANAGE")),
  ));
  router.post("/product-orders/:orderId/status", (request, response) => response.json(
    service.updateProductOrderStatus(request.params.orderId, request.body.status, actor(request, "PRODUCT_ORDER_MANAGE")),
  ));
  router.post("/product-orders/:orderId/workflow-state", (request, response) => response.json(
    service.updateProductOrderWorkflowState(request.params.orderId, request.body.workflowStateId, actor(request, "PRODUCT_ORDER_MANAGE")),
  ));
  router.post("/product-order-workflow-states", (request, response) => response.status(201).json(
    service.saveProductOrderWorkflowState(request.body, actor(request, "PRODUCT_ORDER_MANAGE")),
  ));
  router.post("/sales-order-workflow-stages", (request, response) => response.status(201).json(
    service.saveSalesOrderWorkflowStage(request.body, actor(request, "SALES_ORDER_CHECKLIST_CONFIGURE")),
  ));
  router.delete("/sales-order-workflow-stages/:orderKind/:stageId", (request, response) => response.json(
    service.deleteSalesOrderWorkflowStage({
      id: request.params.stageId,
      orderKind: request.params.orderKind as "SALES" | "SERVICE",
      stockGroupName: String(request.query.stockGroupName ?? ""),
    }, actor(request, "SALES_ORDER_CHECKLIST_CONFIGURE")),
  ));
  router.delete("/product-order-workflow-states/:stateId", (request, response) => response.json(
    service.deleteProductOrderWorkflowState(request.params.stateId, actor(request, "PRODUCT_ORDER_MANAGE")),
  ));
  router.post("/product-order-fields", (request, response) => response.status(201).json(
    service.saveProductOrderFieldDefinition(request.body, actor(request, "PRODUCT_ORDER_MANAGE")),
  ));
  router.delete("/product-order-fields/:fieldId", (request, response) => response.json(
    service.deleteProductOrderFieldDefinition(request.params.fieldId, actor(request, "PRODUCT_ORDER_MANAGE")),
  ));
  router.post("/export", (request, response) => response.json(service.exportRestock(request.body, actor(request, "RESTOCK_MANAGE"))));
  router.post("/sales-orders/export-vouchers", (request, response) => response.json(
    service.exportSalesOrderVouchers(request.body, actor(request, "TALLY_REVIEW")),
  ));

  router.post("/sales-orders/fulfilment-lines", (request, response) => response.status(201).json(
    service.addSalesOrderFulfilmentLine(request.body, actor(request, "SALES_ORDER_EDIT_CRF")),
  ));
  router.post("/sales-orders/fulfilment-lines/:fulfilmentLineId/stage", (request, response) => response.json(
    service.advanceFulfilmentLineStage(request.params.fulfilmentLineId, request.body.stage, actor(request, "SALES_ORDER_LINE_PROGRESS")),
  ));
  router.post("/sales-orders/fulfilment-lines/:fulfilmentLineId/supplier", (request, response) => response.json(
    service.assignResaleSupplier(request.params.fulfilmentLineId, Number(request.body.supplierId), actor(request, "SALES_ORDER_EDIT_CRF")),
  ));
  router.post("/sales-orders/fulfilment-lines/:fulfilmentLineId/service-done", (request, response) => response.json(
    service.setFulfilmentLineServiceDone(request.params.fulfilmentLineId, Boolean(request.body.done), actor(request, "SALES_ORDER_LINE_PROGRESS")),
  ));
  router.post("/sales-orders/:orderId/stage", (request, response) => response.json(
    service.advanceSalesOrderStage(request.params.orderId, request.body.stage, actor(request, "SALES_ORDER_EDIT_CRF")),
  ));
  router.post("/sales-orders/:orderId/request-po-approval", (request, response) => response.json(
    service.requestPoApproval(request.params.orderId, actor(request, "SALES_ORDER_APPROVE_PO")),
  ));
  router.post("/sales-orders/:orderId/due-date", (request, response) => response.json(
    service.setSalesOrderDueDate(request.params.orderId, request.body.dueDate ?? "", actor(request, "SALES_ORDER_EDIT_CRF")),
  ));
  router.post("/sales-orders/:orderId/hold-status", (request, response) => response.json(
    service.setSalesOrderHoldStatus(request.params.orderId, request.body.holdStatus, actor(request, "SALES_ORDER_EDIT_CRF")),
  ));
  router.post("/sales-orders/fulfilment-lines/:fulfilmentLineId/hold-status", (request, response) => response.json(
    service.setFulfilmentLineHoldStatus(request.params.fulfilmentLineId, request.body.holdStatus, actor(request, "SALES_ORDER_LINE_PROGRESS")),
  ));
  router.post("/sales-orders/:orderId/submit-crf", (request, response) => response.json(
    service.submitCrfForApproval(request.params.orderId, actor(request, "SALES_ORDER_SUBMIT_CRF")),
  ));
  router.post("/approval-requests/:requestId/decisions", (request, response) => response.json(
    service.decideApproval(request.params.requestId, request.body.decision, request.body.comment ?? "", actor(request)),
  ));
  router.post("/checklist-templates", (request, response) => response.status(201).json(
    service.saveChecklistTemplate(request.body, actor(request, "SALES_ORDER_CHECKLIST_CONFIGURE")),
  ));
  router.post("/sales-orders/:orderId/checklist/:requirementId/waive", (request, response) => response.json(
    service.waiveChecklistRequirement(request.params.orderId, request.params.requirementId, request.body.reason ?? "", actor(request, "SALES_ORDER_CHECKLIST_WAIVE")),
  ));
  router.get("/sales-orders/:orderId/checklist", (request, response) => response.json(
    service.getChecklistResultsForOrder(request.params.orderId, actor(request, "SALES_ORDER_VIEW")),
  ));
  router.get("/crf-revisions/:revisionId/html", (request, response) => {
    response.type("html").send(service.getCrfHtml(request.params.revisionId, actor(request, "SALES_ORDER_PRINT_CRF")));
  });
  router.post("/sales-orders/source-amendments/:amendmentId/apply", (request, response) => response.json(
    service.applySourceAmendment(request.params.amendmentId, actor(request, "SALES_ORDER_APPROVE_PO")),
  ));
  router.post("/sales-orders/:orderId/request-crf-reapproval", (request, response) => response.json(
    service.requestCrfReapproval(request.params.orderId, actor(request, "SALES_ORDER_SUBMIT_CRF")),
  ));

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof DatabaseBusyError) {
      response.setHeader("Retry-After", String(error.retryAfterSeconds));
      response.status(503).json({ error: error.message, retryable: true });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    response.status(/sign in|permission/i.test(message) ? 401 : 400).json({ error: message, retryable: false });
  });

  return router;
}
