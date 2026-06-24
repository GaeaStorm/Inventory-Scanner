import { createHash } from "node:crypto";

import { XMLParser } from "fast-xml-parser";

import type {
  TallyBomComponent,
  TallyCompany,
  TallyConnectionResult,
  TallyConnectionSettings,
  TallyGrn,
  TallyNamedMaster,
  TallyPurchaseOrder,
  TallySalesOrder,
  TallyStockItem,
  TallyStoresSnapshot,
  TallySupplier,
  TallyVoucherInventoryLine,
  TallyVoucherType,
} from "./types";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

const STOCK_ITEM_METHODS = [
  "Name",
  "Parent",
  "Description",
  "OpeningBalance",
  "ClosingBalance",
  "OpeningValue",
  "ClosingValue",
  "StandardCost",
  "StandardPrice",
  "MailingName",
  "GUID",
  "AlterID",
  "CategoryAllocations.*",
  "ComponentList.*",
  "MultiComponentList.*",
] as const;

const VOUCHER_METHODS = [
  "Date",
  "EffectiveDate",
  "VoucherTypeName",
  "VoucherNumber",
  "GUID",
  "MasterID",
  "AlterID",
  "VoucherKey",
  "PartyLedgerName",
  "Reference",
  "ReferenceDate",
  "TrackingNumber",
  "BasicOrderRef",
  "BasicPurchaseOrderNo",
  "BasicShippingNo",
  "BasicShipDocumentNo",
  "BasicShipDocumentDate",
  "PartyDeliveryOrderNo",
  "DispatchDocNo",
  "Narration",
  "IsInvoice",
  "PersistedView",
  "AllInventoryEntries.*",
  "InventoryEntries.*",
  "OrderDetails.*",
  "OrderAllocations.*",
  "BatchAllocations.*",
  "AccountingAllocations.*",
] as const;

const VOUCHER_TYPE_METHODS = [
  "Name",
  "Parent",
  "ReservedName",
  "GUID",
  "AlterID",
] as const;

type XmlRecord = Record<string, unknown>;

function isRecord(value: unknown): value is XmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeKey(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value).trim();
  }
  if (isRecord(value) && "#text" in value) return scalar(value["#text"]);
  return "";
}

function directField(record: unknown, names: readonly string[]): string {
  if (!isRecord(record)) return "";
  const desired = new Set(names.map(normalizeKey));
  for (const [key, value] of Object.entries(record)) {
    if (desired.has(normalizeKey(key))) {
      const result = scalar(value);
      if (result) return result;
    }
  }
  return "";
}

function nestedField(record: unknown, names: readonly string[]): string {
  const direct = directField(record, names);
  if (direct) return direct;
  if (Array.isArray(record)) {
    for (const value of record) {
      const result = nestedField(value, names);
      if (result) return result;
    }
    return "";
  }
  if (isRecord(record)) {
    for (const value of Object.values(record)) {
      const result = nestedField(value, names);
      if (result) return result;
    }
  }
  return "";
}

function findTaggedNodes(root: unknown, tagName: string): unknown[] {
  const target = normalizeKey(tagName);
  const results: unknown[] = [];

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!isRecord(value)) return;

    for (const [key, child] of Object.entries(value)) {
      if (normalizeKey(key) === target) results.push(...toArray(child));
      visit(child);
    }
  }

  visit(root);
  return results;
}

function findRecordsContaining(root: unknown, fieldName: string): XmlRecord[] {
  const target = normalizeKey(fieldName);
  const results: XmlRecord[] = [];

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!isRecord(value)) return;

    if (Object.keys(value).some((key) => normalizeKey(key) === target)) {
      results.push(value);
    }
    for (const child of Object.values(value)) visit(child);
  }

  visit(root);
  return results;
}

function collectScalars(root: unknown, tagName: string): string[] {
  return findTaggedNodes(root, tagName).map(scalar).filter(Boolean);
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function parseTallyNumber(value: string): number | null {
  const normalized = value
    .replaceAll(",", "")
    .replace(/[A-Za-z₹$€£]+/g, " ")
    .trim();
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const result = Number(match[0]);
  return Number.isFinite(result) ? result : null;
}

function positiveNumber(value: string): number | null {
  const parsed = parseTallyNumber(value);
  return parsed === null ? null : Math.abs(parsed);
}

function normalizeTallyDate(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 8) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toISOString().slice(0, 10);
}

