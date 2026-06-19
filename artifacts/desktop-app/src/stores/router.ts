import { Router, type NextFunction, type Request, type Response } from "express";

import { DatabaseBusyError } from "../database/application-database";
import { StoresService } from "./service";

export function createStoresRouter(service: StoresService): Router {
  const router = Router();

  router.get("/state", (_request, response) => {
    response.json(service.getState());
  });

  router.post("/catalog/local-items", (request, response) => {
    response.status(201).json(service.createLocalStockItem(request.body));
  });

  router.get("/catalog", (_request, response) => {
    const state = service.getState();
    response.json({
      stockItems: state.stockItems,
      destinations: [...state.stockItems].sort((left, right) => {
        if (left.hasBom !== right.hasBom) return left.hasBom ? -1 : 1;
        return left.name.localeCompare(right.name);
      }),
      cacheVersion: `${state.companyGuid}:${state.sync.syncedAt ?? "local"}`,
    });
  });

  router.get("/boxes/:boxId", (request, response) => {
    const box = service.getBox(request.params.boxId);
    if (!box) {
      response.status(404).json({ error: "Box not found in the Local Stores Database." });
      return;
    }
    response.json(box);
  });

  router.post("/boxes", (request, response) => {
    response.status(201).json(service.saveBox(request.body));
  });

  router.delete("/boxes/:boxId", (request, response) => {
    const expectedRevision = request.query.revision == null ? undefined : Number(request.query.revision);
    response.json(service.deleteBox(request.params.boxId, expectedRevision));
  });

  router.post("/vendor-receipts", (request, response) => {
    response.status(201).json(service.vendorReceipt(request.body));
  });

  router.post("/vendor-receipts/bulk", (request, response) => {
    response.status(201).json(service.bulkVendorReceipt(request.body));
  });

  router.post("/material-out", (request, response) => {
    response.status(201).json(service.materialOut(request.body));
  });

  router.post("/offline-batch", (request, response) => {
    response.json(service.processOfflineBatch(request.body));
  });

  router.post("/opening-quantity", (request, response) => {
    response.json(service.setOpeningQuantity(request.body));
  });

  router.get("/adjustment-context", (request, response) => {
    const context = service.adjustmentContext(
      String(request.query.tallyItemGuid ?? ""),
      String(request.query.destinationTallyItemGuid ?? ""),
      String(request.query.eventDate ?? ""),
    );
    if (!context) {
      response.status(404).json({
        error: "No matching same-day Material Out exists for this item and destination.",
      });
      return;
    }
    response.json(context);
  });

  router.post("/adjustments", (request, response) => {
    response.status(201).json(service.adjustment(request.body));
  });

  // Backward compatibility for older scanner builds and previously printed workflow docs.
  router.post("/return-unused", (request, response) => {
    response.status(201).json(service.adjustment({
      ...request.body,
      direction: "RETURN_TO_STOCK",
      reason: "UNUSED_MATERIAL",
    }));
  });

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof DatabaseBusyError) {
      response.setHeader("Retry-After", String(error.retryAfterSeconds));
      response.status(503).json({
        error: error.message,
        retryable: true,
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    response.status(400).json({ error: message, retryable: false });
  });

  return router;
}
