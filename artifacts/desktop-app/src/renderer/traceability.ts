import type { ConditionBalance } from "../operations/types";

export interface TraceabilityColumnVisibility {
  batch: boolean;
  serial: boolean;
  expiry: boolean;
  supplierLot: boolean;
}

export function traceabilityColumns(rows: ConditionBalance[]): TraceabilityColumnVisibility {
  return {
    batch: rows.some((row) => Boolean(row.batchNumber)),
    serial: rows.some((row) => row.serialNumbers.length > 0),
    expiry: rows.some((row) => Boolean(row.expiryDate)),
    supplierLot: rows.some((row) => Boolean(row.supplierLotReference)),
  };
}
