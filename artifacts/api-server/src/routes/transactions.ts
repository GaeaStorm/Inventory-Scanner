import { Router, type Request, type Response } from "express";
import * as XLSX from "xlsx";
import path from "path";
import fs from "fs";
import { CreateTransactionBodyZod } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router = Router();

export const EXCEL_PATH =
  process.env["EXCEL_PATH"] ||
  path.resolve(process.cwd(), "stock_transactions.xlsx");

interface StoredTransaction {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  type: "stock_in" | "stock_out";
  note?: string;
  timestamp: string;
}

const transactions: StoredTransaction[] = [];

function appendToExcel(tx: StoredTransaction): void {
  try {
    let wb: XLSX.WorkBook;

    if (fs.existsSync(EXCEL_PATH)) {
      wb = XLSX.readFile(EXCEL_PATH);
    } else {
      wb = XLSX.utils.book_new();
    }

    const sheetName = "Transactions";
    let ws = wb.Sheets[sheetName];
    let existingRows: Record<string, unknown>[] = [];

    if (ws) {
      existingRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
    }

    const newRow = {
      ID: tx.id,
      "Product ID": tx.productId,
      "Product Name": tx.productName,
      Quantity: tx.quantity,
      Type: tx.type === "stock_in" ? "Stock In" : "Stock Out",
      Note: tx.note ?? "",
      Timestamp: tx.timestamp,
    };

    existingRows.push(newRow);

    const newWs = XLSX.utils.json_to_sheet(existingRows);

    newWs["!cols"] = [
      { wch: 26 },
      { wch: 12 },
      { wch: 32 },
      { wch: 10 },
      { wch: 12 },
      { wch: 30 },
      { wch: 24 },
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
  const parse = CreateTransactionBodyZod.safeParse(req.body);

  if (!parse.success) {
    res.status(400).json({ error: "Invalid transaction data", details: parse.error.errors });
    return;
  }

  const body = parse.data;

  const tx: StoredTransaction = {
    id: `TXN-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
    productId: body.productId,
    productName: body.productName,
    quantity: body.quantity,
    type: body.type as "stock_in" | "stock_out",
    note: body.note,
    timestamp:
      body.timestamp instanceof Date
        ? body.timestamp.toISOString()
        : String(body.timestamp),
  };

  transactions.push(tx);
  appendToExcel(tx);

  res.status(201).json(tx);
});

export default router;
