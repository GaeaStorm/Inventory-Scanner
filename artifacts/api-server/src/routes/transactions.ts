import { Router, type Request, type Response } from "express";
import * as XLSX from "xlsx";
import path from "path";
import fs from "fs";
import { z } from "zod";
import { logger } from "../lib/logger";

const router = Router();

export const EXCEL_PATH =
  process.env["EXCEL_PATH"] ||
  path.resolve(process.cwd(), "stock_transactions.xlsx");

type MovementType = "Restock" | "Use" | "Adjustment";
type AdjustmentDirection = "in" | "out";

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

interface StoredTransaction {
  id: string;

  refNo: string;
  movementType: MovementType;

  itemCode: string;
  itemName: string;

  quantity: number;

  unitRate: string;

  godown: string;
  batchNo: string;

  usedIn: string;

  adjustmentDirection?: AdjustmentDirection;

  timestamp: string;
}

const transactions: StoredTransaction[] = [];

function getIstDateTime(timestamp: string): {
  date: string;
  timestampIst: string;
} {
  const d = new Date(timestamp);

  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";

  const day = get("day");
  const month = get("month");
  const year = get("year");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");

  return {
    date: `${day}/${month}/${year}`,
    timestampIst: `${day}/${month}/${year} ${hour}:${minute}:${second}`,
  };
}

function getInOutQty(tx: StoredTransaction): {
  inQty: number | "";
  outQty: number | "";
} {
  if (tx.movementType === "Restock") {
    return { inQty: tx.quantity, outQty: "" };
  }

  if (tx.movementType === "Use") {
    return { inQty: "", outQty: tx.quantity };
  }

  if (tx.adjustmentDirection === "out") {
    return { inQty: "", outQty: tx.quantity };
  }

  return { inQty: tx.quantity, outQty: "" };
}

function appendToExcel(tx: StoredTransaction): void {
  try {
    let wb: XLSX.WorkBook;

    if (fs.existsSync(EXCEL_PATH)) {
      wb = XLSX.readFile(EXCEL_PATH);
    } else {
      wb = XLSX.utils.book_new();
    }

    const sheetName = "Transactions";
    const ws = wb.Sheets[sheetName];

    let existingRows: Record<string, unknown>[] = [];

    if (ws) {
      existingRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
    }

    const { date, timestampIst } = getIstDateTime(tx.timestamp);
    const { inQty, outQty } = getInOutQty(tx);

    const newRow = {
      Date: date,
      "Timestamp in IST": timestampIst,
      "Ref No": tx.refNo,
      "Movement Type": tx.movementType,
      "Item Code": tx.itemCode,
      "Item Name": tx.itemName,
      "In Qty": inQty,
      "Out Qty": outQty,
      "Unit Rate": tx.unitRate,
      Godown: tx.godown,
      "Batch No": tx.batchNo,
      "Used In": tx.usedIn,
    };

    existingRows.push(newRow);

    const newWs = XLSX.utils.json_to_sheet(existingRows, {
      header: [
        "Date",
        "Timestamp in IST",
        "Ref No",
        "Movement Type",
        "Item Code",
        "Item Name",
        "In Qty",
        "Out Qty",
        "Unit Rate",
        "Godown",
        "Batch No",
        "Used In",
      ],
    });

    newWs["!cols"] = [
      { wch: 12 },
      { wch: 22 },
      { wch: 18 },
      { wch: 16 },
      { wch: 18 },
      { wch: 32 },
      { wch: 10 },
      { wch: 10 },
      { wch: 14 },
      { wch: 20 },
      { wch: 22 },
      { wch: 30 },
    ];

    if (wb.Sheets[sheetName]) {
      delete wb.Sheets[sheetName];
      wb.SheetNames = wb.SheetNames.filter((n) => n !== sheetName);
    }

    XLSX.utils.book_append_sheet(wb, newWs, sheetName);
    XLSX.writeFile(wb, EXCEL_PATH);

    logger.info({ id: tx.id, path: EXCEL_PATH }, "Transaction written to Excel");
  } catch (err) {
    logger.error({ err }, "Failed to write Excel file");
  }
}

router.get("/transactions", (_req: Request, res: Response) => {
  res.json(transactions);
});

router.post("/transactions", (req: Request, res: Response) => {
  const parse = MovementBodyZod.safeParse(req.body);

  if (!parse.success) {
    res.status(400).json({
      error: "Invalid transaction data",
      details: parse.error.errors,
    });
    return;
  }

  const body = parse.data;

  if (body.movementType === "Adjustment" && !body.adjustmentDirection) {
    res.status(400).json({
      error: "Adjustment requires adjustmentDirection",
    });
    return;
  }

  const tx: StoredTransaction = {
    id: `TXN-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)
      .toUpperCase()}`,

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

  transactions.push(tx);
  appendToExcel(tx);

  res.status(201).json(tx);
});

export default router;
