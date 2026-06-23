import { Router, type NextFunction, type Request, type Response } from "express";

import { DatabaseBusyError } from "../database/application-database";
import type { OperationsService } from "../operations/service";
import type { StoresService } from "./service";

function tokenFrom(request: Request): string {
  const header = request.header("x-inventory-session") ?? request.header("authorization") ?? "";
  return header.replace(/^Bearer\s+/i, "").trim();
}

export function createStoresRouter(service: StoresService, operations: OperationsService): Router {
  const router = Router();
  const actor = (request: Request, permission?: Parameters<OperationsService["requireActor"]>[1]) =>
    operations.requireActor(tokenFrom(request), permission);
  const phoneActor = (request: Request) => operations.scannerActor(request.header("x-scanner-token") ?? "");

  router.get("/state", (request, response) => {
    actor(request, "INVENTORY_VIEW");
    response.json(service.getState());
  });

  router.post("/catalog/local-items", (request, response) => {
    response.status(201).json(service.createLocalStockItem(request.body, actor(request, "CATALOG_MANAGE")));
  });
  router.delete("/catalog/local-items/:tallyItemGuid", (request, response) => {
    response.json(service.deleteStockItem({ tallyItemGuid: request.params.tallyItemGuid }, actor(request, "CATALOG_MANAGE")));
  });
  router.post("/catalog/groups", (request, response) => {
    response.status(201).json(service.createCatalogGroup(request.body, actor(request, "CATALOG_MANAGE")));
  });
  router.delete("/catalog/groups/:name", (request, response) => {
    response.json(service.deleteCatalogGroup({ name: request.params.name }, actor(request, "CATALOG_MANAGE")));
  });
  router.post("/catalog/categories", (request, response) => {
    response.status(201).json(service.createStockCategory(request.body, actor(request, "CATALOG_MANAGE")));
  });
  router.delete("/catalog/categories/:name", (request, response) => {
    response.json(service.deleteStockCategory({ name: request.params.name }, actor(request, "CATALOG_MANAGE")));
  });
  router.post("/catalog/status", (request, response) => response.json(service.setCatalogStatus(request.body, actor(request, "CATALOG_MANAGE"))));
  router.post("/catalog/visibility", (request, response) => response.json(service.setCatalogVisibility(request.body, actor(request, "CATALOG_MANAGE"))));
  router.post("/catalog/rename", (request, response) => response.json(service.renameStockItem(request.body, actor(request, "CATALOG_MANAGE"))));
  router.post("/catalog/export-cleanup", (request, response) => response.json(service.exportCatalogCleanup(actor(request))));

  router.get("/catalog", (request, response) => {
    phoneActor(request);
    const state = service.getState();
    const selectable = state.stockItems.filter((item) =>
      !item.ignored
      && item.catalogStatus !== "DUPLICATE"
      && (item.catalogStatus !== "OBSOLETE"
        || item.localAvailableQuantity + item.localPendingInspectionQuantity + item.localFaultyQuantity > 0)
    );
    response.json({
      stockItems: selectable.filter((item) => !item.isProduct),
      destinations: selectable.filter((item) => item.isProduct).sort((left, right) => {
        if (left.hasBom !== right.hasBom) return left.hasBom ? -1 : 1;
        return left.name.localeCompare(right.name);
      }),
      cacheVersion: `${state.companyGuid}:${state.sync.syncedAt ?? "local"}`,
    });
  });

  router.get("/boxes/:boxId", (request, response) => {
    phoneActor(request);
    const box = service.getBox(request.params.boxId);
    if (!box) {
      response.status(404).json({ error: "Box not found in the Local Stores Database." });
      return;
    }
    response.json(box);
  });
  router.post("/boxes", (request, response) => response.status(201).json(service.saveBox(request.body, actor(request, "QR_MANAGE"))));
  router.delete("/boxes/:boxId", (request, response) => {
    const expectedRevision = request.query.revision == null ? undefined : Number(request.query.revision);
    response.json(service.deleteBox(request.params.boxId, expectedRevision, actor(request, "QR_MANAGE")));
  });

  router.post("/vendor-receipts", (request, response) => response.status(201).json(service.vendorReceipt(request.body, actor(request, "RECEIVE_MATERIAL"))));
  router.post("/vendor-receipts/bulk", (request, response) => response.status(201).json(service.bulkVendorReceipt(request.body, actor(request, "RECEIVE_MATERIAL"))));
  router.post("/material-out", (request, response) => response.status(201).json(service.materialOut(request.body, actor(request, "MATERIAL_ISSUE"))));
  router.post("/offline-batch", (request, response) => response.json(service.processOfflineBatch(request.body, phoneActor(request))));
  router.post("/opening-quantity", (request, response) => response.json(service.setOpeningQuantity(request.body, actor(request, "STOCK_ADJUST"))));

  router.get("/adjustment-context", (request, response) => {
    phoneActor(request);
    const context = service.adjustmentContext(
      String(request.query.tallyItemGuid ?? ""),
      String(request.query.destinationTallyItemGuid ?? ""),
      String(request.query.eventDate ?? ""),
    );
    if (!context) {
      response.status(404).json({ error: "No matching Material Out exists for this item and destination." });
      return;
    }
    response.json(context);
  });

  router.post("/adjustments", (request, response) => response.status(201).json(service.adjustment(request.body, actor(request))));
  router.post("/return-unused", (request, response) => response.status(201).json(service.adjustment({
    ...request.body,
    direction: "RETURN_TO_STOCK",
    reason: "UNUSED_MATERIAL",
  }, actor(request, "PRODUCTION_RETURN"))));

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof DatabaseBusyError) {
      response.setHeader("Retry-After", String(error.retryAfterSeconds));
      response.status(503).json({ error: error.message, retryable: true });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    response.status(/sign in|permission|not paired|revoked/i.test(message) ? 401 : 400).json({ error: message, retryable: false });
  });

  return router;
}
