import { Router, type NextFunction, type Request, type Response } from "express";

import { StoresService } from "./service";

function asyncHandler(
  handler: (request: Request, response: Response) => Promise<void> | void,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    Promise.resolve(handler(request, response)).catch(next);
  };
}

export function createStoresRouter(service: StoresService): Router {
  const router = Router();

  router.get("/state", (_request, response) => {
    response.json(service.getState());
  });

  router.get("/catalog", (_request, response) => {
    const state = service.getState();
    response.json({
      stockItems: state.stockItems,
      destinations: [...state.stockItems].sort((left, right) => {
        if (left.hasBom !== right.hasBom) return left.hasBom ? -1 : 1;
        return left.name.localeCompare(right.name);
      }),
      suppliers: state.suppliers,
      purchaseOrders: state.purchaseOrders,
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

  router.post("/vendor-receipts", (request, response) => {
    response.status(201).json(service.vendorReceipt(request.body));
  });

  router.post("/vendor-receipts/bulk", (request, response) => {
    response.status(201).json(service.bulkVendorReceipt(request.body));
  });

  router.post("/material-out", (request, response) => {
    response.status(201).json(service.materialOut(request.body));
  });

  router.post("/return-unused", (request, response) => {
    response.status(201).json(service.returnUnused(request.body));
  });

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    response.status(400).json({ error: message });
  });

  return router;
}
