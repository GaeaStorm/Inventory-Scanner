import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";

import type { StoresDatabase } from "../stores/database";
import { PlanningDatabase } from "./database";
import type {
  PlanningExportInput,
  PlanningExportResult,
  RestockPlanningItem,
  SalesOrder,
  SalesOrderVoucherExportInput,
  SalesOrderVoucherExportResult,
} from "./types";

const SCHEMA_VERSION = "3.0";

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "Schema Version\n3.0\n";
  const headers = Object.keys(rows[0]);
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n");
}

function xmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function tallyDate(value: string): string {
  const normalized = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date().toISOString().slice(0, 10);
  return normalized.replaceAll("-", "");
}

function voucherTypeFor(order: SalesOrder): string {
  return order.orderKind === "SERVICE" ? "Service Order Master" : "Sales Order Master";
}

function voucherXml(order: SalesOrder): string {
  const voucherType = voucherTypeFor(order);
  const lines = order.sourceLines.map((line) => {
    const amount = line.value ?? 0;
    const rate = amount && line.quantity ? amount / line.quantity : 0;
    return `
          <ALLINVENTORYENTRIES.LIST>
            <STOCKITEMNAME>${xmlEscape(line.itemNameSnapshot)}</STOCKITEMNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <ACTUALQTY>${line.quantity}</ACTUALQTY>
            <BILLEDQTY>${line.quantity}</BILLEDQTY>
            <RATE>${rate ? rate.toFixed(2) : ""}</RATE>
            <AMOUNT>${amount ? amount.toFixed(2) : ""}</AMOUNT>
          </ALLINVENTORYENTRIES.LIST>`;
  }).join("");
  return `
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${xmlEscape(voucherType)}" ACTION="Create" OBJVIEW="Invoice Voucher View">
            <DATE>${tallyDate(order.voucherDate)}</DATE>
            <EFFECTIVEDATE>${tallyDate(order.voucherDate)}</EFFECTIVEDATE>
            <VOUCHERTYPENAME>${xmlEscape(voucherType)}</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${xmlEscape(order.voucherNumber)}</VOUCHERNUMBER>
            <REFERENCE>${xmlEscape(order.poReference)}</REFERENCE>
            <PARTYNAME>${xmlEscape(order.customerName)}</PARTYNAME>
            <PARTYLEDGERNAME>${xmlEscape(order.customerName)}</PARTYLEDGERNAME>
            <BASICBUYERNAME>${xmlEscape(order.customerName)}</BASICBUYERNAME>
            <BASICDUEDATEOFPYMT>${xmlEscape(order.dueDate)}</BASICDUEDATEOFPYMT>${lines}
          </VOUCHER>
        </TALLYMESSAGE>`;
}

function orderQuantity(item: RestockPlanningItem): number {
  return item.approvedOrderQuantity ?? item.suggestedOrderQuantity;
}

export class PlanningExporter {
  constructor(
    private readonly planning: PlanningDatabase,
    private readonly stores: StoresDatabase,
  ) {}

