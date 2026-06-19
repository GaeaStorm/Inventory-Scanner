import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as XLSX from "xlsx";

import type { CatalogCleanupExportResult, StoresStockItem } from "./types";
import { StoresDatabase } from "./database";

type Row = Record<string, string | number>;

const EXCEL_IMPORT_HELP = "https://help.tallysolutions.com/import-data-using-any-excel-file/";
const XML_IMPORT_HELP = "https://help.tallysolutions.com/import-data-from-xml-or-json/";
const STOCK_ITEM_HELP = "https://help.tallysolutions.com/manage-stock-item-tally/";
const XML_SCHEMA_HELP = "https://help.tallysolutions.com/sample-xml/";

function xml(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function appendSheet(workbook: XLSX.WorkBook, name: string, rows: Row[], widths: number[]): void {
  const data = rows.length > 0 ? rows : [{ Status: "No records" }];
  const worksheet = XLSX.utils.json_to_sheet(data);
  worksheet["!cols"] = widths.map((wch) => ({ wch }));
  worksheet["!autofilter"] = { ref: worksheet["!ref"] ?? "A1:A1" };
  XLSX.utils.book_append_sheet(workbook, worksheet, name);
}

function renameRows(items: StoresStockItem[]): Row[] {
  return items
    .filter((item) => item.name !== item.tallyName)
    .map((item) => ({
      "Tally Current Name": item.tallyName,
      "New Name": item.name,
      "Tally GUID": item.tallyGuid,
      Group: item.parentName,
      "XML Included": item.source === "TALLY" ? "Yes" : "No",
      Note: item.source === "TALLY"
        ? "Import the generated XML as Masters using Modify with new data, then sync Inventory Scanner."
        : "Local-only item. Create or match this Stock Item in Tally before it can be synchronized.",
    }));
}

function duplicateRows(items: StoresStockItem[]): Row[] {
  const byGuid = new Map(items.map((item) => [item.tallyGuid, item]));
  return items
    .filter((item) => item.catalogStatus === "DUPLICATE")
    .map((item) => {
      const primary = item.duplicateOfTallyGuid ? byGuid.get(item.duplicateOfTallyGuid) : null;
      return {
        "Duplicate Tally Name": item.tallyName,
        "Duplicate Local Name": item.name,
        "Duplicate Tally GUID": item.tallyGuid,
        "Primary Tally Name": primary?.tallyName ?? item.duplicateOfName ?? "",
        "Primary Local Name": primary?.name ?? item.duplicateOfName ?? "",
        "Primary Tally GUID": primary?.tallyGuid ?? item.duplicateOfTallyGuid ?? "",
        "Local Stock Remaining": item.localAvailableQuantity,
        "Recommended Tally Action": "Review vouchers/BOM references with Accounts; do not delete a used Stock Item. Keep the primary item for future entries.",
      };
    });
}

function obsoleteRows(items: StoresStockItem[]): Row[] {
  return items
    .filter((item) => item.catalogStatus === "OBSOLETE")
    .map((item) => ({
      "Tally Current Name": item.tallyName,
      "Local Display Name": item.name,
      "Tally GUID": item.tallyGuid,
      Group: item.parentName,
      "Local Stock Remaining": item.localAvailableQuantity,
      "Recommended Tally Action": item.localAvailableQuantity > 0
        ? "Keep available until stock is depleted; stop using for new purchasing."
        : "Retain for history or manually rename with an OBSOLETE prefix after Accounts review.",
    }));
}

function buildRenameXml(companyName: string, rows: Row[]): string {
  const messages = rows.map((row) => `
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM NAME="${xml(row["Tally Current Name"])}" ACTION="Alter">
            <NAME>${xml(row["New Name"])}</NAME>
            <NAME.LIST TYPE="String">
              <NAME>${xml(row["New Name"])}</NAME>
              <NAME>${xml(row["Tally Current Name"])}</NAME>
            </NAME.LIST>
          </STOCKITEM>
        </TALLYMESSAGE>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Import as Masters. Back up Tally first and choose "Modify with new data". -->
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>All Masters</ID>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES><SVCURRENTCOMPANY>${xml(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>${messages}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
`;
}

export class CatalogExporter {
  constructor(
    private readonly database: StoresDatabase,
    private readonly defaultExportFolder: string,
  ) {}

  generate(): CatalogCleanupExportResult {
    const state = this.database.getState();
    const renames = renameRows(state.stockItems);
    const importableRenames = renames.filter((row) => row["XML Included"] === "Yes");
    const duplicates = duplicateRows(state.stockItems);
    const obsolete = obsoleteRows(state.stockItems);
    if (renames.length + duplicates.length + obsolete.length === 0) {
      throw new Error("There are no local catalog changes to export.");
    }

    const exportFolder = this.database.getExportFolder(this.defaultExportFolder);
    mkdirSync(exportFolder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `inventory-scanner-catalog-cleanup-${stamp}`;
    const workbookPath = path.join(exportFolder, `${base}.xlsx`);
    const renameXmlPath = importableRenames.length > 0 ? path.join(exportFolder, `${base}-renames.xml`) : null;

    const workbook = XLSX.utils.book_new();
    workbook.Props = {
      Title: "Inventory Scanner - Tally Catalog Cleanup",
      Subject: "Stock Item renames, duplicate review, and obsolete-item review",
      Author: "Inventory Scanner",
      CreatedDate: new Date(),
    };
    appendSheet(workbook, "Instructions", [
      { Step: 1, Action: "Back up the Tally company.", Source: XML_IMPORT_HELP },
      { Step: 2, Action: "Review the Renames sheet. Only those rows are included in the companion XML.", Source: XML_SCHEMA_HELP },
      { Step: 3, Action: "Use Alt+O > Import > Masters. Select the XML and choose Modify with new data.", Source: XML_IMPORT_HELP },
      { Step: 4, Action: "Review Duplicates with Accounts. This file does not rewrite historical vouchers or BOMs.", Source: STOCK_ITEM_HELP },
      { Step: 5, Action: "Review Obsolete items manually because historic masters may still be referenced.", Source: STOCK_ITEM_HELP },
      { Step: 6, Action: "After Tally changes, run Tally Sync in Inventory Scanner.", Source: EXCEL_IMPORT_HELP },
    ], [8, 78, 55]);
    appendSheet(workbook, "Renames", renames, [34, 34, 42, 28, 15, 72]);
    appendSheet(workbook, "Duplicates", duplicates, [34, 34, 42, 34, 34, 42, 22, 82]);
    appendSheet(workbook, "Obsolete", obsolete, [34, 34, 42, 28, 22, 82]);
    appendSheet(workbook, "All Changes", [
      ...renames.map((row) => ({
        Change: "RENAME",
        "Tally Name": row["Tally Current Name"],
        "Local / New Name": row["New Name"],
        "Primary Tally Name": "",
        "Tally GUID": row["Tally GUID"],
        "Local Stock Remaining": "",
        "Import Artifact": "Rename XML",
        "Recommended Action": row.Note,
      })),
      ...duplicates.map((row) => ({
        Change: "DUPLICATE",
        "Tally Name": row["Duplicate Tally Name"],
        "Local / New Name": row["Duplicate Local Name"],
        "Primary Tally Name": row["Primary Tally Name"],
        "Tally GUID": row["Duplicate Tally GUID"],
        "Local Stock Remaining": row["Local Stock Remaining"],
        "Import Artifact": "Workbook review only",
        "Recommended Action": row["Recommended Tally Action"],
      })),
      ...obsolete.map((row) => ({
        Change: "OBSOLETE",
        "Tally Name": row["Tally Current Name"],
        "Local / New Name": row["Local Display Name"],
        "Primary Tally Name": "",
        "Tally GUID": row["Tally GUID"],
        "Local Stock Remaining": row["Local Stock Remaining"],
        "Import Artifact": "Workbook review only",
        "Recommended Action": row["Recommended Tally Action"],
      })),
    ], [14, 34, 34, 34, 42, 22, 24, 82]);
    XLSX.writeFile(workbook, workbookPath, { bookType: "xlsx", compression: true });

    if (renameXmlPath) {
      writeFileSync(renameXmlPath, buildRenameXml(state.companyName, importableRenames), "utf8");
    }

    const warnings: string[] = [];
    if (duplicates.length > 0) {
      warnings.push("Duplicate Stock Items were listed for manual Accounts review; their historical vouchers and BOM references were not rewritten.");
    }
    if (obsolete.length > 0) {
      warnings.push("Obsolete Stock Items were listed for review but were not deleted or automatically altered in Tally.");
    }
    if (renames.length > importableRenames.length) {
      warnings.push("Local-only Stock Item renames were listed in the workbook but omitted from Tally XML because they do not yet have a Tally master.");
    }
    return {
      workbookPath,
      renameXmlPath,
      renameCount: renames.length,
      duplicateCount: duplicates.length,
      obsoleteCount: obsolete.length,
      warnings,
    };
  }
}
