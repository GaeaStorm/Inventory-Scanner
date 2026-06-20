import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const source = "/Users/gaeastorm/Downloads/Akademika_PO_Task_Tracker_Consolidated.xlsx";
const outputDir = "/private/tmp/inventory-kanban-analysis/renders";
await fs.mkdir(outputDir, { recursive: true });

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(source));
const summary = await workbook.inspect({
  kind: "workbook,sheet,table,drawing,definedName",
  maxChars: 20000,
  tableMaxRows: 12,
  tableMaxCols: 30,
  tableMaxCellChars: 120,
});
console.log("SUMMARY");
console.log(summary.ndjson);

const sheetInspect = await workbook.inspect({ kind: "sheet", include: "id,name", maxChars: 10000 });
const sheets = sheetInspect.ndjson
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

for (const entry of sheets) {
  const name = entry.name ?? entry.sheetName;
  if (!name) continue;
  const sheet = workbook.worksheets.getItem(name);
  const used = sheet.getUsedRange();
  console.log(`\nSHEET ${name}`);
  console.log("USED", used?.address ?? "none");
  if (used) {
    const region = await workbook.inspect({
      kind: "region",
      sheetId: name,
      range: used.address,
      maxChars: 30000,
      tableMaxRows: 60,
      tableMaxCols: 40,
      tableMaxCellChars: 180,
    });
    console.log(region.ndjson);
  }
  const safe = name.replaceAll(/[^a-z0-9_-]+/gi, "_");
  const preview = await workbook.render({
    sheetName: name,
    autoCrop: "all",
    scale: 1,
    format: "png",
  });
  await fs.writeFile(`${outputDir}/${safe}.png`, new Uint8Array(await preview.arrayBuffer()));
}
