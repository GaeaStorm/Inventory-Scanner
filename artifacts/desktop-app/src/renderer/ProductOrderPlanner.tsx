import { Fragment, useMemo, useState } from "react";
import * as XLSX from "xlsx";

import { operationalStockItems } from "./stock-item-visibility";
import type { PlanningState, SaveProductOrderInput, StoresState } from "./types";

interface Props {
  planning: PlanningState;
  stores: StoresState;
  onChanged: (state: PlanningState) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

interface ParsedOrderRow {
  rowNumber: number;
  productName: string;
  productGuid: string;
  externalReference: string;
  quantity: number;
  requiredDate: string;
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

function normalizedDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (!text) return new Date().toISOString().slice(0, 10);
  const parsed = new Date(text);
  return Number.isNaN(parsed.valueOf()) ? "" : parsed.toISOString().slice(0, 10);
}

const feasibilityLabels: Record<string, string> = {
  READY: "Ready",
  READY_WITH_INCOMING: "Ready with incoming",
  AT_RISK: "At risk",
  SHORT_COMPONENTS: "Short components",
  BOM_INCOMPLETE: "BOM incomplete",
};

export default function ProductOrderPlanner({ planning, stores, onChanged, onNotice, onError }: Props) {
  const [draft, setDraft] = useState<SaveProductOrderInput>({
    externalReference: "",
    productTallyGuid: "",
    quantity: 1,
    requiredDate: new Date().toISOString().slice(0, 10),
    status: "CONFIRMED",
    notes: "",
  });
  const [parsedRows, setParsedRows] = useState<ParsedOrderRow[]>([]);
  const [expanded, setExpanded] = useState("");
  const [busy, setBusy] = useState(false);
  const selectableItems = useMemo(
    () => operationalStockItems(stores.stockItems),
    [stores.stockItems],
  );
  const activeBomProducts = useMemo(
    () => new Set(planning.boms.filter((bom) => bom.status === "ACTIVE").map((bom) => bom.productTallyGuid)),
    [planning.boms],
  );
  const itemByName = useMemo(
    () => new Map(selectableItems.map((item) => [item.name.toLocaleLowerCase(), item])),
    [selectableItems],
  );
  const products = useMemo(
    () => [...selectableItems].sort((left, right) => Number(activeBomProducts.has(right.tallyGuid)) - Number(activeBomProducts.has(left.tallyGuid)) || left.name.localeCompare(right.name)),
    [selectableItems, activeBomProducts],
  );

  async function saveOrder(input = draft) {
    setBusy(true);
    onError("");
    try {
      const state = await window.desktop.planning.saveProductOrder(input);
      onChanged(state);
      setDraft({ ...draft, externalReference: "", quantity: 1, notes: "" });
      onNotice("Product order saved and component reservations recalculated.");
      return state;
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function updateStatus(orderId: string, status: "CANCELLED" | "COMPLETED" | "CONFIRMED") {
    setBusy(true);
    onError("");
    try {
      onChanged(await window.desktop.planning.updateProductOrderStatus(orderId, status));
      onNotice(status === "COMPLETED" ? "Order completed and reservations released." : status === "CANCELLED" ? "Order cancelled and reservations released." : "Order confirmed and reservations recalculated.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function parseFile(file: File) {
    onError("");
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: true });
      const rows = records.map((row, index): ParsedOrderRow => {
        const productName = String(field(row, ["product", "product name", "finished product", "stock item"])).trim();
        const product = itemByName.get(productName.toLocaleLowerCase());
        const quantity = Number(field(row, ["quantity", "order quantity", "qty"]));
        const requiredDate = normalizedDate(field(row, ["required date", "need date", "due date", "date"]));
        const externalReference = String(field(row, ["external reference", "order reference", "order no", "order number", "reference"])).trim();
        const errors: string[] = [];
        if (!product) errors.push("Product not matched");
        if (!Number.isInteger(quantity) || quantity <= 0) errors.push("Quantity must be a positive whole number");
        if (!requiredDate) errors.push("Required date is invalid");
        return { rowNumber: index + 2, productName, productGuid: product?.tallyGuid ?? "", externalReference, quantity, requiredDate, error: errors.join("; ") };
      });
      setParsedRows(rows);
      if (rows.length === 0) onError("The selected file did not contain any product orders.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function importOrders() {
    const valid = parsedRows.filter((row) => !row.error);
    if (valid.length === 0) {
      onError("There are no matched product orders to import.");
      return;
    }
    setBusy(true);
    onError("");
    try {
      let state = planning;
      for (const row of valid) {
        state = await window.desktop.planning.saveProductOrder({
          externalReference: row.externalReference,
          productTallyGuid: row.productGuid,
          quantity: row.quantity,
          requiredDate: row.requiredDate,
          status: "CONFIRMED",
          notes: "Imported from spreadsheet",
        });
      }
      onChanged(state);
      setParsedRows([]);
      onNotice(`Imported ${valid.length} product order${valid.length === 1 ? "" : "s"}.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="planning-section-stack">
      <section className="two-column-layout planning-orders-layout">
        <article className="panel">
          <div className="panel__header"><div><p className="eyebrow">STOCK PLANNING</p><h2>Reserve components</h2></div></div>
          <div className="form-grid form-grid--two">
            <label>Order reference<input value={draft.externalReference} onChange={(event) => setDraft({ ...draft, externalReference: event.target.value })} placeholder="Customer/order reference" /></label>
            <label className="product-select-field">Product<select value={draft.productTallyGuid} onChange={(event) => setDraft({ ...draft, productTallyGuid: event.target.value })}><option value="">Select product…</option>{products.map((item) => <option key={item.tallyGuid} value={item.tallyGuid}>{item.name}{activeBomProducts.has(item.tallyGuid) ? " · BOM ready" : " · no BOM"}</option>)}</select></label>
            <label>Product quantity<input type="number" min={1} step={1} value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: Number(event.target.value) })} /></label>
            <label>Required date<input type="date" value={draft.requiredDate} onChange={(event) => setDraft({ ...draft, requiredDate: event.target.value })} /></label>
            <label className="form-grid__wide">Notes<textarea rows={2} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
          </div>
          <div className="inline-actions"><button className="button button--secondary" type="button" onClick={() => setDraft({ externalReference: "", productTallyGuid: "", quantity: 1, requiredDate: new Date().toISOString().slice(0, 10), status: "CONFIRMED", notes: "" })}>Clear</button><button className="button" disabled={busy || !draft.productTallyGuid} type="button" onClick={() => void saveOrder()}>Confirm and reserve</button></div>
        </article>

        <article className="panel">
          <div className="panel__header"><div><p className="eyebrow">IMPORT</p><h2>Upload product orders</h2></div></div>
          <label className="file-drop">Choose order spreadsheet<input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void parseFile(file); event.currentTarget.value = ""; }} /></label>
          {parsedRows.length > 0 && <>
            <div className="import-summary"><strong>{parsedRows.filter((row) => !row.error).length} ready</strong><span>{parsedRows.filter((row) => row.error).length} need correction</span></div>
            <div className="table-scroll import-preview"><table><thead><tr><th>Row</th><th>Product</th><th>Qty</th><th>Required</th><th>Reference</th><th>Result</th></tr></thead><tbody>{parsedRows.map((row) => <tr key={row.rowNumber} className={row.error ? "row-error" : ""}><td>{row.rowNumber}</td><td>{row.productName || "—"}</td><td>{Number.isFinite(row.quantity) ? row.quantity : "—"}</td><td>{row.requiredDate || "—"}</td><td>{row.externalReference || "—"}</td><td>{row.error || "Ready"}</td></tr>)}</tbody></table></div>
            <div className="inline-actions"><button className="button button--secondary" type="button" onClick={() => setParsedRows([])}>Clear preview</button><button className="button" disabled={busy || parsedRows.every((row) => row.error)} type="button" onClick={() => void importOrders()}>Import confirmed orders</button></div>
          </>}
        </article>
      </section>

      <article className="panel table-panel">
        <div className="panel__header"><div><p className="eyebrow">FEASIBILITY</p><h2>Planned product demand</h2></div><span className="table-count">{planning.productOrders.filter((order) => order.status === "CONFIRMED").length} active</span></div>
        <div className="table-scroll planning-orders-table"><table><thead><tr><th>Reference</th><th>Product</th><th>Qty</th><th>Required</th><th>BOM</th><th>Readiness</th><th>Requirements</th><th /></tr></thead><tbody>{planning.productOrders.map((order) => <Fragment key={order.id}>
          <tr key={order.id}><td>{order.externalReference || <code>{order.id.slice(0, 8)}</code>}</td><td><strong>{order.productName}</strong></td><td>{order.quantity}</td><td>{order.requiredDate}</td><td>{order.bomVersionLabel}</td><td><span className={`order-feasibility order-feasibility--${order.feasibility.toLocaleLowerCase().replaceAll("_", "-")}`}>{feasibilityLabels[order.feasibility]}</span><small className="table-subtext">{order.status}</small></td><td>{order.requirements.length}</td><td className="table-actions"><button className="button button--ghost button--small" type="button" onClick={() => setExpanded(expanded === order.id ? "" : order.id)}>{expanded === order.id ? "Hide" : "Details"}</button>{order.status === "CONFIRMED" && <>{order.feasibility === "BOM_INCOMPLETE" && <button className="button button--secondary button--small" disabled={busy} type="button" onClick={() => void updateStatus(order.id, "CONFIRMED")}>Recalculate</button>}<button className="button button--secondary button--small" disabled={busy} type="button" onClick={() => void updateStatus(order.id, "COMPLETED")}>Complete</button><button className="button button--ghost button--small" disabled={busy} type="button" onClick={() => void updateStatus(order.id, "CANCELLED")}>Cancel</button></>}</td></tr>
          {expanded === order.id && <tr className="detail-row" key={`${order.id}-details`}><td colSpan={8}><div className="table-scroll"><table className="nested-table"><thead><tr><th>Component</th><th className="numeric">Required</th><th className="numeric">Reserved</th><th className="numeric">Available before order</th><th className="numeric">Incoming</th><th className="numeric">Short now</th><th className="numeric">Short after incoming</th></tr></thead><tbody>{order.requirements.map((line) => <tr key={line.componentTallyGuid}><td><strong>{line.componentName}</strong><small className="table-subtext">Loss buffer {line.lossBufferPercent}%</small></td><td className="numeric">{line.requiredQuantity}</td><td className="numeric">{line.reservedQuantity}</td><td className="numeric">{line.availableBeforeOrder}</td><td className="numeric">{line.incomingQuantity}</td><td className="numeric">{line.shortageNow}</td><td className="numeric">{line.shortageAfterIncoming}</td></tr>)}{order.requirements.length === 0 && <tr><td colSpan={7} className="empty-table">This product has no active BOM. Add one in Product Definitions.</td></tr>}</tbody></table></div></td></tr>}
        </Fragment>)}{planning.productOrders.length === 0 && <tr><td colSpan={8} className="empty-table">No product orders have been planned yet.</td></tr>}</tbody></table></div>
      </article>
    </div>
  );
}
