import * as XLSX from "xlsx";

import { StoresDatabase } from "./database";

type DatabaseRow = Record<string, any>;
type ReviewEntries = ReturnType<StoresDatabase["approvedEntries"]>;

const TALLY_VOUCHER_HEADERS = [
 "Voucher Date",
 "Voucher Type Name",
 "Voucher Number",
 "Buyer/Supplier - Address",
 "Buyer/Supplier - Pincode",
 "Ledger Name",
 "Ledger Amount",
 "Ledger Amount Dr/Cr",
 "Item Name",
 "Billed Quantity",
 "Item Rate",
 "Item Rate per",
 "Item Amount",
] as const;

type TallyVoucherHeader = (typeof TALLY_VOUCHER_HEADERS)[number];
type TallyVoucherValue = string | number;
type TallyVoucherRow = Record<TallyVoucherHeader, TallyVoucherValue>;

interface OutputPaths {
 materialInPath: string;
 materialOutPath: string;
 generatedAt: Date;
 reviewedBy: string;
}

function cleanText(value: unknown): string {
 return String(value ?? "").trim();
}

function numberOrBlank(value: unknown): number | "" {
 if (value === null || value === undefined || value === "") return "";
 const parsed = Number(value);
 return Number.isFinite(parsed) ? parsed : "";
}

function dateForTally(value: unknown): string {
 const source = cleanText(value);
 const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(source);
 return match ? `${match[3]}-${match[2]}-${match[1]}` : source;
}

function itemAmount(line: DatabaseRow): number | "" {
 const storedValue = numberOrBlank(line.value);
 if (storedValue !== "") return storedValue;

 const quantity = numberOrBlank(line.quantity);
 const rate = numberOrBlank(line.rate);
 return quantity !== "" && rate !== "" ? quantity * rate : "";
}

function emptyVoucherRow(): TallyVoucherRow {
 return Object.fromEntries(
  TALLY_VOUCHER_HEADERS.map((header) => [header, ""]),
 ) as TallyVoucherRow;
}

function materialOutLedgerName(destinationName: string): string {
 // The supplied template lists these as valid Material Out ledgers.
 // Service/sample destinations go to the sample account; other issues use
 // outward sales. Keep this function isolated so the rule can later become
 // an explicit setting without changing workbook generation.
 return /\b(sample|service|servicing|repair)\b/i.test(destinationName)
  ? "In - Sample Account"
  : "Out - Outward Sales";
}

function buildMaterialInRows(
 database: StoresDatabase,
 entries: ReviewEntries,
): TallyVoucherRow[] {
 const rows: TallyVoucherRow[] = [];

 for (const entry of entries.filter((candidate) => candidate.entityType === "GRN")) {
  const grn = database.db.prepare(`
   SELECT g.*, supplier.name AS supplier_name
   FROM grns g
   LEFT JOIN suppliers supplier ON supplier.id = g.supplier_id
   WHERE g.id = ?
  `).get(Number(entry.entityId)) as DatabaseRow | undefined;

  if (!grn) continue;

  const lines = database.db.prepare(`
   SELECT gl.*, item.name AS item_name
   FROM grn_lines gl
   JOIN tally_stock_items item ON item.id = gl.stock_item_id
   WHERE gl.grn_id = ?
   ORDER BY gl.id
  `).all(Number(entry.entityId)) as DatabaseRow[];

  for (const line of lines) {
   const quantity = numberOrBlank(line.quantity);
   rows.push({
    ...emptyVoucherRow(),
    "Voucher Date": dateForTally(grn.voucher_date || entry.eventDate),
    "Voucher Type Name": "Inward Material",
    "Voucher Number": cleanText(grn.voucher_number) || entry.externalId,
    "Ledger Name": "In - Purchase Account",
    "Ledger Amount": quantity,
    "Item Name": cleanText(line.item_name),
    "Billed Quantity": quantity,
    "Item Rate": numberOrBlank(line.rate),
    "Item Amount": itemAmount(line),
   });
  }
 }

 return rows;
}

function buildMaterialOutRows(entries: ReviewEntries): TallyVoucherRow[] {
 return entries
  .filter((entry) => entry.entityType === "MATERIAL_OUT")
  .map((entry) => ({
   ...emptyVoucherRow(),
   "Voucher Date": dateForTally(entry.eventDate),
   "Voucher Type Name": "Outward Material",
   "Voucher Number": entry.externalId,
   "Ledger Name": materialOutLedgerName(entry.destinationName),
   "Ledger Amount": entry.quantity,
   "Item Name": entry.issuedItemName,
   "Billed Quantity": entry.quantity,
  }));
}

function writeVoucherWorkbook(
 filePath: string,
 title: string,
 rows: TallyVoucherRow[],
 generatedAt: Date,
 reviewedBy: string,
): void {
 const workbook = XLSX.utils.book_new();
 workbook.Props = {
  Title: title,
  Subject: "Tally Inventory Voucher import",
  Author: "Inventory Scanner",
  Comments: `Generated ${generatedAt.toISOString()} after review by ${reviewedBy}.`,
  CreatedDate: generatedAt,
 };

 const data: TallyVoucherValue[][] = [
  [...TALLY_VOUCHER_HEADERS],
  ...rows.map((row) => TALLY_VOUCHER_HEADERS.map((header) => row[header])),
 ];
 const worksheet = XLSX.utils.aoa_to_sheet(data);
 worksheet["!cols"] = [
  { wch: 14 },
  { wch: 22 },
  { wch: 24 },
  { wch: 30 },
  { wch: 18 },
  { wch: 26 },
  { wch: 16 },
  { wch: 20 },
  { wch: 34 },
  { wch: 18 },
  { wch: 14 },
  { wch: 14 },
  { wch: 16 },
 ];
 worksheet["!autofilter"] = { ref: `A1:M${Math.max(1, rows.length + 1)}` };

 XLSX.utils.book_append_sheet(workbook, worksheet, "Inventory Voucher");
 XLSX.writeFile(workbook, filePath, {
  bookType: "xlsx",
  compression: true,
 });
}

export function writeTallyMovementWorkbooks(
 database: StoresDatabase,
 entries: ReviewEntries,
 output: OutputPaths,
): void {
 writeVoucherWorkbook(
  output.materialInPath,
  "Material In - Tally Inventory Voucher",
  buildMaterialInRows(database, entries),
  output.generatedAt,
  output.reviewedBy,
 );

 writeVoucherWorkbook(
  output.materialOutPath,
  "Material Out - Tally Inventory Voucher",
  buildMaterialOutRows(entries),
  output.generatedAt,
  output.reviewedBy,
 );
}
