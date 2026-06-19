import { Fragment, useMemo, useState } from "react";
import * as XLSX from "xlsx";

import type { PlanningState, SaveBomInput, StoresState } from "./types";

interface Props {
  planning: PlanningState;
  stores: StoresState;
  onChanged: (state: PlanningState) => void;
  onStoresChanged: (state: StoresState) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

interface DraftLine {
  componentTallyGuid: string;
  quantityPerProduct: number;
  lossBufferPercent: number;
}

interface ParsedBomRow {
  rowNumber: number;
  productName: string;
  componentName: string;
  quantity: number;
  lossBufferPercent: number;
  productGuid: string;
  componentGuid: string;
  error: string;
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function field(row: Record<string, unknown>, aliases: string[]): unknown {
  for (const [key, value] of Object.entries(row)) {
    if (aliases.includes(normalizeHeader(key))) return value;
  }
  return "";
}

export default function BomManager({ planning, stores, onChanged, onStoresChanged, onNotice, onError }: Props) {
  const [productGuid, setProductGuid] = useState("");
  const [label, setLabel] = useState("");
  const [validFrom, setValidFrom] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<DraftLine[]>([{ componentTallyGuid: "", quantityPerProduct: 1, lossBufferPercent: 0 }]);
  const [parsedRows, setParsedRows] = useState<ParsedBomRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [expandedBom, setExpandedBom] = useState("");
  const [localComponentGroup, setLocalComponentGroup] = useState("Local Components");
  const [localProductGroup, setLocalProductGroup] = useState("Local Products");

  const itemByName = useMemo(
    () => new Map(stores.stockItems.map((item) => [item.name.toLocaleLowerCase(), item])),
    [stores.stockItems],
  );
  const products = useMemo(() => {
    const activeBomProducts = new Set(planning.boms.filter((bom) => bom.status === "ACTIVE").map((bom) => bom.productTallyGuid));
    return [...stores.stockItems].sort((left, right) => {
      const leftPriority = left.hasBom || activeBomProducts.has(left.tallyGuid) ? 1 : 0;
      const rightPriority = right.hasBom || activeBomProducts.has(right.tallyGuid) ? 1 : 0;
      return rightPriority - leftPriority || left.name.localeCompare(right.name);
    });
  }, [stores.stockItems, planning.boms]);

  async function saveManualBom() {
    if (!productGuid) {
      onError("Select a finished product or assembly.");
      return;
    }
    const validLines = lines.filter((line) => line.componentTallyGuid);
    if (validLines.length === 0) {
      onError("Add at least one component.");
      return;
    }
    setBusy(true);
    onError("");
    try {
      const state = await window.desktop.planning.saveBom({
        productTallyGuid: productGuid,
        label,
        validFrom,
        source: "MANUAL",
        activate: true,
        lines: validLines,
      });
      onChanged(state);
      setLabel("");
      setLines([{ componentTallyGuid: "", quantityPerProduct: 1, lossBufferPercent: 0 }]);
      onNotice("A new active BOM version was created.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function parseFile(file: File) {
    onError("");
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      const parsed = records.map((row, index): ParsedBomRow => {
        const productName = String(field(row, ["product", "product name", "finished product", "assembly"])).trim();
        const componentName = String(field(row, ["component", "component name", "material", "stock item"])).trim();
        const quantity = Number(field(row, ["quantity", "quantity per product", "qty per product", "component quantity"]));
        const loss = Number(field(row, ["loss buffer", "loss buffer percent", "loss percent", "wastage percent"]) || 0);
        const product = itemByName.get(productName.toLocaleLowerCase());
        const component = itemByName.get(componentName.toLocaleLowerCase());
        const errors: string[] = [];
        if (!productName || !product) errors.push("Product not matched");
        if (!componentName || !component) errors.push("Component not matched");
        if (!Number.isInteger(quantity) || quantity <= 0) errors.push("Quantity must be a positive whole number");
        if (!Number.isFinite(loss) || loss < 0 || loss > 100) errors.push("Loss buffer must be 0–100");
        return {
          rowNumber: index + 2,
          productName,
          componentName,
          quantity,
          lossBufferPercent: loss,
          productGuid: product?.tallyGuid ?? "",
          componentGuid: component?.tallyGuid ?? "",
          error: errors.join("; "),
        };
      });
      setParsedRows(parsed);
      if (parsed.length === 0) onError("The selected file did not contain any BOM rows.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function importRows(createMissingLocally: boolean) {
    let currentStores = stores;
    setBusy(true);
    onError("");
    try {
      if (createMissingLocally) {
        const missingProducts = [...new Set(parsedRows.filter((row) => !row.productGuid && row.productName).map((row) => row.productName))];
        const missingComponents = [...new Set(parsedRows.filter((row) => !row.componentGuid && row.componentName).map((row) => row.componentName))];
        for (const name of missingProducts) {
          currentStores = await window.desktop.stores.createLocalStockItem({ name, parentName: localProductGroup });
        }
        for (const name of missingComponents) {
          currentStores = await window.desktop.stores.createLocalStockItem({ name, parentName: localComponentGroup });
        }
        onStoresChanged(currentStores);
      }

      const refreshedByName = new Map(currentStores.stockItems.map((item) => [item.name.toLocaleLowerCase(), item]));
      const refreshedRows = parsedRows.map((row) => {
        const product = row.productGuid ? currentStores.stockItems.find((item) => item.tallyGuid === row.productGuid) : refreshedByName.get(row.productName.toLocaleLowerCase());
        const component = row.componentGuid ? currentStores.stockItems.find((item) => item.tallyGuid === row.componentGuid) : refreshedByName.get(row.componentName.toLocaleLowerCase());
        const errors: string[] = [];
        if (!product) errors.push("Product not matched");
        if (!component) errors.push("Component not matched");
        if (!Number.isInteger(row.quantity) || row.quantity <= 0) errors.push("Quantity must be a positive whole number");
        if (!Number.isFinite(row.lossBufferPercent) || row.lossBufferPercent < 0 || row.lossBufferPercent > 100) errors.push("Loss buffer must be 0–100");
        return {
          ...row,
          productGuid: product?.tallyGuid ?? "",
          productName: product?.name ?? row.productName,
          componentGuid: component?.tallyGuid ?? "",
          componentName: component?.name ?? row.componentName,
          error: errors.join("; "),
        };
      });
      setParsedRows(refreshedRows);
      const valid = refreshedRows.filter((row) => !row.error);
      if (valid.length === 0) throw new Error("There are no fully matched rows to import.");
      const grouped = new Map<string, ParsedBomRow[]>();
      for (const row of valid) grouped.set(row.productGuid, [...(grouped.get(row.productGuid) ?? []), row]);
      let state = planning;
      for (const [guid, rows] of grouped) {
        const uniqueComponents = new Map(rows.map((row) => [row.componentGuid, row]));
        state = await window.desktop.planning.saveBom({
          productTallyGuid: guid,
          label: `Imported ${new Date().toLocaleDateString("en-IN")}`,
          source: "FILE_IMPORT",
          activate: true,
          lines: [...uniqueComponents.values()].map((row) => ({
            componentTallyGuid: row.componentGuid,
            quantityPerProduct: row.quantity,
            lossBufferPercent: row.lossBufferPercent,
          })),
        });
      }
      onChanged(state);
      setParsedRows([]);
      onNotice(`Imported ${grouped.size} BOM version${grouped.size === 1 ? "" : "s"}.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function activateBom(id: string) {
    setBusy(true);
    onError("");
    try {
      onChanged(await window.desktop.planning.activateBom(id));
      onNotice("BOM version activated. New reservations will use it.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="planning-section-stack">
      <section className="two-column-layout planning-bom-layout">
        <article className="panel">
          <div className="panel__header"><div><p className="eyebrow">PRODUCT DEFINITION</p><h2>Create a BOM version</h2></div></div>
          <div className="form-grid form-grid--three">
            <label>Product<select value={productGuid} onChange={(event) => setProductGuid(event.target.value)}><option value="">Select product…</option>{products.map((item) => <option key={item.tallyGuid} value={item.tallyGuid}>{item.name}{item.hasBom ? " · Tally BOM" : ""}</option>)}</select></label>
            <label>Version label<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Standard assembly" /></label>
            <label>Valid from<input type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} /></label>
          </div>
          <div className="bom-line-editor">
            <div className="bom-line-editor__head"><span>Component</span><span>Qty / product</span><span>Loss buffer %</span><span /></div>
            {lines.map((line, index) => <div className="bom-line-editor__row" key={index}>
              <select value={line.componentTallyGuid} onChange={(event) => setLines(lines.map((entry, rowIndex) => rowIndex === index ? { ...entry, componentTallyGuid: event.target.value } : entry))}><option value="">Select component…</option>{stores.stockItems.filter((item) => item.tallyGuid !== productGuid).map((item) => <option key={item.tallyGuid} value={item.tallyGuid}>{item.name}</option>)}</select>
              <input type="number" min={1} step={1} value={line.quantityPerProduct} onChange={(event) => setLines(lines.map((entry, rowIndex) => rowIndex === index ? { ...entry, quantityPerProduct: Number(event.target.value) } : entry))} />
              <input type="number" min={0} max={100} step={0.1} value={line.lossBufferPercent} onChange={(event) => setLines(lines.map((entry, rowIndex) => rowIndex === index ? { ...entry, lossBufferPercent: Number(event.target.value) } : entry))} />
              <button className="icon-button" type="button" aria-label="Remove component" onClick={() => setLines(lines.filter((_, rowIndex) => rowIndex !== index))}>×</button>
            </div>)}
          </div>
          <div className="inline-actions"><button className="button button--secondary" type="button" onClick={() => setLines([...lines, { componentTallyGuid: "", quantityPerProduct: 1, lossBufferPercent: 0 }])}>Add component</button><button className="button" disabled={busy} type="button" onClick={() => void saveManualBom()}>Create active version</button></div>
        </article>

        <article className="panel">
          <div className="panel__header"><div><p className="eyebrow">IMPORT</p><h2>Upload component lists</h2></div></div>
          <label className="file-drop">Choose BOM spreadsheet<input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void parseFile(file); event.currentTarget.value = ""; }} /></label>
          {parsedRows.length > 0 && <>
            <div className="import-summary"><strong>{parsedRows.filter((row) => !row.error).length} matched</strong><span>{parsedRows.filter((row) => row.error).length} need mapping or correction</span></div>
            <div className="table-scroll import-preview"><table><thead><tr><th>Row</th><th>Product</th><th>Component</th><th>Qty</th><th>Loss</th><th>Result</th></tr></thead><tbody>{parsedRows.map((row) => <tr key={row.rowNumber} className={row.error ? "row-error" : ""}><td>{row.rowNumber}</td><td>{row.productName || "—"}</td><td>{row.componentName || "—"}</td><td>{Number.isFinite(row.quantity) ? row.quantity : "—"}</td><td>{Number.isFinite(row.lossBufferPercent) ? `${row.lossBufferPercent}%` : "—"}</td><td>{row.error || "Matched"}</td></tr>)}</tbody></table></div>
            {parsedRows.some((row) => !row.productGuid || !row.componentGuid) && <div className="local-item-controls"><label>New component group<input value={localComponentGroup} onChange={(event) => setLocalComponentGroup(event.target.value)} /></label><label>New product group<input value={localProductGroup} onChange={(event) => setLocalProductGroup(event.target.value)} /></label><p>Unmatched names can be created locally and linked to Tally later.</p></div>}
            <div className="inline-actions"><button className="button button--secondary" type="button" onClick={() => setParsedRows([])}>Clear preview</button><button className="button button--secondary" disabled={busy || parsedRows.every((row) => row.error)} type="button" onClick={() => void importRows(false)}>Import matched only</button>{parsedRows.some((row) => !row.productGuid || !row.componentGuid) && <button className="button" disabled={busy} type="button" onClick={() => void importRows(true)}>Create missing locally and import</button>}</div>
          </>}
        </article>
      </section>

      <article className="panel table-panel">
        <div className="panel__header"><div><p className="eyebrow">BOM HISTORY</p><h2>Product definitions and versions</h2></div><span className="table-count">{planning.boms.length} versions</span></div>
        <div className="table-scroll planning-bom-history"><table><thead><tr><th>Product</th><th>Version</th><th>Status</th><th>Source</th><th>Valid from</th><th>Components</th><th /></tr></thead><tbody>{planning.boms.map((bom) => <Fragment key={bom.id}>
          <tr key={bom.id}><td><strong>{bom.productName}</strong></td><td>{bom.label} · v{bom.versionNumber}</td><td><span className={`review-status review-status--${bom.status.toLocaleLowerCase()}`}>{bom.status}</span></td><td>{bom.source.replaceAll("_", " ")}</td><td>{bom.validFrom}</td><td>{bom.lines.length}</td><td className="table-actions"><button className="button button--ghost button--small" type="button" onClick={() => setExpandedBom(expandedBom === bom.id ? "" : bom.id)}>{expandedBom === bom.id ? "Hide" : "View"}</button>{bom.status !== "ACTIVE" && <button className="button button--secondary button--small" disabled={busy} type="button" onClick={() => void activateBom(bom.id)}>Activate</button>}</td></tr>
          {expandedBom === bom.id && <tr className="detail-row" key={`${bom.id}-details`}><td colSpan={7}><div className="bom-components-grid">{bom.lines.map((line) => <div key={line.id}><strong>{line.componentName}</strong><span>{line.quantityPerProduct} each{line.lossBufferPercent ? ` + ${line.lossBufferPercent}% loss` : ""}</span></div>)}</div></td></tr>}
        </Fragment>)}{planning.boms.length === 0 && <tr><td colSpan={7} className="empty-table">No BOM versions are available yet.</td></tr>}</tbody></table></div>
      </article>
    </div>
  );
}
