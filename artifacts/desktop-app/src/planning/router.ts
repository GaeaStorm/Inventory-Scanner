import { Router, type NextFunction, type Request, type Response } from "express";

import { DatabaseBusyError } from "../database/application-database";
import type { OperationsService } from "../operations/service";
import type { PlanningService } from "./service";

function tokenFrom(request: Request): string {
  const header = request.header("x-inventory-session") ?? request.header("authorization") ?? "";
  return header.replace(/^Bearer\s+/i, "").trim();
}

export function createPlanningRouter(service: PlanningService, operations: OperationsService): Router {
  const router = Router();
  const actor = (request: Request, permission?: Parameters<OperationsService["requireActor"]>[1]) =>
    operations.requireActor(tokenFrom(request), permission);

  router.get("/state", (request, response) => response.json(service.getState(actor(request, "RESTOCK_VIEW"))));
  router.post("/restock-policies", (request, response) => response.json(service.saveRestockPolicy(request.body, actor(request, "RESTOCK_MANAGE"))));
  router.post("/recommendations/decision", (request, response) => response.json(service.decideRecommendation(request.body, actor(request, "RESTOCK_MANAGE"))));
  router.post("/boms", (request, response) => response.status(201).json(service.saveBom(request.body, actor(request, "BOM_MANAGE"))));
  router.post("/boms/:bomId/activate", (request, response) => response.json(service.activateBom(request.params.bomId, actor(request, "BOM_MANAGE"))));
  router.post("/product-orders", (request, response) => response.status(201).json(service.saveProductOrder(request.body, actor(request, "PRODUCT_ORDER_MANAGE"))));
  router.post("/product-orders/:orderId/status", (request, response) => response.json(
    service.updateProductOrderStatus(request.params.orderId, request.body.status, actor(request, "PRODUCT_ORDER_MANAGE")),
  ));
  router.post("/product-orders/:orderId/workflow-state", (request, response) => response.json(
    service.updateProductOrderWorkflowState(request.params.orderId, request.body.workflowStateId, actor(request, "PRODUCT_ORDER_MANAGE")),
  ));
  router.post("/product-order-workflow-states", (request, response) => response.status(201).json(
    service.saveProductOrderWorkflowState(request.body, actor(request, "PRODUCT_ORDER_MANAGE")),
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