function stableItemCode(name: string, guid: string): string {
  const hash = createHash("sha1")
    .update(guid || name)
    .digest("hex")
    .slice(0, 10)
    .toUpperCase();
  return `TLY-${hash}`;
}

export function normalizeTallySettings(value: unknown): TallyConnectionSettings {
  const input = isRecord(value) ? value : {};
  const host = scalar(input.host).trim() || "localhost";
  const port = Number(input.port ?? 9000);
  const timeoutMs = Number(input.timeoutMs ?? 15_000);
  const company = scalar(input.company).trim();
  const historyFrom = scalar(input.historyFrom).trim() || "2000-01-01";
  const fullVoucherHistory = input.fullVoucherHistory !== false;

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Tally port must be between 1 and 65535.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 2_000 || timeoutMs > 60_000) {
    throw new Error("Tally timeout must be between 2 and 60 seconds.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(historyFrom)) {
    throw new Error("History start date must use YYYY-MM-DD.");
  }

  let parsed: URL;
  try {
    parsed = new URL(host.includes("://") ? host : `http://${host}`);
  } catch {
    throw new Error("Enter a valid Tally computer name or IP address.");
  }

  if (parsed.protocol !== "http:") {
    throw new Error("Tally's local XML server must use an HTTP address.");
  }
  if (parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("Enter only the Tally computer address, without a path or credentials.");
  }

  return {
    host: parsed.hostname,
    port,
    company,
    timeoutMs: Math.trunc(timeoutMs),
    historyFrom,
    fullVoucherHistory,
  };
}

function endpointFor(settings: TallyConnectionSettings): string {
  const host = settings.host.includes(":") ? `[${settings.host}]` : settings.host;
  return `http://${host}:${settings.port}`;
}

interface CollectionRequestOptions {
  company?: string;
  childOf?: string;
  belongsTo?: boolean;
  filterFormula?: string;
  fromDate?: string;
  toDate?: string;
}

function tallyDate(value: string): string {
  return value.replaceAll("-", "");
}

