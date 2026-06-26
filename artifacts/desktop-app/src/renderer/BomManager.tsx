import { Fragment, useMemo, useState } from "react";
import * as XLSX from "xlsx";

import { parseBomWorkbook } from "./bom-import";
import { finishedProductItems, materialStockItems, operationalStockItems } from "./stock-item-visibility";
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
  importedComponentName?: string;
  importedComponentType?: string;
  sourceRow?: number;
}

export default function BomManager({ planning, stores, onChanged, onStoresChanged, onNotice, onError }: Props) {
  const [productGuid, setProductGuid] = useState("");
  const [versionNumber, setVersionNumber] = useState("");
  const [label, setLabel] = useState("");
  const [validFrom, setValidFrom] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<DraftLine[]>([{ componentTallyGuid: "", quantityPerProduct: 1, lossBufferPercent: 0 }]);
  const [importDetails, setImportDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [expandedBom, setExpandedBom] = useState("");
  const selectableItems = useMemo(
    () => operationalStockItems(stores.stockItems),
    [stores.stockItems],
  );

  const products = useMemo(() => {
    const activeBomProducts = new Set(planning.boms.filter((bom) => bom.status === "ACTIVE").map((bom) => bom.productTallyGuid));
    return finishedProductItems(selectableItems).sort((left, right) => {
      const leftPriority = left.hasBom || activeBomProducts.has(left.tallyGuid) ? 1 : 0;
      const rightPriority = right.hasBom || activeBomProducts.has(right.tallyGuid) ? 1 : 0;
      return rightPriority - leftPriority || left.name.localeCompare(right.name);
    });
  }, [selectableItems, planning.boms]);
  const components = useMemo(() => materialStockItems(selectableItems), [selectableItems]);

  async function saveManualBom() {
    if (!productGuid) {
      onError("Select a finished product or assembly.");
      return;
    }
    const validLines = lines.filter((line) => line.componentTallyGuid);
    const unresolvedImported = lines.filter((line) => line.importedComponentName && !line.componentTallyGuid);
    if (unresolvedImported.length > 0) {
      onError(`Match or remove the ${unresolvedImported.length} unresolved imported component${unresolvedImported.length === 1 ? "" : "s"} before creating the BOM.`);
      return;
    }
    if (validLines.length === 0) {
      onError("Add at least one component.");
      return;
    }
    setBusy(true);
    onError("");
    try {
      const state = await window.desktop.planning.saveBom({
        productTallyGuid: productGuid,
        versionNumber: versionNumber ? Number(versionNumber) : undefined,
        label,
        validFrom,
        source: importDetails ? "FILE_IMPORT" : "MANUAL",
        activate: true,
        lines: validLines,
      });
      onChanged(state);
      setVersionNumber("");
      setLabel("");
      setLines([{ componentTallyGuid: "", quantityPerProduct: 1, lossBufferPercent: 0 }]);
      setImportDetails("");
      onNotice("A new active BOM version was created.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function parseFile(file: File) {
    onError("");
    setImportDetails("");
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
      const result = parseBomWorkbook(workbook, selectableItems, file.name);
      const detectedProduct = result.rows.find((row) => row.productGuid)?.productGuid ?? "";
      if (detectedProduct) setProductGuid(detectedProduct);
      if (result.versionNumber) setVersionNumber(String(result.versionNumber));
      setLabel(result.title);
      const importedLines: DraftLine[] = [];
      const matchedByGuid = new Map<string, DraftLine>();
      for (const row of result.rows) {
        const draftLine: DraftLine = {
          componentTallyGuid: row.componentGuid,
          quantityPerProduct: Number.isInteger(row.quantity) && row.quantity > 0 ? row.quantity : 1,
          lossBufferPercent: Number.isFinite(row.lossBufferPercent) ? row.lossBufferPercent : 0,
          importedComponentName: row.sourceComponentName,
          importedComponentType: row.componentType,
          sourceRow: row.rowNumber,
        };
        if (!row.componentGuid) {
          importedLines.push(draftLine);
          continue;
        }
        const existing = matchedByGuid.get(row.componentGuid);
        if (existing) {
          existing.quantityPerProduct += draftLine.quantityPerProduct;
        } else {
          matchedByGuid.set(row.componentGuid, draftLine);
          importedLines.push(draftLine);
        }
      }
      setLines(importedLines);
      setImportDetails(
        `${result.sheetName} · product ${result.productName || "not detected"} · version ${result.versionNumber ?? "not detected"} · ${result.rows.filter((row) => row.componentGuid).length} matched · ${result.rows.filter((row) => !row.componentGuid).length} need manual matching${result.skippedNotFitted ? ` · skipped ${result.skippedNotFitted} NC/DNA row${result.skippedNotFitted === 1 ? "" : "s"}` : ""}`,
      );
      if (result.rows.length === 0) onError("The selected file did not contain any fitted BOM component rows.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
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
      <section className="planning-bom-layout">
        <article className="panel">
          <div className="panel__header">
            <div><p className="eyebrow">PRODUCT DEFINITION</p><h2>Create a BOM version</h2></div>
            <label className="button button--secondary bom-import-button">Import spreadsheet<input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void parseFile(file); event.currentTarget.value = ""; }} /></label>
          </div>
          {importDetails && <div className="import-summary"><strong>Spreadsheet loaded into this BOM draft</strong><span>{importDetails}</span></div>}
          <div className="form-grid form-grid--four">
            <label>Product<select value={productGuid} onChange={(event) => setProductGuid(event.target.value)}><option value="">Select product…</option>{products.map((item) => <option key={item.tallyGuid} value={item.tallyGuid}>{item.qualifiedName}{item.hasBom ? " · Tally BOM" : ""}</option>)}</select></label>
            <label>Version number<input type="number" min={1} step={1} value={versionNumber} onChange={(event) => setVersionNumber(event.target.value)} placeholder="Automatic" /></label>
            <label>Version label<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Standard assembly" /></label>
            <label>Valid from<input type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} /></label>
          </div>
          <div className="bom-line-editor">
            <div className="bom-line-editor__head"><span>Component</span><span>Qty / product</span><span>Loss buffer %</span><span /></div>
            {lines.map((line, index) => <div className="bom-line-editor__row" key={index}>
              <div className="bom-import-draft-component">
                {line.importedComponentName && <small>Row {line.sourceRow}: {line.importedComponentName}{line.importedComponentType ? ` · ${line.importedComponentType}` : ""}</small>}
                <select value={line.componentTallyGuid} onChange={(event) => setLines(lines.map((entry, rowIndex) => rowIndex === index ? { ...entry, componentTallyGuid: event.target.value } : entry))}><option value="">{line.importedComponentName ? "Match imported component…" : "Select component…"}</option>{components.filter((item) => item.tallyGuid !== productGuid).map((item) => <option key={item.tallyGuid} value={item.tallyGuid}>{item.qualifiedName}</option>)}</select>
              </div>
              <input type="number" min={1} step={1} value={line.quantityPerProduct} onChange={(event) => setLines(lines.map((entry, rowIndex) => rowIndex === index ? { ...entry, quantityPerProduct: Number(event.target.value) } : entry))} />
              <input type="number" min={0} max={100} step={0.1} value={line.lossBufferPercent} onChange={(event) => setLines(lines.map((entry, rowIndex) => rowIndex === index ? { ...entry, lossBufferPercent: Number(event.target.value) } : entry))} />
              <button className="icon-button" type="button" aria-label="Remove component" onClick={() => setLines(lines.filter((_, rowIndex) => rowIndex !== index))}>×</button>
            </div>)}
          </div>
          <div className="inline-actions"><button className="button button--secondary" type="button" onClick={() => setLines([...lines, { componentTallyGuid: "", quantityPerProduct: 1, lossBufferPercent: 0 }])}>Add component</button>{importDetails && <button className="button button--ghost" type="button" onClick={() => { setImportDetails(""); setVersionNumber(""); setLabel(""); setLines([{ componentTallyGuid: "", quantityPerProduct: 1, lossBufferPercent: 0 }]); }}>Clear imported draft</button>}<button className="button" disabled={busy} type="button" onClick={() => void saveManualBom()}>Create active version</button></div>
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
