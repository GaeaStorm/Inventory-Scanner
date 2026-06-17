export interface DesktopInfo {
  appVersion: string;
  apiBaseUrl: string;
  dataDirectory: string;
  excelPath: string;
  port: number;
  scannerUrls: string[];
}

export interface Product {
  id: string;
  name: string;
  unit: string;
}

export type MovementType = "Restock" | "Use" | "Adjustment";
export type AdjustmentDirection = "in" | "out";

export interface InventoryTransaction {
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

export interface CreateTransactionInput {
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
