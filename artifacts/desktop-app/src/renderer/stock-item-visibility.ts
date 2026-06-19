import type { StoresStockItem } from "./types";

export function isOperationalStockItem(item: StoresStockItem): boolean {
  return item.catalogStatus !== "DUPLICATE"
    && (item.catalogStatus !== "OBSOLETE" || item.localAvailableQuantity > 0);
}

export function operationalStockItems(items: StoresStockItem[]): StoresStockItem[] {
  return items.filter(isOperationalStockItem);
}
