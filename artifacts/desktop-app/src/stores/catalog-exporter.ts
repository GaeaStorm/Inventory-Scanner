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
      "Qualified Name": item.qualifiedName,
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
        "Duplicate Qualified Name": item.qualifiedName,
        "Duplicate Tally GUID": item.tallyGuid,
        "Primary Tally Name": primary?.tallyName ?? item.duplicateOfName ?? "",
        "Primary Local Name": primary?.name ?? item.duplicateOfName ?? "",
        "Primary Qualified Name": primary?.qualifiedName ?? item.duplicateOfName ?? "",
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
      "Qualified Name": item.qualifiedName,
      "Tally GUID": item.tallyGuid,
      Group: item.parentName,
      "Local Stock Remaining": item.localAvailableQuantity,
      "Recommended Tally Action": item.localAvailableQuantity > 0
        ? "Keep available until stock is depleted; stop using for new purchasing."
        : "Retain for history or manually rename with an OBSOLETE prefix after Accounts review.",
    }));
}

function buildMasterXml(
  companyName: string,
  renameEntries: Row[],
  localGroups: ReturnType<StoresDatabase["getState"]>["catalogGroups"],
  localCategories: ReturnType<StoresDatabase["getState"]>["stockCategories"],
  localItems: StoresStockItem[],
): string {
  const groupMessages = localGroups
    .sort((left, right) => left.level - right.level || left.name.localeCompare(right.name))
    .map((group) => `
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKGROUP NAME="${xml(group.name)}" ACTION="Create">
            <NAME>${xml(group.name)}</NAME>
            <PARENT>${xml(group.parentName || "Primary")}</PARENT>
          </STOCKGROUP>
        </TALLYMESSAGE>`).join("");
  const categoryMessages = localCategories
    .sort((left, right) => left.level - right.level || left.name.localeCompare(right.name))
    .map((category) => `
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKCATEGORY NAME="${xml(category.name)}" ACTION="Create">
            <NAME>${xml(category.name)}</NAME>
            <PARENT>${xml(category.parentName || "Primary")}</PARENT>
          </STOCKCATEGORY>
        </TALLYMESSAGE>`).join("");
  const renameMessages = renameEntries.map((row) => `
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM NAME="${xml(row["Tally Current Name"])}" ACTION="Alter">
            <NAME>${xml(row["New Name"])}</NAME>
            <NAME.LIST TYPE="String">
              <NAME>${xml(row["New Name"])}</NAME>
              <NAME>${xml(row["Tally Current Name"])}</NAME>
            </NAME.LIST>
          </STOCKITEM>
        </TALLYMESSAGE>`).join("");
  const createMessages = localItems.map((item) => `
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM NAME="${xml(item.tallyName)}" ACTION="Create">
            <NAME>${xml(item.tallyName)}</NAME>
            <PARENT>${xml(item.parentName)}</PARENT>
            ${item.categoryName ? `<CATEGORY>${xml(item.categoryName)}</CATEGORY>` : ""}
            <BASEUNITS>${xml(item.baseUnits || "Nos")}</BASEUNITS>
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
      <REQUESTDATA>${groupMessages}${categoryMessages}${createMessages}${renameMessages}
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
    const localItems = state.stockItems.filter((item) => item.source === "LOCAL" && item.catalogStatus === "ACTIVE");
    const localGroups = state.catalogGroups.filter((group) => group.source === "LOCAL");
    const localCategories = state.stockCategories.filter((category) => category.source === "LOCAL");
    const stockItemRows: Row[] = state.stockItems.map((item) => ({
      "Stock Item Name": item.name,
      "Current Tally Name": item.tallyName,
      "Tally GUID": item.tallyGuid,
      Group: item.parentName,
      "Group Path": item.groupPath.join(" > "),
      "Stock Category": item.categoryName,
      "Base Units": item.baseUnits,
      Source: item.source,
      Status: item.catalogStatus,
      Ignored: item.ignored ? "Yes" : "No",
      Active: item.active ? "Yes" : "No",
      "Has BOM": item.hasBom ? "Yes" : "No",
      "Local Available Quantity": item.localAvailableQuantity,
    }));
    const bomRows = this.database.db.prepare(`
      SELECT product.name AS product_name, product.tally_guid AS product_guid,
        version.version_number, version.label, version.source,
        component.name AS component_name, component.tally_guid AS component_guid,
        line.quantity_per_product, line.loss_buffer_percent
      FROM planning_bom_versions version
      JOIN tally_stock_items product ON product.id = version.product_item_id
      JOIN planning_bom_lines line ON line.bom_version_id = version.id
      JOIN tally_stock_items component ON component.id = line.component_item_id
      WHERE version.status = 'ACTIVE'
      ORDER BY product.name, line.id
    `).all() as Array<Record<string, string | number>>;
    const reorderRows = this.database.db.prepare(`
      SELECT COALESCE(NULLIF(item.local_name_override, ''), item.name) AS item_name,
        item.tally_guid, item.parent_name, policy.reorder_point, policy.target_stock,
        policy.minimum_order_quantity, policy.lead_time_days, policy.safety_days,
        supplier.name AS preferred_supplier
      FROM tally_stock_items item
      LEFT JOIN planning_restock_policies policy ON policy.stock_item_id = item.id
      LEFT JOIN suppliers supplier ON supplier.id = policy.preferred_supplier_id
      WHERE item.active = 1
      ORDER BY item.name
    `).all() as Array<Record<string, string | number>>;
    const purchaseOrderRows = state.purchaseOrders.flatMap((order) => order.lines.map((line) => ({
      "Purchase Order": order.voucherNumber,
      Date: order.voucherDate,
      Supplier: order.supplierName,
      "Stock Item": line.itemName,
      "Tally GUID": line.tallyItemGuid,
      Ordered: line.orderedQuantity,
      Received: line.receivedQuantity,
      Outstanding: line.outstandingQuantity,
      Rate: line.rate ?? "",
      Value: line.value ?? "",
    })));

    const exportFolder = this.database.getExportFolder(this.defaultExportFolder);
    mkdirSync(exportFolder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `inventory-scanner-tally-masters-${stamp}`;
    const workbookPath = path.join(exportFolder, `${base}.xlsx`);
    const renameXmlPath = importableRenames.length + localItems.length + localGroups.length + localCategories.length > 0
      ? path.join(exportFolder, `${base}-masters.xml`)
      : null;

    const workbook = XLSX.utils.book_new();
    workbook.Props = {
      Title: "Inventory Scanner - Tally Inventory Masters",
      Subject: "Complete Tally master sync: Stock Groups, Stock Categories, Stock Items, renames, and BOMs",
      Author: "Inventory Scanner",
      CreatedDate: new Date(),
    };
    appendSheet(workbook, "Instructions", [
      { Step: 1, Action: "Back up the Tally company.", Source: XML_IMPORT_HELP },
      { Step: 2, Action: "Review Stock Groups, Stock Categories, Stock Items, Renames, and Active BOMs. Local masters and Tally-backed renames are included in the companion XML.", Source: XML_SCHEMA_HELP },
      { Step: 3, Action: "Use Alt+O > Import > Masters. Select the XML and choose Modify with new data.", Source: XML_IMPORT_HELP },
      { Step: 4, Action: "Import or map Active BOMs from the workbook after their Stock Items exist in Tally. Review duplicates with Accounts.", Source: STOCK_ITEM_HELP },
      { Step: 5, Action: "Review Obsolete items manually because historic masters may still be referenced.", Source: STOCK_ITEM_HELP },
      { Step: 6, Action: "After Tally changes, run Tally Sync in Inventory Scanner.", Source: EXCEL_IMPORT_HELP },
    ], [8, 78, 55]);
    appendSheet(workbook, "Stock Groups", state.catalogGroups.map((group) => ({
      "Stock Group": group.name,
      Parent: group.parentName || "Primary",
      "Full Path": group.path.join(" > "),
      Level: group.level,
      Source: group.source,
      Ignored: group.ignored ? "Yes" : "No",
      "Stock Item Count": group.itemCount,
      "Included in Master XML": group.source === "LOCAL" ? "Yes" : "Already in Tally",
    })), [34, 34, 54, 10, 14, 12, 20, 24]);
    appendSheet(workbook, "Stock Categories", state.stockCategories.map((category) => ({
      "Stock Category": category.name,
      Parent: category.parentName || "Primary",
      "Full Path": category.path.join(" > "),
      Level: category.level,
      Source: category.source,
      "Stock Item Count": category.itemCount,
      "Included in Master XML": category.source === "LOCAL" ? "Yes" : "Already in Tally",
    })), [34, 34, 54, 10, 14, 20, 24]);
    appendSheet(workbook, "Stock Items", stockItemRows, [34, 34, 42, 28, 54, 28, 14, 14, 16, 22, 12, 12, 12, 24]);
    appendSheet(workbook, "Active BOMs", bomRows.map((row) => ({
      Product: row.product_name,
      "Product Tally GUID": row.product_guid,
      "BOM Version": row.version_number,
      "BOM Label": row.label,
      Source: row.source,
      Component: row.component_name,
      "Component Tally GUID": row.component_guid,
      "Quantity per Product": row.quantity_per_product,
      "General Wastage %": row.loss_buffer_percent,
    })), [34, 42, 14, 28, 14, 34, 42, 22, 20]);
    appendSheet(workbook, "Reorder Levels", reorderRows.map((row) => ({
      "Stock Item": row.item_name,
      "Tally GUID": row.tally_guid,
      Group: row.parent_name,
      "Reorder Level": row.reorder_point ?? 0,
      "Target Stock": row.target_stock ?? 0,
      "Minimum Order Quantity": row.minimum_order_quantity ?? 0,
      "Lead Time Days": row.lead_time_days ?? 0,
      "Safety Days": row.safety_days ?? 0,
      "Preferred Supplier": row.preferred_supplier ?? "",
    })), [34, 42, 28, 18, 18, 24, 18, 16, 34]);
    appendSheet(workbook, "Suppliers", state.suppliers.map((supplier) => ({
      "Supplier Name": supplier.name,
      "Tally GUID": supplier.tallyGuid,
    })), [40, 44]);
    appendSheet(workbook, "Open Purchase Orders", purchaseOrderRows, [24, 14, 34, 34, 42, 14, 14, 16, 14, 16]);
    appendSheet(workbook, "Renames", renames, [34, 34, 54, 42, 28, 15, 72]);
    appendSheet(workbook, "Duplicates", duplicates, [34, 34, 54, 42, 34, 34, 54, 42, 22, 82]);
    appendSheet(workbook, "Obsolete", obsolete, [34, 34, 54, 42, 28, 22, 82]);
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
      writeFileSync(
        renameXmlPath,
        buildMasterXml(state.companyName, importableRenames, localGroups, localCategories, localItems),
        "utf8",
      );
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
    if (bomRows.length > 0) {
      warnings.push("Active BOMs are included in the workbook for Tally import mapping; review Tally's BOM/Manufacturing Journal configuration before import.");
    }
    return {
      workbookPath,
      renameXmlPath,
      groupCount: localGroups.length,
      categoryCount: localCategories.length,
      itemCount: localItems.length,
      renameCount: renames.length,
      duplicateCount: duplicates.length,
      obsoleteCount: obsolete.length,
      warnings,
    };
  }
}
