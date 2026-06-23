import type { StoresStockItem } from "./types";

export function isOperationalStockItem(item: StoresStockItem): boolean {
  return !item.ignored
    && item.catalogStatus !== "DUPLICATE"
    && (item.catalogStatus !== "OBSOLETE" || item.localAvailableQuantity > 0);
}

export function operationalStockItems(items: StoresStockItem[]): StoresStockItem[] {
  return items.filter(isOperationalStockItem);
}

export function finishedProductItems(items: StoresStockItem[]): StoresStockItem[] {
  return operationalStockItems(items).filter((item) => item.isProduct);
}

export function materialStockItems(items: StoresStockItem[]): StoresStockItem[] {
  return operationalStockItems(items).filter((item) => !item.isProduct);
}
