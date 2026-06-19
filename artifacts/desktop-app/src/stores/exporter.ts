import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as XLSX from "xlsx";

import type { ExportBatchInput, ExportBatchResult } from "./types";
import { StoresDatabase } from "./database";
import { writeTallyMovementWorkbooks } from "./tally-excel";

type Row = Record<string, any>;

export const REVIEW_EXPORT_SCHEMA_VERSION = "1.0";
export const TALLY_XML_ADAPTER_VERSION = "receipt-note-v1/material-out-pending";

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function xml(value: unknown): string {
  return text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function tallyDate(value: string): string {
  return value.replaceAll("-", "");
}

function csvCell(value: unknown): string {
  const source = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(source) ? `"${source.replaceAll('"', '""')}"` : source;
}

function rowsToCsv(rows: Row[]): string {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n") + "\n";
}

function appendSheet(workbook: XLSX.WorkBook, name: string, rows: Row[]): void {
  const safeRows = rows.length > 0 ? rows : [{ Message: "No records" }];
  const worksheet = XLSX.utils.json_to_sheet(safeRows);
  worksheet["!cols"] = Object.keys(safeRows[0] ?? {}).map((header) => ({
    wch: Math.min(50, Math.max(12, header.length + 2)),
  }));
  XLSX.utils.book_append_sheet(workbook, worksheet, name.slice(0, 31));
}

export class StoresExporter {
  constructor(
    private readonly database: StoresDatabase,
    private readonly defaultExportFolder: string,
  ) {}

  generate(input: ExportBatchInput): ExportBatchResult {
    const reviewedBy = text(input.reviewedBy);
    if (!reviewedBy) throw new Error("Chief of Staff / reviewer name is required.");
    const approved = this.database.approvedEntries();
    if (approved.length === 0) throw new Error("There are no approved entries ready for export.");

    const materialOutConfigured = this.database.getState().materialOutXmlConfigured;
    const exportable = approved;
    const materialOut = exportable.filter((entry) => entry.entityType === "MATERIAL_OUT");
    const warnings: string[] = [];

    if (materialOut.length > 0 && !materialOutConfigured) {
     warnings.push(
      `${materialOut.length} approved Material Out group(s) were included in the Material Out Excel workbook. They were omitted from Tally XML because the Production and Servicing XML mapping is still unconfigured.`,
     );
    }

    this.database.backup("before-export");
    const batchId = `BATCH-${randomUUID()}`;
    const exportFolder = this.database.getExportFolder(this.defaultExportFolder);
    mkdirSync(exportFolder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `inventory-scanner-v${REVIEW_EXPORT_SCHEMA_VERSION}-${stamp}`;
    const excelPath = path.join(exportFolder, `${base}-review.xlsx`);
    const materialInExcelPath = path.join(exportFolder, `${base}-material-in.xlsx`);
    const materialOutExcelPath = path.join(exportFolder, `${base}-material-out.xlsx`);
    const csvPath = input.includeCsv ? path.join(exportFolder, `${base}-review.csv`) : null;
    const xmlPath = path.join(exportFolder, `${base}-tally.xml`);

    const data = this.database.exportRows(exportable.map((entry) => entry.id));
    const summaryRows: Row[] = exportable.map((entry) => ({
      "External ID": entry.externalId,
      "Voucher Type": entry.entityType,
      Date: entry.eventDate,
      Status: entry.status,
      Title: entry.title,
      Supplier: entry.supplierName,
      "PO Number": entry.poNumber,
      "Challan Number": entry.challanNumber,
      "Issued Item": entry.issuedItemName,
      Destination: entry.destinationName,
      Quantity: entry.quantity,
      "FIFO Supplier Allocation": entry.fifoSummary,
      "Source Transactions": entry.contributingTransactions,
      Validation: entry.validationMessages.join("; "),
    }));
    const grnRows = exportable.filter((entry) => entry.entityType === "GRN").map((entry) => ({
      "External ID": entry.externalId,
      Date: entry.eventDate,
      Supplier: entry.supplierName,
      "PO Number": entry.poNumber,
      "Challan Number": entry.challanNumber,
      Details: entry.title,
      Quantity: entry.quantity,
    }));
    const materialOutRows = materialOut.map((entry) => ({
      "External ID": entry.externalId,
      Date: entry.eventDate,
      "Issued Item": entry.issuedItemName,
      "Destination Product": entry.destinationName,
      Quantity: entry.quantity,
      "FIFO Supplier Allocation": entry.fifoSummary,
      "Contributing Phone Transactions": entry.contributingTransactions,
      "XML Mapping": this.database.getState().materialOutXmlConfigured ? "Configured" : "Blocked pending sample voucher mapping",
    }));
    const allocationRows: Row[] = data.allocations.map((allocation) => ({
      "Movement ID": allocation.movementId,
      Item: allocation.itemName,
      Supplier: allocation.supplierName,
      "GRN Number": allocation.grnNumber,
      "Receipt Date": allocation.receiptDate,
      Direction: allocation.direction,
      Quantity: allocation.quantity,
      "Purchase Lot ID": allocation.purchaseLotId,
    }));
    const legacyRows: Row[] = data.legacyLots.map((lot) => ({
      Item: lot.itemName,
      Supplier: lot.supplierName,
      "Receipt Date": lot.receiptDate,
      "Quantity Remaining": lot.quantityRemaining,
      Warning: "Supplier could not be reconstructed from historical GRNs.",
    }));
    const openingAdjustmentRows: Row[] = this.database.getState().openingQuantityAdjustments.map((entry) => ({
      "Adjustment ID": entry.id,
      "Created At": entry.createdAt,
      "Stock Item": entry.itemName,
      "Tally Item GUID": entry.tallyItemGuid,
      "Previous Local Count": entry.previousAvailableQuantity,
      "Target Local Count": entry.targetAvailableQuantity,
      "Quantity Change": entry.deltaQuantity,
      Reason: entry.reason,
      "Adjusted By": entry.adjustedBy,
    }));
    const exceptionRows: Row[] = this.database.getState().reviewEntries
      .filter((entry) => entry.status === "EXCEPTION" || entry.validationMessages.length > 0)
      .map((entry) => ({
        "External ID": entry.externalId,
        Type: entry.entityType,
        Date: entry.eventDate,
        Entry: entry.title,
        Status: entry.status,
        Issues: entry.validationMessages.join("; "),
      }));
    const sourceRows: Row[] = data.movements.map((movement) => ({
      "Movement ID": movement.id,
      Workflow: movement.workflow,
      Date: movement.eventDate,
      "Box ID": movement.boxId,
      Item: movement.itemName,
      Quantity: movement.quantity,
      Destination: movement.destinationName,
      Supplier: movement.supplierName,
      "PO Number": movement.poNumber,
      "Challan Number": movement.challanNumber,
      Status: movement.status,
      "Adjustment Effect": movement.adjustmentDirection ?? "",
      "Adjustment Reason": movement.adjustmentReason ?? "",
      "Adjustment Note": movement.adjustmentNote,
      "Adjusted Movement ID": movement.referenceMovementId,
      "Created At": movement.createdAt,
    }));

    const workbook = XLSX.utils.book_new();
    workbook.Props = {
      Title: "Inventory Scanner End-of-Day Review",
      Subject: `Schema ${REVIEW_EXPORT_SCHEMA_VERSION}`,
      Author: "Inventory Scanner",
      CreatedDate: new Date(),
    };
    appendSheet(workbook, "Metadata", [{
      "Export Schema Version": REVIEW_EXPORT_SCHEMA_VERSION,
      "Tally XML Adapter Version": TALLY_XML_ADAPTER_VERSION,
      "Batch ID": batchId,
      "Generated At": new Date().toISOString(),
      "Reviewed By": reviewedBy,
      Company: this.database.getState().companyName,
    }]);
    appendSheet(workbook, "Summary", summaryRows);
    appendSheet(workbook, "GRNs", grnRows);
    appendSheet(workbook, "Material Out", materialOutRows);
    appendSheet(workbook, "FIFO Allocations", allocationRows);
    appendSheet(workbook, "Opening Legacy Stock", legacyRows);
    appendSheet(workbook, "Opening Adjustments", openingAdjustmentRows);
    appendSheet(workbook, "Exceptions", exceptionRows);
    appendSheet(workbook, "Source Transactions", sourceRows);
    XLSX.writeFile(workbook, excelPath);

    writeTallyMovementWorkbooks(this.database, exportable, {
     materialInPath: materialInExcelPath,
     materialOutPath: materialOutExcelPath,
     generatedAt: new Date(),
     reviewedBy,
    });

    if (csvPath) {
      const combinedRows = [
        ...summaryRows.map((row) => ({ "Schema Version": REVIEW_EXPORT_SCHEMA_VERSION, "Record Type": "Summary", ...row })),
        ...allocationRows.map((row) => ({ "Schema Version": REVIEW_EXPORT_SCHEMA_VERSION, "Record Type": "FIFO Allocation", ...row })),
        ...openingAdjustmentRows.map((row) => ({ "Schema Version": REVIEW_EXPORT_SCHEMA_VERSION, "Record Type": "Opening Adjustment", ...row })),
        ...sourceRows.map((row) => ({ "Schema Version": REVIEW_EXPORT_SCHEMA_VERSION, "Record Type": "Source Transaction", ...row })),
      ];
      writeFileSync(csvPath, rowsToCsv(combinedRows), "utf8");
    }

    const companyName = this.database.getState().companyName;
    const grnXml = this.buildGrnXml(exportable.filter((entry) => entry.entityType === "GRN"));
    const materialOutXml = materialOutConfigured
      ? this.buildConfiguredMaterialOutXml(materialOut)
      : "";
    const payload = `<?xml version="1.0" encoding="utf-8"?>
<!-- Inventory Scanner export schema ${REVIEW_EXPORT_SCHEMA_VERSION}; adapter ${TALLY_XML_ADAPTER_VERSION}; batch ${batchId} -->
<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES><SVCURRENTCOMPANY>${xml(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
${grnXml}${materialOutXml}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>\n`;
    writeFileSync(xmlPath, payload, "utf8");

    const payloadHash = createHash("sha256").update(payload).digest("hex");
    this.database.createBatchRecord(
      input,
      exportable.map((entry) => entry.id),
      batchId,
      REVIEW_EXPORT_SCHEMA_VERSION,
      TALLY_XML_ADAPTER_VERSION,
    );
    this.database.finishBatch(batchId, { excelPath, csvPath, xmlPath, payloadHash });

    return {
      schemaVersion: REVIEW_EXPORT_SCHEMA_VERSION,
      batchId,
      excelPath,
      csvPath,
      xmlPath,
      warnings,
    };
  }

  private buildGrnXml(entries: ReturnType<StoresDatabase["approvedEntries"]>): string {
    const messages: string[] = [];
    for (const entry of entries) {
      const grn = this.database.db.prepare(`
        SELECT g.*, supplier.name AS supplier_name
        FROM grns g LEFT JOIN suppliers supplier ON supplier.id = g.supplier_id
        WHERE g.id = ?
      `).get(Number(entry.entityId)) as Row | undefined;
      if (!grn) continue;
      const lines = this.database.db.prepare(`
        SELECT gl.*, item.name AS item_name FROM grn_lines gl
        JOIN tally_stock_items item ON item.id = gl.stock_item_id WHERE gl.grn_id = ?
      `).all(Number(entry.entityId)) as Row[];
      const inventoryXml = lines.map((line) => `
          <ALLINVENTORYENTRIES.LIST>
            <STOCKITEMNAME>${xml(line.item_name)}</STOCKITEMNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <ACTUALQTY>${Number(line.quantity)}</ACTUALQTY>
            <BILLEDQTY>${Number(line.quantity)}</BILLEDQTY>
            ${grn.po_number ? `<ORDERALLOCATIONS.LIST><ORDERNO>${xml(grn.po_number)}</ORDERNO></ORDERALLOCATIONS.LIST>` : ""}
          </ALLINVENTORYENTRIES.LIST>`).join("");
      messages.push(`
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER REMOTEID="${xml(entry.externalId)}" VCHTYPE="Receipt Note" ACTION="Create">
            <DATE>${tallyDate(text(grn.voucher_date))}</DATE>
            <VOUCHERTYPENAME>Receipt Note</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${xml(grn.voucher_number)}</VOUCHERNUMBER>
            <REFERENCE>${xml(grn.challan_number)}</REFERENCE>
            <REFERENCEDATE>${tallyDate(text(grn.challan_date || grn.voucher_date))}</REFERENCEDATE>
            <PARTYLEDGERNAME>${xml(grn.supplier_name)}</PARTYLEDGERNAME>
            <NARRATION>Inventory Scanner ${xml(entry.externalId)}</NARRATION>${inventoryXml}
          </VOUCHER>
        </TALLYMESSAGE>`);
    }
    return messages.join("");
  }

  private buildConfiguredMaterialOutXml(entries: ReturnType<StoresDatabase["approvedEntries"]>): string {
    // Intentionally isolated. Replace this adapter only after exporting two sample
    // Material Out vouchers from the temporary Tally company (Production + Servicing).
    return entries.map((entry) => `
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <!-- MATERIAL OUT ADAPTER PLACEHOLDER: ${xml(entry.externalId)} ${xml(entry.title)} × ${entry.quantity} -->
        </TALLYMESSAGE>`).join("");
  }
}
