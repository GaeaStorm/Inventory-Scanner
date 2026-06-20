import * as XLSX from "xlsx";

import type { StoresStockItem } from "./types";

export interface ParsedBomRow {
  rowNumber: number;
  productName: string;
  componentName: string;
  sourceComponentName: string;
  componentType: string;
  quantity: number;
  lossBufferPercent: number;
  productGuid: string;
  componentGuid: string;
  error: string;
}

export interface ParsedBomFile {
  sheetName: string;
  title: string;
  productName: string;
  versionNumber: number | null;
  rows: ParsedBomRow[];
  skippedNotFitted: number;
}

const PRODUCT_HEADERS = ["product", "product name", "finished product", "assembly"];
const COMPONENT_HEADERS = ["component", "component name", "material", "stock item"];
const QUANTITY_HEADERS = ["quantity", "qty", "quantity per product", "qty per product", "component quantity"];
const LOSS_HEADERS = ["loss buffer", "loss buffer percent", "loss percent", "wastage percent"];
const SERIAL_HEADERS = ["sr no", "serial no", "serial number", "s no"];
const TYPE_HEADERS = ["type", "component type", "mounting type"];
const NOT_FITTED = /^(?:dna|dnp|dnf|nc|n\/a|not fitted|do not assemble|do not fit|do not populate)$/i;

export function normalizeBomName(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[µμ]/g, "u")
    .replace(/×/g, "x")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function headerIndex(row: unknown[], aliases: string[]): number {
  return row.findIndex((value) => aliases.includes(normalizeHeader(value)));
}

