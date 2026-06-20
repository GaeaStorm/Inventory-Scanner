import { Router, type NextFunction, type Request, type Response } from "express";

import { DatabaseBusyError } from "../database/application-database";
import type { Permission } from "./types";
import type { OperationsService } from "./service";

function tokenFrom(request: Request): string {
  const header = request.header("x-inventory-session") ?? request.header("authorization") ?? "";
  return header.replace(/^Bearer\s+/i, "").trim();
}

export function createOperationsRouter(service: OperationsService): Router {
  const router = Router();
  const actor = (request: Request, permission?: Permission) => service.requireActor(tokenFrom(request), permission);

  router.get("/auth/state", (request, response) => response.json(service.authState(tokenFrom(request))));
  router.post("/auth/bootstrap", (request, response) => response.status(201).json(service.bootstrapAdmin(request.body)));
  router.post("/auth/login", (request, response) => response.json(service.login(request.body)));
  router.post("/auth/resume", (request, response) => response.json(service.resume(String(request.body?.token ?? tokenFrom(request)))));
  router.post("/auth/logout", (request, response) => {
    service.logout(tokenFrom(request));
    response.status(204).end();
  });

  router.get("/state", (request, response) => response.json(service.getState(actor(request, "INVENTORY_VIEW"))));
  router.post("/users", (request, response) => response.json(service.saveUser(request.body, actor(request, "AUTH_MANAGE_USERS"))));
  router.post("/users/reset-credential", (request, response) => {
    service.resetCredential(request.body, actor(request, "AUTH_MANAGE_USERS"));
    response.status(204).end();
  });

  router.post("/conditions/transition", (request, response) => response.status(201).json(service.transitionCondition(request.body, actor(request))));
  router.post("/faults", (request, response) => response.status(201).json(service.createFault(request.body, actor(request, "MARK_FAULTY"))));
  router.post("/faults/resolve", (request, response) => response.json(service.resolveFault(request.body, actor(request))));
  router.post("/counts", (request, response) => response.status(201).json(service.createCountSession(request.body, actor(request, "STOCK_COUNT"))));
  router.post("/counts/entries", (request, response) => response.status(201).json(service.recordCountEntry(request.body, actor(request, "STOCK_COUNT"))));
  router.post("/counts/finalize", (request, response) => response.json(service.finalizeCount(request.body, actor(request, "STOCK_ADJUST"))));
  router.post("/returns/production", (request, response) => response.status(201).json(service.productionReturn(request.body, actor(request, "PRODUCTION_RETURN"))));
  router.post("/returns/supplier", (request, response) => response.status(201).json(service.supplierReturn(request.body, actor(request, "SUPPLIER_RETURN"))));
  router.patch("/returns/supplier", (request, response) => response.json(service.updateSupplierReturn(request.body, actor(request, "PURCHASING_MANAGE"))));
  router.post("/returns/customer/initiate", (request, response) => response.status(201).json(service.initiateCustomerReturn(request.body, actor(request, "CUSTOMER_RETURN_INITIATE"))));
  router.post("/returns/customer/receive", (request, response) => response.status(201).json(service.receiveCustomerReturn(request.body, actor(request, "CUSTOMER_RETURN_RECEIVE"))));
  router.post("/scrap", (request, response) => response.status(201).json(service.scrap(request.body, actor(request, "SCRAP_STOCK"))));
  router.post("/production/release", (request, response) => response.status(201).json(service.releaseProductOrder(request.body, actor(request, "PRODUCTION_EXECUTE"))));
  router.post("/production/issue", (request, response) => response.status(201).json(service.issueProductionMaterial(request.body, actor(request, "PRODUCTION_EXECUTE"))));
  router.post("/production/complete", (request, response) => response.status(201).json(service.productionCompletion(request.body, actor(request, "PRODUCTION_EXECUTE"))));
  router.post("/production/status", (request, response) => response.json(service.setProductOrderExecutionStatus(request.body, actor(request, "PRODUCTION_EXECUTE"))));
  router.post("/sync-exceptions/resolve", (request, response) => response.json(service.resolveSyncException(request.body, actor(request, "SYNC_EXCEPTION_RESOLVE"))));
  router.post("/movements/reverse", (request, response) => response.status(201).json(service.reverseMovement(request.body, actor(request, "TRANSACTION_REVERSE"))));
  router.post("/tally-reviews", (request, response) => response.json(service.reviewManualTally(request.body, actor(request, "TALLY_REVIEW"))));

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