function buildCollectionRequest(
  collectionName: string,
  objectType: string,
  methods: readonly string[],
  options: CollectionRequestOptions,
): string {
  const companyVariable = options.company
    ? `<SVCURRENTCOMPANY>${escapeXml(options.company)}</SVCURRENTCOMPANY>`
    : "";
  const fromDate = options.fromDate
    ? `<SVFROMDATE TYPE="Date">${tallyDate(options.fromDate)}</SVFROMDATE>`
    : "";
  const toDate = options.toDate
    ? `<SVTODATE TYPE="Date">${tallyDate(options.toDate)}</SVTODATE>`
    : "";
  const nativeMethods = methods
    .map((method) => `<NATIVEMETHOD>${escapeXml(method)}</NATIVEMETHOD>`)
    .join("");
  const childOf = options.childOf
    ? `<CHILDOF>${escapeXml(options.childOf)}</CHILDOF>`
    : "";
  const belongsTo = options.belongsTo ? "<BELONGSTO>Yes</BELONGSTO>" : "";
  const filterName = options.filterFormula ? `${collectionName} Filter` : "";
  const filter = filterName ? `<FILTER>${escapeXml(filterName)}</FILTER>` : "";
  const formula = options.filterFormula
    ? `<SYSTEM TYPE="Formulae" NAME="${escapeXml(filterName)}">${escapeXml(options.filterFormula)}</SYSTEM>`
    : "";

  return `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>EXPORT</TALLYREQUEST>
    <TYPE>COLLECTION</TYPE>
    <ID>${escapeXml(collectionName)}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        ${companyVariable}
        ${fromDate}
        ${toDate}
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="${escapeXml(collectionName)}" ISMODIFY="No" ISINITIALIZE="Yes">
            <TYPE>${escapeXml(objectType)}</TYPE>
            ${childOf}
            ${belongsTo}
            ${filter}
            ${nativeMethods}
          </COLLECTION>
          ${formula}
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

async function postXml(
  settings: TallyConnectionSettings,
  xml: string,
): Promise<{ parsed: unknown; endpoint: string }> {
  const endpoint = endpointFor(settings);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "text/xml, application/xml",
        "Content-Type": "text/xml; charset=utf-8",
      },
      body: xml,
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Tally returned HTTP ${response.status}: ${text.slice(0, 240)}`);
    }
    if (!text.trim()) throw new Error("Tally returned an empty response.");

    let parsed: unknown;
    try {
      parsed = parser.parse(text) as unknown;
    } catch (error) {
      throw new Error(
        `Tally returned XML that could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const status = collectScalars(parsed, "STATUS")[0];
    const lineError =
      collectScalars(parsed, "LINEERROR")[0] ||
      collectScalars(parsed, "ERROR")[0] ||
      collectScalars(parsed, "MESSAGE")[0];
    if (status === "0" || lineError) {
      throw new Error(lineError || "Tally rejected the export request.");
    }

    return { parsed, endpoint };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(`Timed out while connecting to Tally at ${endpoint}.`);
    }
    if (error instanceof TypeError) {
      throw new Error(
        `Could not connect to Tally at ${endpoint}. Confirm that TallyPrime is open, its HTTP server is enabled, and the firewall allows port ${settings.port}.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCollection(
  settings: TallyConnectionSettings,
  collectionName: string,
  objectType: string,
  methods: readonly string[],
  options: CollectionRequestOptions = {},
): Promise<unknown[]> {
  const request = buildCollectionRequest(collectionName, objectType, methods, {
    company: options.company ?? settings.company,
    ...options,
  });
  const { parsed } = await postXml(settings, request);
  return findTaggedNodes(parsed, objectType);
}

function mapCompanies(nodes: unknown[]): TallyCompany[] {
  return uniqueBy(
    nodes
      .map((node) => ({
        name: directField(node, ["Name"]),
        guid: directField(node, ["GUID"]),
        booksFrom: normalizeTallyDate(directField(node, ["BooksFrom"])),
        startingFrom: normalizeTallyDate(directField(node, ["StartingFrom"])),
        endingAt: normalizeTallyDate(directField(node, ["EndingAt"])),
      }))
      .filter((company) => company.name),
    (company) => company.guid || company.name.toLocaleLowerCase(),
  ).sort((left, right) => left.name.localeCompare(right.name));
}

function mapNamedMasters(nodes: unknown[]): TallyNamedMaster[] {
  return uniqueBy(
    nodes
      .map((node) => ({
        name: directField(node, ["Name"]),
        parent: directField(node, ["Parent"]),
        guid: directField(node, ["GUID"]),
        alterId: directField(node, ["AlterID"]),
      }))
      .filter((master) => master.name),
    (master) => master.guid || master.name.toLocaleLowerCase(),
  ).sort((left, right) => left.name.localeCompare(right.name));
}

function mapVoucherTypes(nodes: unknown[]): TallyVoucherType[] {
  return uniqueBy(
    nodes
      .map((node) => ({
        name: directField(node, ["Name"]),
        parent: directField(node, ["Parent"]),
        reservedName: directField(node, ["ReservedName"]),
        guid: directField(node, ["GUID"]),
        alterId: directField(node, ["AlterID"]),
      }))
      .filter((voucherType) => voucherType.name),
    (voucherType) => voucherType.guid || voucherType.name.toLocaleLowerCase(),
  ).sort((left, right) => left.name.localeCompare(right.name));
}

type StoresVoucherKind = "PURCHASE_ORDER" | "SALES_ORDER" | "RECEIPT_NOTE" | "PURCHASE" | null;

function voucherTypeKind(
  voucherTypeName: string,
  voucherTypes: TallyVoucherType[],
): StoresVoucherKind {
  const byName = new Map(
    voucherTypes.map((voucherType) => [voucherType.name.toLocaleLowerCase(), voucherType]),
  );
  const candidates: string[] = [];
  let current = voucherTypeName;
  const visited = new Set<string>();

  for (let depth = 0; current && depth < 12; depth += 1) {
    const key = current.toLocaleLowerCase();
    if (visited.has(key)) break;
    visited.add(key);
    candidates.push(current);
    const type = byName.get(key);
    if (!type) break;
    if (type.reservedName) candidates.push(type.reservedName);
    current = type.parent;
  }

  const normalized = candidates.map(normalizeKey);
  if (normalized.some((value) => value.includes("PURCHASEORDER"))) return "PURCHASE_ORDER";
  if (normalized.some((value) => value.includes("SALESORDER"))) return "SALES_ORDER";
  if (normalized.some((value) => value.includes("RECEIPTNOTE") || value === "GRN" || value.includes("GOODSRECEIPT"))) {
    return "RECEIPT_NOTE";
  }
  if (normalized.some((value) => value === "PURCHASE" || value.startsWith("PURCHASEVOUCHER"))) return "PURCHASE";
  return null;
}

interface DateChunk {
  fromDate: string;
  toDate: string;
}

function historyDateChunks(fromDate: string, toDate: string): DateChunk[] {
  const start = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || start > end) return [];
  const chunks: DateChunk[] = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCFullYear(chunkEnd.getUTCFullYear() + 1);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({
      fromDate: cursor.toISOString().slice(0, 10),
      toDate: chunkEnd.toISOString().slice(0, 10),
    });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

function voucherTypeName(node: unknown): string {
  return directField(node, ["VoucherTypeName"]);
}

function voucherIdentity(node: unknown): string {
  const guid = directField(node, ["GUID"]);
  if (guid) return guid;
  return [
    normalizeTallyDate(directField(node, ["Date", "EffectiveDate"])),
    voucherTypeName(node),
    directField(node, ["VoucherNumber"]),
    directField(node, ["MasterID"]),
  ].join("\u0000");
}

function mapStockItems(nodes: unknown[]): TallyStockItem[] {
  return uniqueBy(
    nodes
      .map((node) => {
        const name = directField(node, ["Name"]);
        const guid = directField(node, ["GUID"]);
        const openingBalance = directField(node, ["OpeningBalance"]);
        const closingBalance = directField(node, ["ClosingBalance"]);
        const openingValue = directField(node, ["OpeningValue"]);
        const closingValue = directField(node, ["ClosingValue"]);
        const hasBom =
          findTaggedNodes(node, "ComponentList").length > 0 ||
          findTaggedNodes(node, "MultiComponentList").length > 0 ||
          JSON.stringify(node).toUpperCase().includes("COMPONENTLIST");

        return {
          code: stableItemCode(name, guid),
          name,
          guid,
          alterId: directField(node, ["AlterID"]),
          parent: directField(node, ["Parent"]),
          category: nestedField(node, ["Category", "CategoryName"]),
          partNumber: nestedField(node, ["MailingName", "PartNo"]),
          description: directField(node, ["Description"]),
          openingBalance,
          closingBalance,
          openingQuantity: positiveNumber(openingBalance),
          closingQuantity: positiveNumber(closingBalance),
          openingValue,
          closingValue,
          openingValueNumber: parseTallyNumber(openingValue),
          closingValueNumber: parseTallyNumber(closingValue),
          standardCost: directField(node, ["StandardCost"]),
          standardPrice: directField(node, ["StandardPrice"]),
          hasBom,
        } satisfies TallyStockItem;
      })
      .filter((item) => item.name),
    (item) => item.guid || item.name.toLocaleLowerCase(),
  ).sort((left, right) => left.name.localeCompare(right.name));
}

function mapBomComponents(
  stockItemNodes: unknown[],
  items: TallyStockItem[],
): TallyBomComponent[] {
  const itemByName = new Map(items.map((item) => [item.name.toLocaleLowerCase(), item]));
  const components: TallyBomComponent[] = [];

  for (const node of stockItemNodes) {
    const productName = directField(node, ["Name"]);
    const product = itemByName.get(productName.toLocaleLowerCase());
    if (!product) continue;
    const resolvedProduct = product;

    function visit(value: unknown, active: boolean, bomName: string): void {
      if (Array.isArray(value)) {
        for (const entry of value) visit(entry, active, bomName);
        return;
      }
      if (!isRecord(value)) return;

      const componentName = directField(value, [
        "StockItemName",
        "NameOfItem",
        "ComponentItemName",
      ]);
      if (active && componentName && componentName !== resolvedProduct.name) {
        const component = itemByName.get(componentName.toLocaleLowerCase());
        const quantity = directField(value, ["ActualQty", "BasicQty", "Quantity"]);
        components.push({
          productCode: resolvedProduct.code,
          productName: resolvedProduct.name,
          productGuid: resolvedProduct.guid,
          bomName: bomName || "Default",
          componentCode: component?.code ?? stableItemCode(componentName, ""),
          componentName,
          componentGuid: component?.guid ?? "",
          quantity,
          quantityNumber: positiveNumber(quantity),
        });
      }

      for (const [key, child] of Object.entries(value)) {
        const normalized = normalizeKey(key);
        const nextActive = active || normalized.includes("COMPONENTLIST") || normalized.includes("BOM");
        const possibleName = directField(child, ["Name", "BomName"]);
        visit(child, nextActive, possibleName && possibleName !== resolvedProduct.name ? possibleName : bomName);
      }
    }

    visit(node, false, "");
  }

  return uniqueBy(
    components,
    (component) =>
      `${component.productGuid || component.productName}\u0000${component.bomName}\u0000${component.componentGuid || component.componentName}`.toLocaleLowerCase(),
  );
}

function mapSuppliers(nodes: unknown[]): TallySupplier[] {
  return uniqueBy(
    nodes
      .map((node) => ({
        name: directField(node, ["Name"]),
        guid: directField(node, ["GUID"]),
        alterId: directField(node, ["AlterID"]),
        parent: directField(node, ["Parent"]),
      }))
      .filter((supplier) => supplier.name),
    (supplier) => supplier.guid || supplier.name.toLocaleLowerCase(),
  ).sort((left, right) => left.name.localeCompare(right.name));
}

function mapInventoryLines(
  voucherNode: unknown,
  itemByName: Map<string, TallyStockItem>,
): TallyVoucherInventoryLine[] {
  return uniqueBy(
    findRecordsContaining(voucherNode, "StockItemName")
    .map((record) => {
      const itemName = directField(record, ["StockItemName"]);
      const item = itemByName.get(itemName.toLocaleLowerCase());
      const quantityText = directField(record, ["ActualQty", "BilledQty", "Quantity"]);
      const rateText = directField(record, ["Rate"]);
      const valueText = directField(record, ["Amount", "Value"]);
      return {
        itemName,
        itemGuid: item?.guid ?? "",
        quantity: positiveNumber(quantityText),
        rate: positiveNumber(rateText),
        value: positiveNumber(valueText),
        orderNumber: nestedField(record, ["OrderNo", "OrderNumber", "BasicOrderRef"]),
        trackingNumber: nestedField(record, ["TrackingNumber", "TrackingNo"]),
      } satisfies TallyVoucherInventoryLine;
    })
    .filter((line) => line.itemName && line.quantity !== null),
    (line) => [line.itemGuid || line.itemName, line.quantity, line.rate, line.value, line.orderNumber, line.trackingNumber].join("\u0000"),
  );
}

function mapPurchaseOrders(
  nodes: unknown[],
  stockItems: TallyStockItem[],
  suppliers: TallySupplier[],
): TallyPurchaseOrder[] {
  const itemByName = new Map(stockItems.map((item) => [item.name.toLocaleLowerCase(), item]));
  const supplierByName = new Map(suppliers.map((supplier) => [supplier.name.toLocaleLowerCase(), supplier]));
  return uniqueBy(
    nodes
      .map((node) => {
        const supplierName = nestedField(node, ["PartyLedgerName"]);
        const supplier = supplierByName.get(supplierName.toLocaleLowerCase());
        return {
          guid: directField(node, ["GUID"]),
          voucherNumber: directField(node, ["VoucherNumber"]),
          voucherDate: normalizeTallyDate(directField(node, ["Date", "EffectiveDate"])),
          supplierName,
          supplierGuid: supplier?.guid ?? "",
          reference: directField(node, ["Reference", "BasicOrderRef"]),
          lines: mapInventoryLines(node, itemByName),
        } satisfies TallyPurchaseOrder;
      })
      .filter((order) => order.voucherNumber || order.guid),
    (order) => order.guid || `${order.voucherDate}\u0000${order.voucherNumber}`,
  );
}

function mapSalesOrders(
  nodes: unknown[],
  stockItems: TallyStockItem[],
): TallySalesOrder[] {
  const itemByName = new Map(stockItems.map((item) => [item.name.toLocaleLowerCase(), item]));
  return uniqueBy(
    nodes.map((node) => ({
      guid: directField(node, ["GUID"]),
      voucherNumber: directField(node, ["VoucherNumber"]),
      voucherDate: normalizeTallyDate(directField(node, ["Date", "EffectiveDate"])),
      customerName: nestedField(node, ["PartyLedgerName"]),
      reference: directField(node, ["Reference", "BasicOrderRef"]),
      lines: mapInventoryLines(node, itemByName),
    })).filter((order) => order.voucherNumber || order.guid),
    (order) => order.guid || `${order.voucherDate}\u0000${order.voucherNumber}`,
  );
}

function mapGrns(
  nodes: unknown[],
  stockItems: TallyStockItem[],
  suppliers: TallySupplier[],
): TallyGrn[] {
  const itemByName = new Map(stockItems.map((item) => [item.name.toLocaleLowerCase(), item]));
  const supplierByName = new Map(suppliers.map((supplier) => [supplier.name.toLocaleLowerCase(), supplier]));
  return uniqueBy(
    nodes
      .map((node) => {
        const supplierName = nestedField(node, ["PartyLedgerName"]);
        const supplier = supplierByName.get(supplierName.toLocaleLowerCase());
        const reference = directField(node, [
          "BasicShippingNo",
          "BasicShipDocumentNo",
          "PartyDeliveryOrderNo",
          "DispatchDocNo",
          "Reference",
        ]);
        const voucherDate = normalizeTallyDate(directField(node, ["Date", "EffectiveDate"]));
        return {
          guid: directField(node, ["GUID"]),
          voucherNumber: directField(node, ["VoucherNumber"]),
          voucherDate,
          supplierName,
          supplierGuid: supplier?.guid ?? "",
          poNumber: nestedField(node, ["BasicOrderRef", "BasicPurchaseOrderNo", "OrderNo", "OrderNumber"]),
          trackingNumber: nestedField(node, ["TrackingNumber", "TrackingNo"]),
          challanNumber: reference,
          challanDate: normalizeTallyDate(directField(node, ["BasicShipDocumentDate", "ReferenceDate"])) || voucherDate,
          lines: mapInventoryLines(node, itemByName),
        } satisfies TallyGrn;
      })
      .filter((grn) => grn.voucherNumber || grn.guid),
    (grn) => grn.guid || `${grn.voucherDate}\u0000${grn.voucherNumber}`,
  );
}

function mergePurchaseRates(grns: TallyGrn[], purchaseNodes: unknown[], stockItems: TallyStockItem[]): void {
  const itemByName = new Map(stockItems.map((item) => [item.name.toLocaleLowerCase(), item]));
  const candidates = purchaseNodes.flatMap((node) => {
    const supplierName = nestedField(node, ["PartyLedgerName"]);
    const voucherDate = normalizeTallyDate(directField(node, ["Date"]));
    const reference = directField(node, ["Reference", "BasicOrderRef"]);
    return mapInventoryLines(node, itemByName).map((line) => ({ supplierName, voucherDate, reference, line }));
  });

  for (const grn of grns) {
    for (const line of grn.lines) {
      if (line.rate !== null) continue;
      const match = candidates.find((candidate) =>
        candidate.supplierName.toLocaleLowerCase() === grn.supplierName.toLocaleLowerCase() &&
        candidate.line.itemName.toLocaleLowerCase() === line.itemName.toLocaleLowerCase() &&
        (!candidate.reference || !grn.poNumber || candidate.reference === grn.poNumber),
      );
      if (match) {
        line.rate = match.line.rate;
        line.value = match.line.value;
      }
    }
  }
}

export class TallyClient {
  async testConnection(value: unknown): Promise<TallyConnectionResult> {
    const settings = normalizeTallySettings(value);
    const startedAt = Date.now();
    const nodes = await fetchCollection(
      settings,
      "Inventory Scanner Companies",
      "Company",
      ["Name", "GUID", "BooksFrom", "StartingFrom", "EndingAt"],
      { company: "" },
    );
    const companies = mapCompanies(nodes);

    return {
      settings,
      endpoint: endpointFor(settings),
      latencyMs: Math.max(1, Date.now() - startedAt),
      companies,
      warning:
        companies.length === 0
          ? "Tally responded, but no loaded company was returned. Open the required company in TallyPrime and test again."
          : null,
    };
  }

  async syncStores(value: unknown): Promise<TallyStoresSnapshot> {
    const settings = normalizeTallySettings(value);
    const companyNodes = await fetchCollection(
      settings,
      "Inventory Scanner Companies",
      "Company",
      ["Name", "GUID", "BooksFrom", "StartingFrom", "EndingAt"],
      { company: "" },
    );
    const companies = mapCompanies(companyNodes);
    const selectedCompany = settings.company || companies[0]?.name || "";
    if (!selectedCompany) {
      throw new Error("No Tally company is loaded. Open the required company in TallyPrime, then try again.");
    }

    const selectedCompanyRecord = companies.find((company) => company.name === selectedCompany);
    const companySettings = { ...settings, company: selectedCompany };
    const warnings: string[] = [];

    async function optionalCollection(
      label: string,
      collectionName: string,
      objectType: string,
      methods: readonly string[],
      options: CollectionRequestOptions = {},
    ): Promise<unknown[]> {
      try {
        return await fetchCollection(companySettings, collectionName, objectType, methods, options);
      } catch (error) {
        warnings.push(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }

    const stockGroupNodes = await optionalCollection(
      "Stock groups",
      "Inventory Scanner Stock Groups",
      "StockGroup",
      ["Name", "Parent", "GUID", "AlterID"],
    );
    const stockCategoryNodes = await optionalCollection(
      "Stock categories",
      "Inventory Scanner Stock Categories",
      "StockCategory",
      ["Name", "Parent", "GUID", "AlterID"],
    );
    const stockItemNodes = await fetchCollection(
      companySettings,
      "Inventory Scanner Stock Items",
      "StockItem",
      STOCK_ITEM_METHODS,
    );
    const stockItems = mapStockItems(stockItemNodes);
    const bomComponents = mapBomComponents(stockItemNodes, stockItems);

    const supplierNodes = await optionalCollection(
      "Supplier ledgers",
      "Inventory Scanner Suppliers",
      "Ledger",
      ["Name", "Parent", "GUID", "AlterID"],
      { childOf: "Sundry Creditors", belongsTo: true },
    );
    const suppliers = mapSuppliers(supplierNodes);

    const voucherTypeNodes = await optionalCollection(
      "Voucher types",
      "Inventory Scanner Voucher Types",
      "VoucherType",
      VOUCHER_TYPE_METHODS,
    );
    const voucherTypes = mapVoucherTypes(voucherTypeNodes);

    const toDate = new Date().toISOString().slice(0, 10);
    const dateOptions = {
      fromDate: settings.historyFrom,
      toDate,
    };
    let purchaseOrderNodes: unknown[] = [];
    let salesOrderNodes: unknown[] = [];
    let grnNodes: unknown[] = [];
    let purchaseNodes: unknown[] = [];
    let historyScan: NonNullable<TallyStoresSnapshot["historyScan"]>;

    if (settings.fullVoucherHistory) {
      const chunks = historyDateChunks(settings.historyFrom, toDate);
      const allVoucherNodes: unknown[] = [];
      for (const [index, chunk] of chunks.entries()) {
        const nodes = await optionalCollection(
          `Voucher history ${chunk.fromDate} to ${chunk.toDate}`,
          `Inventory Scanner Voucher History ${index + 1}`,
          "Voucher",
          VOUCHER_METHODS,
          chunk,
        );
        allVoucherNodes.push(...nodes);
      }

      const vouchers = uniqueBy(allVoucherNodes, voucherIdentity);
      const inventoryVoucherTypeNames = new Set<string>();
      const purchaseOrderTypeNames = new Set<string>();
      const receiptNoteTypeNames = new Set<string>();
      const purchaseTypeNames = new Set<string>();
      let inventoryVouchersScanned = 0;

      for (const voucher of vouchers) {
        const typeName = voucherTypeName(voucher);
        const hasInventory = findRecordsContaining(voucher, "StockItemName").length > 0;
        if (hasInventory) {
          inventoryVouchersScanned += 1;
          if (typeName) inventoryVoucherTypeNames.add(typeName);
        }

        let kind = voucherTypeKind(typeName, voucherTypes);
        if (!kind) {
          const persistedView = normalizeKey(directField(voucher, ["PersistedView"]));
          if (persistedView.includes("RECEIPTNOTE")) kind = "RECEIPT_NOTE";
          else if (persistedView.includes("PURCHASEORDER")) kind = "PURCHASE_ORDER";
          else if (persistedView.includes("SALESORDER")) kind = "SALES_ORDER";
        }

        if (kind === "PURCHASE_ORDER") {
          purchaseOrderNodes.push(voucher);
          if (typeName) purchaseOrderTypeNames.add(typeName);
        } else if (kind === "SALES_ORDER") {
          salesOrderNodes.push(voucher);
        } else if (kind === "RECEIPT_NOTE") {
          grnNodes.push(voucher);
          if (typeName) receiptNoteTypeNames.add(typeName);
        } else if (kind === "PURCHASE") {
          purchaseNodes.push(voucher);
          if (typeName) purchaseTypeNames.add(typeName);
        }
      }

      historyScan = {
        fromDate: settings.historyFrom,
        toDate,
        dateChunks: chunks.length,
        vouchersScanned: vouchers.length,
        inventoryVouchersScanned,
        purchaseOrdersFound: purchaseOrderNodes.length,
        receiptNotesFound: grnNodes.length,
        purchaseVouchersFound: purchaseNodes.length,
        voucherTypesFound: voucherTypes.length,
        purchaseOrderTypeNames: [...purchaseOrderTypeNames].sort(),
        receiptNoteTypeNames: [...receiptNoteTypeNames].sort(),
        purchaseTypeNames: [...purchaseTypeNames].sort(),
        inventoryVoucherTypeNames: [...inventoryVoucherTypeNames].sort(),
      };

      if (vouchers.length === 0) {
        warnings.push(`The complete voucher-history scan returned no vouchers from ${settings.historyFrom} to ${toDate}. Check the company and history start date.`);
      } else if (grnNodes.length === 0) {
        const detected = historyScan.inventoryVoucherTypeNames.slice(0, 20).join(", ");
        warnings.push(`Scanned ${vouchers.length} vouchers but did not identify a Receipt Note/GRN voucher type.${detected ? ` Inventory voucher types seen: ${detected}.` : ""}`);
      }
    } else {
      purchaseOrderNodes = await optionalCollection(
        "Purchase Orders",
        "Inventory Scanner Purchase Orders",
        "Voucher",
        VOUCHER_METHODS,
        { ...dateOptions, filterFormula: '$VoucherTypeName = "Purchase Order"' },
      );
      salesOrderNodes = await optionalCollection(
        "Sales Orders",
        "Inventory Scanner Sales Orders",
        "Voucher",
        VOUCHER_METHODS,
        { ...dateOptions, filterFormula: '$VoucherTypeName = "Sales Order"' },
      );
      grnNodes = await optionalCollection(
        "Receipt Notes / GRNs",
        "Inventory Scanner Receipt Notes",
        "Voucher",
        VOUCHER_METHODS,
        { ...dateOptions, filterFormula: '$VoucherTypeName = "Receipt Note"' },
      );
      purchaseNodes = await optionalCollection(
        "Purchase vouchers used for rate history",
        "Inventory Scanner Purchases",
        "Voucher",
        VOUCHER_METHODS,
        { ...dateOptions, filterFormula: '$VoucherTypeName = "Purchase"' },
      );
      historyScan = {
        fromDate: settings.historyFrom,
        toDate,
        dateChunks: 1,
        vouchersScanned: purchaseOrderNodes.length + salesOrderNodes.length + grnNodes.length + purchaseNodes.length,
        inventoryVouchersScanned: purchaseOrderNodes.length + salesOrderNodes.length + grnNodes.length + purchaseNodes.length,
        purchaseOrdersFound: purchaseOrderNodes.length,
        receiptNotesFound: grnNodes.length,
        purchaseVouchersFound: purchaseNodes.length,
        voucherTypesFound: voucherTypes.length,
        purchaseOrderTypeNames: ["Purchase Order"],
        receiptNoteTypeNames: ["Receipt Note"],
        purchaseTypeNames: ["Purchase"],
        inventoryVoucherTypeNames: ["Purchase Order", "Sales Order", "Receipt Note", "Purchase"],
      };
    }

    const purchaseOrders = mapPurchaseOrders(purchaseOrderNodes, stockItems, suppliers);
    const salesOrders = mapSalesOrders(salesOrderNodes, stockItems);
    const grns = mapGrns(grnNodes, stockItems, suppliers);
    mergePurchaseRates(grns, purchaseNodes, stockItems);

    if (stockItems.length === 0) {
      warnings.push("No Tally Stock Items were returned. Confirm that inventory is enabled and that the selected company contains Stock Items.");
    }

    for (const item of stockItems) {
      if (item.closingQuantity !== null && !Number.isInteger(item.closingQuantity)) {
        warnings.push(`Stock Item ${item.name} has a non-whole closing quantity (${item.closingBalance}). The stores workflow only accepts whole counts.`);
      }
    }

    return {
      schemaVersion: 2,
      syncedAt: new Date().toISOString(),
      endpoint: endpointFor(companySettings),
      company: selectedCompany,
      companyGuid: selectedCompanyRecord?.guid ?? "",
      companies,
      stockGroups: mapNamedMasters(stockGroupNodes),
      stockCategories: mapNamedMasters(stockCategoryNodes),
      stockItems,
      bomComponents,
      suppliers,
      purchaseOrders,
      salesOrders,
      grns,
      voucherTypes,
      historyScan,
      warnings,
    };
  }
}