function productionComponentKey(value: unknown): string {
  return String(value ?? "")
    .replace(/¼\s*w|�\s*w|1\s*[\/⁄]\s*4\s*w/gi, " watt ")
    .replace(/(?:±|�|\+\s*\/\s*-|\+\s*-)\s*(\d+(?:\.\d+)?)\s*%/gi, " tolerance $1 ")
    .normalize("NFKD")
    .replace(/[µμ]/g, "u")
    .replace(/×/g, "x")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function addCandidate(
  candidates: Map<string, Map<string, StoresStockItem>>,
  key: string,
  item: StoresStockItem,
): void {
  if (!key) return;
  const entries = candidates.get(key) ?? new Map<string, StoresStockItem>();
  entries.set(item.tallyGuid, item);
  candidates.set(key, entries);
}

function catalogMatcher(items: StoresStockItem[]): (name: string, componentType?: string) => StoresStockItem | null {
  const exactCandidates = new Map<string, Map<string, StoresStockItem>>();
  const productionCandidates = new Map<string, Map<string, StoresStockItem>>();
  for (const item of items) {
    for (const name of [item.name, item.tallyName]) {
      addCandidate(exactCandidates, normalizeBomName(name), item);
      addCandidate(productionCandidates, productionComponentKey(name), item);
    }
  }
  return (name: string, componentType = "") => {
    const possibleNames = componentType ? [`${name} ${componentType}`, name] : [name];
    for (const possibleName of possibleNames) {
      for (const [map, key] of [
        [exactCandidates, normalizeBomName(possibleName)],
        [productionCandidates, productionComponentKey(possibleName)],
      ] as const) {
        const matches = [...(map.get(key)?.values() ?? [])];
        if (matches.length === 1) return matches[0];
      }
    }
    return null;
  };
}

function cleanProductTitle(value: string): string {
  return value
    .replace(/\.(?:xlsx?|csv)$/i, "")
    .replace(/^\s*rfl[\s_-]*/i, "")
    .replace(/[\s_-]*ver(?:sion)?[\s._-]*\d+(?:\.\d+)?/i, "")
    .replace(/[\s_-]*bom\s*$/i, "")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function versionFrom(values: string[]): number | null {
  for (const value of values) {
    const match = /(?:^|[^a-z0-9])ver(?:sion)?[\s._-]*(\d+(?:\.\d+)?)/i.exec(value);
    if (!match) continue;
    const parsed = Number(match[1]);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  }
  return null;
}

function inferredProduct(
  rows: unknown[][],
  headerRowIndex: number,
  fileName: string,
  matchItem: (name: string) => StoresStockItem | null,
): { name: string; item: StoresStockItem | null } {
  const titleCandidates = rows
    .slice(0, headerRowIndex)
    .flatMap((row) => row.map((value) => String(value ?? "").trim()))
    .filter((value) => value && !/^(?:total\s+bom|job\s+work|in[-\s]?house\s+assembly)$/i.test(value));
  const candidates = [
    cleanProductTitle(fileName),
    ...titleCandidates.map(cleanProductTitle),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const item = matchItem(candidate);
    if (item) return { name: item.name, item };
  }
  return { name: candidates[0] ?? "", item: null };
}

function errorsFor(
  productName: string,
  componentName: string,
  quantity: number,
  loss: number,
  product: StoresStockItem | null,
  component: StoresStockItem | null,
): string {
  const errors: string[] = [];
  if (!productName || !product) errors.push("Product not matched");
  if (!componentName || !component) errors.push("Component not matched");
  if (!Number.isInteger(quantity) || quantity <= 0) errors.push("Quantity must be a positive whole number");
  if (!Number.isFinite(loss) || loss < 0 || loss > 100) errors.push("Loss buffer must be 0–100");
  return errors.join("; ");
}

export function parseBomWorkbook(
  workbook: XLSX.WorkBook,
  items: StoresStockItem[],
  fileName: string,
): ParsedBomFile {
  if (workbook.SheetNames.length === 0) throw new Error("The selected workbook has no worksheets.");
  const sheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === "total bom")
    ?? workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
    blankrows: true,
  });
  const headerRowIndex = rows.findIndex((row) =>
    headerIndex(row, COMPONENT_HEADERS) >= 0 && headerIndex(row, QUANTITY_HEADERS) >= 0
  );
  if (headerRowIndex < 0) {
    throw new Error("Could not find Component and Quantity/Qty columns in the BOM workbook.");
  }

  const headers = rows[headerRowIndex];
  const productColumn = headerIndex(headers, PRODUCT_HEADERS);
  const componentColumn = headerIndex(headers, COMPONENT_HEADERS);
  const quantityColumn = headerIndex(headers, QUANTITY_HEADERS);
  const lossColumn = headerIndex(headers, LOSS_HEADERS);
  const serialColumn = headerIndex(headers, SERIAL_HEADERS);
  const typeColumn = headerIndex(headers, TYPE_HEADERS);
  const matchItem = catalogMatcher(items);
  const inferred = inferredProduct(rows, headerRowIndex, fileName, matchItem);
  const titleValues = rows
    .slice(0, headerRowIndex)
    .flatMap((row) => row.map((value) => String(value ?? "").trim()))
    .filter(Boolean);
  const title = titleValues[0] || fileName.replace(/\.(?:xlsx?|csv)$/i, "");
  const parsed: ParsedBomRow[] = [];
  let skippedNotFitted = 0;

  for (let index = headerRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const componentName = String(row[componentColumn] ?? "").trim();
    const quantityText = String(row[quantityColumn] ?? "").trim();
    const serialText = serialColumn >= 0 ? String(row[serialColumn] ?? "").trim() : "";
    const componentType = typeColumn >= 0 ? String(row[typeColumn] ?? "").trim() : "";
    if (!componentName && !quantityText && !serialText) continue;
    if (NOT_FITTED.test(componentName)) {
      skippedNotFitted += 1;
      continue;
    }
    // Category labels such as RESISTORS and CAPACITORS have no serial number
    // and no quantity. Numbered rows with a missing quantity remain visible as
    // validation errors instead of disappearing silently.
    if (!serialText && !quantityText) continue;

    const productName = productColumn >= 0
      ? String(row[productColumn] ?? "").trim()
      : inferred.name;
    const quantity = Number(quantityText);
    const loss = Number(lossColumn >= 0 ? String(row[lossColumn] ?? "").trim() || 0 : 0);
    const product = productColumn >= 0 ? matchItem(productName) : inferred.item;
    const component = matchItem(componentName, componentType);
    parsed.push({
      rowNumber: index + 1,
      productName: product?.name ?? productName,
      componentName: component?.name ?? componentName,
      sourceComponentName: componentName,
      componentType,
      quantity,
      lossBufferPercent: loss,
      productGuid: product?.tallyGuid ?? "",
      componentGuid: component?.tallyGuid ?? "",
      error: errorsFor(productName, componentName, quantity, loss, product, component),
    });
  }

  const parsedProductNames = [...new Set(parsed.map((row) => row.productName).filter(Boolean))];
  return {
    sheetName,
    title,
    productName: productColumn >= 0
      ? parsedProductNames.length === 1
        ? parsedProductNames[0]
        : `${parsedProductNames.length} products`
      : inferred.item?.name ?? inferred.name,
    versionNumber: versionFrom([title, fileName]),
    rows: parsed,
    skippedNotFitted,
  };
}

export function matchBomCatalogItem(
  items: StoresStockItem[],
  name: string,
  componentType = "",
): StoresStockItem | null {
  return catalogMatcher(items)(name, componentType);
}