  generate(input: PlanningExportInput): PlanningExportResult {
    const statuses = input.statuses?.length ? input.statuses : ["APPROVED"];
    const state = this.planning.getState();
    const selected = state.items.filter((item) =>
      statuses.includes(item.recommendationStatus as "REVIEWED" | "APPROVED")
      && orderQuantity(item) > 0,
    );
    if (selected.length === 0) {
      throw new Error("No reviewed or approved restock recommendations with a positive order quantity are ready to export.");
    }

    // Reuse the same validated backup lifecycle used by Tally exports.
    this.stores.backup("before-restock-export");

    const createdAt = new Date().toISOString();
    const batchId = randomUUID();
    const folder = this.stores.getState().database.exportFolder;
    mkdirSync(folder, { recursive: true });
    const prefix = `inventory-scanner-planning-v${SCHEMA_VERSION}-${timestampForFile()}`;
    const excelPath = path.join(folder, `${prefix}-restock.xlsx`);
    const csvPath = input.includeCsv ? path.join(folder, `${prefix}-tally-reorder.csv`) : null;

    const tallySelected = selected.filter((item) => item.catalogSource === "TALLY");
    const localSelected = selected.filter((item) => item.catalogSource === "LOCAL");
    const tallyRows = tallySelected.map((item) => ({
      "Schema Version": SCHEMA_VERSION,
      "Tally Stock Item Name": item.itemName,
      "Tally Stock Item GUID": item.tallyItemGuid,
      "Reorder Level": item.reorderPoint,
      "Minimum Order Quantity": item.minimumOrderQuantity,
      "Approved Purchase Quantity": orderQuantity(item),
      "Preferred Supplier": item.preferredSupplierName,
      "Planning Note": item.notes,
    }));
    const localRows = localSelected.map((item) => ({
      "Schema Version": SCHEMA_VERSION,
      "Local Stores Catalog Item": item.itemName,
      Group: item.groupName,
      "Approved Purchase Quantity": orderQuantity(item),
      "Reorder Level": item.reorderPoint,
      "Target Stock": item.targetStock,
      "Preferred Supplier": item.preferredSupplierName,
      Note: "Local-only item; create or map this Stock Item in Tally before import.",
    }));
    const reviewRows = selected.map((item) => ({
      "Schema Version": SCHEMA_VERSION,
      "Stock Item": item.itemName,
      "Catalog Source": item.catalogSource,
      Group: item.groupName,
      "On Hand": item.onHand,
      Reserved: item.reserved,
      "Service Reserve": item.serviceReserve,
      Available: item.available,
      Incoming: item.incoming,
      Projected: item.projected,
      "Reorder Point": item.reorderPoint,
      "Usage Suggested Reorder Point": item.suggestedReorderPoint,
      "Target Stock": item.targetStock,
      "Suggested Order": item.suggestedOrderQuantity,
      "Approved Order": orderQuantity(item),
      "Minimum Order Quantity": item.minimumOrderQuantity,
      Supplier: item.preferredSupplierName,
      "Configured Lead Time Days": item.leadTimeDays,
      "Effective Lead Time Days": item.effectiveLeadTimeDays,
      "Observed Median Lead Time Days": item.observedLeadTimeMedianDays ?? "",
      Status: item.recommendationStatus,
      Health: item.health,
    }));
    const metadataRows = [
      { Field: "Export Schema", Value: SCHEMA_VERSION },
      { Field: "Batch ID", Value: batchId },
      { Field: "Generated At", Value: createdAt },
      { Field: "Generated By", Value: input.exportedBy ?? "" },
      { Field: "Tally Mapping", Value: "Map 'Tally Stock Item Name', 'Reorder Level', and 'Minimum Order Quantity' in TallyPrime's Excel import template." },
      { Field: "Direct Tally Posting", Value: "Disabled; this is a reviewable/manual import file." },
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(metadataRows), "Metadata");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(reviewRows), "Restock Review");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(tallyRows), "Tally Reorder Import");
    if (localRows.length > 0) {
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(localRows), "Local-only Restock");
    }
    XLSX.writeFile(workbook, excelPath, { compression: true });
    if (csvPath) writeFileSync(csvPath, toCsv(tallyRows), "utf8");

    const payloadHash = createHash("sha256").update(JSON.stringify({ tallyRows, localRows })).digest("hex");
    this.planning.recordExportBatch({
      id: batchId,
      createdAt,
      createdBy: input.exportedBy ?? "",
      excelFilename: path.basename(excelPath),
      csvFilename: csvPath ? path.basename(csvPath) : "",
      itemCount: selected.length,
      payloadHash,
    });
    this.planning.markRecommendationsExported(selected.map((item) => item.stockItemId), createdAt);

    return {
      schemaVersion: SCHEMA_VERSION,
      batchId,
      excelPath,
      csvPath,
      itemCount: selected.length,
      warnings: [
        "Tally reorder settings are exported as an Excel/CSV mapping file. Direct master alteration remains disabled.",
        ...(localRows.length > 0
          ? [`${localRows.length} local-only Stores Catalog item${localRows.length === 1 ? " was" : "s were"} excluded from the Tally import sheet and listed separately.`]
          : []),
      ],
    };
  }

  generateSalesOrderVouchers(input: SalesOrderVoucherExportInput): SalesOrderVoucherExportResult {
    const requestedIds = new Set(input.salesOrderIds ?? []);
    if (requestedIds.size === 0) throw new Error("Choose at least one order to export.");
    const state = this.planning.getState();
    const selected = state.salesOrders.filter((order) => requestedIds.has(order.id));
    if (selected.length === 0) throw new Error("No matching Sales or Service Orders were found.");
    const empty = selected.find((order) => order.sourceLines.length === 0);
    if (empty) throw new Error(`${empty.voucherNumber || empty.poReference} has no order lines to export.`);

    this.stores.backup("before-sales-order-voucher-export");

    const createdAt = new Date().toISOString();
    const batchId = randomUUID();
    const folder = this.stores.getState().database.exportFolder;
    mkdirSync(folder, { recursive: true });
    const prefix = `inventory-scanner-order-vouchers-v${SCHEMA_VERSION}-${timestampForFile()}`;
    const excelPath = path.join(folder, `${prefix}.xlsx`);
    const xmlPath = path.join(folder, `${prefix}.xml`);

    const companyName = this.stores.getState().companyName;
    const voucherRows = selected.flatMap((order) => order.sourceLines.map((line) => ({
      "Schema Version": SCHEMA_VERSION,
      "Order Kind": order.orderKind === "SERVICE" ? "Service Order" : "Sales Order",
      "Tally Voucher Type": voucherTypeFor(order),
      "Voucher Number": order.voucherNumber,
      "Voucher Date": order.voucherDate,
      "Due Date": order.dueDate,
      Customer: order.customerName,
      "PO / Reference": order.poReference,
      "Stock Item": line.itemNameSnapshot,
      "Stock Item GUID": line.itemTallyGuid,
      Quantity: line.quantity,
      Value: line.value ?? "",
    })));
    const metadataRows = [
      { Field: "Export Schema", Value: SCHEMA_VERSION },
      { Field: "Batch ID", Value: batchId },
      { Field: "Generated At", Value: createdAt },
      { Field: "Generated By", Value: input.exportedBy ?? "" },
      { Field: "Tally Company", Value: companyName },
      { Field: "Direct Tally Posting", Value: "Disabled; import this XML from Tally after review." },
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(metadataRows), "Metadata");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(voucherRows), "Voucher Lines");
    XLSX.writeFile(workbook, excelPath, { compression: true });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${xmlEscape(companyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>${selected.map(voucherXml).join("")}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
`;
    writeFileSync(xmlPath, xml, "utf8");

    return {
      schemaVersion: SCHEMA_VERSION,
      batchId,
      excelPath,
      xmlPath,
      itemCount: selected.length,
      warnings: [
        "Import the XML into Tally only after reviewing the workbook.",
        "Specification values are carried through the selected Stock Item names. If Tally needs them as separate UDF fields, add the matching Tally UDF mapping before direct posting.",
      ],
    };
  }
}
