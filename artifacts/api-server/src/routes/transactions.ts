import { randomUUID } from "node:crypto";

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { logger } from "../lib/logger";
import {
  appendTransactionToWorkbook,
  getWorkbookPath,
  type StoredTransaction,
} from "../lib/workbook";

const router = Router();

const MovementBodyZod = z.object({
  refNo: z.string().min(1),
  movementType: z.enum(["Restock", "Use", "Adjustment"]),
  itemCode: z.string().min(1),
  itemName: z.string().min(1),
  quantity: z.number().positive(),
  unitRate: z.union([z.string(), z.number()]).transform(String),
  godown: z.string().min(1),
  batchNo: z.string().min(1),
  usedIn: z.string().min(1),
  adjustmentDirection: z.enum(["in", "out"]).optional(),
  timestamp: z.coerce.date(),
});

const transactions: StoredTransaction[] = [];

router.get("/transactions", (_req: Request, res: Response) => {
  res.json(transactions);
});

router.post("/transactions", (req: Request, res: Response) => {
  const parsed = MovementBodyZod.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid transaction data",
      details: parsed.error.errors,
    });
    return;
  }

  const body = parsed.data;

  if (body.movementType === "Adjustment" && !body.adjustmentDirection) {
    res.status(400).json({
      error: "Adjustment requires adjustmentDirection",
    });
    return;
  }

  const transaction: StoredTransaction = {
    id: `TXN-${randomUUID()}`,
    refNo: body.refNo,
    movementType: body.movementType,
    itemCode: body.itemCode,
    itemName: body.itemName,
    quantity: body.quantity,
    unitRate: body.unitRate,
    godown: body.godown,
    batchNo: body.batchNo,
    usedIn: body.usedIn,
    adjustmentDirection: body.adjustmentDirection,
    timestamp: body.timestamp.toISOString(),
  };

  try {
    appendTransactionToWorkbook(transaction);
    transactions.push(transaction);
    res.status(201).json(transaction);
  } catch (error) {
    logger.error(
      {
        err: error,
        path: getWorkbookPath(),
      },
      "Failed to save transaction",
    );

    res.status(500).json({
      error: "The transaction could not be saved",
    });
  }
});

export default router;
