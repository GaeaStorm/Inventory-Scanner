import { Router, type NextFunction, type Request, type Response } from "express";

import { DatabaseBusyError } from "../database/application-database";
import type { PlanningService } from "./service";

export function createPlanningRouter(service: PlanningService): Router {
  const router = Router();

  router.get("/state", (_request, response) => response.json(service.getState()));
  router.post("/restock-policies", (request, response) => response.json(service.saveRestockPolicy(request.body)));
  router.post("/recommendations/decision", (request, response) => response.json(service.decideRecommendation(request.body)));
  router.post("/boms", (request, response) => response.status(201).json(service.saveBom(request.body)));
  router.post("/boms/:bomId/activate", (request, response) => response.json(service.activateBom(request.params.bomId)));
  router.post("/product-orders", (request, response) => response.status(201).json(service.saveProductOrder(request.body)));
  router.post("/product-orders/:orderId/status", (request, response) => response.json(
    service.updateProductOrderStatus(request.params.orderId, request.body.status),
  ));

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof DatabaseBusyError) {
      response.setHeader("Retry-After", String(error.retryAfterSeconds));
      response.status(503).json({ error: error.message, retryable: true });
      return;
    }
    response.status(400).json({
      error: error instanceof Error ? error.message : String(error),
      retryable: false,
    });
  });

  return router;
}
