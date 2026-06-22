import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

import { finishedProductItems } from "./stock-item-visibility";
import type {
  PlanningState,
  ProductOrder,
  ProductOrderFieldType,
  SaveProductOrderInput,
  StoresState,
} from "./types";

interface Props {
  planning: PlanningState;
  stores: StoresState;
  canManage: boolean;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

interface ImportRow {
  rowNumber: number;
  input: SaveProductOrderInput;
  productName: string;
  stateName: string;
  error: string;
}

const emptyOrder = (): SaveProductOrderInput => ({
  fileNumber: "",
  organisation: "",
  externalReference: "",
  purchaseOrderDate: "",
  lastDispatchDate: "",
  productTallyGuid: "",
  quantity: 1,
  pendingQuantity: null,
  valueIncludingGst: null,
  pendingMaterial: "",
  rawMaterialToOrder: "",
  crfStatus: "",
  cracStatus: "",
  taskRemarks: "",
  responsiblePerson: "",
  followUpDate: "",
  dispatchSchedule: "",
  priority: "",
  requiredDate: new Date().toISOString().slice(0, 10),
  status: "CONFIRMED",
  workflowStateId: "",
  notes: "",
  customFields: {},
});

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
}

function spreadsheetDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && value > 20_000) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const parts = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (parts) return `${parts[3]}-${parts[2].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.valueOf()) ? "" : parsed.toISOString().slice(0, 10);
}

function quantity(value: unknown): number {
  const match = String(value ?? "").match(/\d+(?:\.\d+)?/);
  return match ? Math.max(0, Math.round(Number(match[0]))) : 0;
}

function optionalQuantity(value: unknown): number | null {
  const parsed = quantity(value);
  return parsed > 0 ? parsed : null;
}

function optionalNumber(value: unknown): number | null {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value: number | null): string {
  return value == null ? "—" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
}

function dueLabel(value: string): { text: string; overdue: boolean } {
  if (!value) return { text: "No dispatch date", overdue: false };
  const date = new Date(`${value}T00:00:00`);
  const days = Math.ceil((date.valueOf() - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, overdue: true };
  if (days === 0) return { text: "Due today", overdue: false };
  return { text: `Due in ${days}d`, overdue: false };
}

function toDraft(order: ProductOrder): SaveProductOrderInput {
  return {
    id: order.id,
    fileNumber: order.fileNumber,
    organisation: order.organisation,
    externalReference: order.externalReference,
    purchaseOrderDate: order.purchaseOrderDate,
    lastDispatchDate: order.lastDispatchDate,
    productTallyGuid: order.productTallyGuid,
    quantity: order.quantity,
    pendingQuantity: order.pendingQuantity,
    valueIncludingGst: order.valueIncludingGst,
    pendingMaterial: order.pendingMaterial,
    rawMaterialToOrder: order.rawMaterialToOrder,
    crfStatus: order.crfStatus,
    cracStatus: order.cracStatus,
    taskRemarks: order.taskRemarks,
    responsiblePerson: order.responsiblePerson,
    followUpDate: order.followUpDate,
    dispatchSchedule: order.dispatchSchedule,
    priority: order.priority,
    requiredDate: order.requiredDate,
    status: order.status === "DRAFT" ? "DRAFT" : "CONFIRMED",
    workflowStateId: order.workflowStateId,
    notes: order.notes,
    customFields: { ...order.customFields },
  };
}

export default function ProductionOrderKanban({ planning, stores, canManage, onRefresh, onNotice, onError }: Props) {
  const [search, setSearch] = useState("");
  const [owner, setOwner] = useState("");
  const [priority, setPriority] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const [draft, setDraft] = useState<SaveProductOrderInput | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stateName, setStateName] = useState("");
  const [stateColor, setStateColor] = useState("#6B778C");
  const [fieldLabel, setFieldLabel] = useState("");
  const [fieldType, setFieldType] = useState<ProductOrderFieldType>("TEXT");
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [draggedOrderId, setDraggedOrderId] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const products = useMemo(() => {
    const preferred = finishedProductItems(stores.stockItems);
    return (preferred.length ? preferred : stores.stockItems.filter((item) => item.active && !item.ignored))
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [stores.stockItems]);
  const productByName = useMemo(() => {
    const entries = stores.stockItems.filter((item) => item.active && !item.ignored).flatMap((item) => [
      [normalize(item.name), item] as const,
      [normalize(item.tallyName), item] as const,
    ]);
    return new Map(entries);
  }, [stores.stockItems]);
  const owners = [...new Set(planning.productOrders.map((order) => order.responsiblePerson).filter(Boolean))].sort();
  const priorities = [...new Set(planning.productOrders.map((order) => order.priority).filter(Boolean))].sort();
  const visibleOrders = planning.productOrders.filter((order) => {
    const haystack = `${order.fileNumber} ${order.organisation} ${order.externalReference} ${order.productName} ${order.taskRemarks} ${order.responsiblePerson}`.toLocaleLowerCase();
    const workflowState = planning.productOrderWorkflowStates.find((state) => state.id === order.workflowStateId);
    return (!search || haystack.includes(search.toLocaleLowerCase()))
      && (!owner || order.responsiblePerson === owner)
      && (!priority || order.priority === priority)
      && (showClosed || (!workflowState?.terminal && !["COMPLETED", "CANCELLED"].includes(order.status)));
  });
  const totalValue = visibleOrders.reduce((sum, order) => sum + (order.valueIncludingGst ?? 0), 0);
  const overdue = visibleOrders.filter((order) => dueLabel(order.lastDispatchDate || order.requiredDate).overdue).length;

  async function perform(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    onError("");
    try {
      await action();
      await onRefresh();
      onNotice(message);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveOrder() {
    if (!draft?.productTallyGuid) {
      onError("Choose a Tally Stock Item for the product.");
      return;
    }
    await perform(async () => window.desktop.planning.saveProductOrder(draft), draft.id ? "Production order updated." : "Production order added.");
    setDraft(null);
  }

  async function moveOrder(orderId: string, workflowStateId: string) {
    if (!canManage) return;
    const order = planning.productOrders.find((entry) => entry.id === orderId);
    const state = planning.productOrderWorkflowStates.find((entry) => entry.id === workflowStateId);
    if (!order || !state || order.workflowStateId === workflowStateId) return;
    await perform(
      async () => window.desktop.planning.updateProductOrderWorkflowState(orderId, workflowStateId),
      `${order.productName} moved to ${state.name}.`,
    );
  }

  async function deleteWorkflowState(stateId: string, stateName: string) {
    if (!window.confirm(`Delete the workflow state "${stateName}"? Orders must be moved out of it first.`)) return;
    await perform(
      async () => window.desktop.planning.deleteProductOrderWorkflowState(stateId),
      `${stateName} deleted.`,
    );
  }

  async function deleteCustomField(fieldId: string, fieldLabelValue: string) {
    if (!window.confirm(`Delete the custom field "${fieldLabelValue}"? Its saved values will also be removed from all production orders.`)) return;
    await perform(
      async () => window.desktop.planning.deleteProductOrderFieldDefinition(fieldId),
      `${fieldLabelValue} deleted.`,
    );
  }

  async function parseTracker(file: File) {
    onError("");
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames.includes("Order Tracker") ? "Order Tracker" : workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: true });
      let carried = { fileNumber: "", organisation: "", externalReference: "", purchaseOrderDate: "", lastDispatchDate: "" };
      const parsed = rows.map((row, index): ImportRow => {
        const value = (name: string) => row[name] ?? "";
        carried = {
          fileNumber: String(value("File No") || carried.fileNumber).trim(),
          organisation: String(value("Organisation") || carried.organisation).trim(),
          externalReference: String(value("Purchase Order") || carried.externalReference).trim(),
          purchaseOrderDate: spreadsheetDate(value("PO Date")) || carried.purchaseOrderDate,
          lastDispatchDate: spreadsheetDate(value("Last Date of Dispatch")) || carried.lastDispatchDate,
        };
        const productName = String(value("Product Model Details")).trim();
        const product = productByName.get(normalize(productName));
        const stateName = String(value("Dispatch Status") || "Pending").trim();
        const workflowState = planning.productOrderWorkflowStates.find((state) => normalize(state.name) === normalize(stateName))
          ?? planning.productOrderWorkflowStates[0];
        const orderQuantity = quantity(value("PO Qty"));
        const errors: string[] = [];
        if (!productName) errors.push("Product is blank");
        if (!product) errors.push("No matching Tally Stock Item");
        if (orderQuantity < 1) errors.push("Quantity is blank or invalid");
        return {
          rowNumber: index + 2,
          productName,
          stateName,
          error: errors.join("; "),
          input: {
            ...carried,
            productTallyGuid: product?.tallyGuid ?? "",
            quantity: orderQuantity || 1,
            pendingQuantity: optionalQuantity(value("Pending Qty")),
            valueIncludingGst: optionalNumber(value("Value incl. GST 18%")),
            pendingMaterial: String(value("Pending Material to be Dispatched")).trim(),
            rawMaterialToOrder: String(value("Raw Material to be Ordered")).trim(),
            crfStatus: String(value("CRF")).trim(),
            cracStatus: String(value("CRAC Generated")).trim(),
            taskRemarks: String(value("Pending Task / Remarks")).trim(),
            responsiblePerson: String(value("Responsible Person")).trim(),
            followUpDate: spreadsheetDate(value("Follow-up Date")),
            dispatchSchedule: String(value("Dispatch Schedule")).trim(),
            requiredDate: carried.lastDispatchDate || new Date().toISOString().slice(0, 10),
            workflowStateId: workflowState?.id ?? "",
            status: "CONFIRMED",
            notes: String(value("Notes")).trim(),
            customFields: {},
          },
        };
      }).filter((row) => row.productName || row.input.externalReference || row.input.organisation);
      setImportRows(parsed);
      if (!parsed.length) onError("No order rows were found in the selected workbook.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function importTracker() {
    const valid = importRows.filter((row) => !row.error);
    if (!valid.length) {
      onError("There are no matched tracker rows to import.");
      return;
    }
    setBusy(true);
    onError("");
    try {
      for (const row of valid) await window.desktop.planning.saveProductOrder(row.input);
      await onRefresh();
      setImportRows([]);
      onNotice(`Imported ${valid.length} production order line${valid.length === 1 ? "" : "s"} from the tracker.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return <div className="production-board-page">
    <div className="production-board-summary">
      <div><span>Visible product lines</span><strong>{visibleOrders.length}</strong></div>
      <div><span>Line value</span><strong>{money(totalValue)}</strong></div>
      <div><span>Overdue</span><strong className={overdue ? "danger-text" : ""}>{overdue}</strong></div>
      <div><span>At risk / short</span><strong>{visibleOrders.filter((order) => ["AT_RISK", "SHORT_COMPONENTS", "BOM_INCOMPLETE"].includes(order.feasibility)).length}</strong></div>
    </div>

    <div className="production-board-toolbar">
      <input className="production-board-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search PO, customer, product, owner…" />
      <select value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">All owners</option>{owners.map((entry) => <option key={entry}>{entry}</option>)}</select>
      <select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="">All priorities</option>{priorities.map((entry) => <option key={entry}>{entry}</option>)}</select>
      <label className="check-row production-board-closed"><input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} />Show completed</label>
      {canManage && <><details className="production-overflow"><summary aria-label="More production board actions">•••</summary><div><button type="button" onClick={() => fileInput.current?.click()}>Import tracker</button><button type="button" onClick={() => setSettingsOpen(true)}>Fields &amp; states</button></div></details><input ref={fileInput} hidden type="file" accept=".xlsx,.xls,.csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void parseTracker(file); event.currentTarget.value = ""; }} /><button className="button" type="button" onClick={() => setDraft({ ...emptyOrder(), workflowStateId: planning.productOrderWorkflowStates[0]?.id ?? "" })}>+ Add product line</button></>}
    </div>

    {importRows.length > 0 && <div className="production-import-review">
      <div><strong>{importRows.filter((row) => !row.error).length} ready to import</strong><span>{importRows.filter((row) => row.error).length} unmatched rows will be skipped</span></div>
      <div className="production-import-errors">{importRows.filter((row) => row.error).slice(0, 5).map((row) => <span key={row.rowNumber}>Row {row.rowNumber}: {row.productName || "blank product"} — {row.error}</span>)}</div>
      <div className="inline-actions"><button className="button button--ghost" type="button" onClick={() => setImportRows([])}>Cancel</button><button className="button" disabled={busy || importRows.every((row) => row.error)} type="button" onClick={() => void importTracker()}>Import matched rows</button></div>
    </div>}

    <div className="production-kanban" aria-label="Production product-line workflow board">
      {planning.productOrderWorkflowStates.map((state) => {
        const orders = visibleOrders.filter((order) => order.workflowStateId === state.id);
        return <section
          className="production-kanban-column"
          key={state.id}
          onDragOver={(event) => { if (canManage) event.preventDefault(); }}
          onDrop={() => { if (draggedOrderId) void moveOrder(draggedOrderId, state.id); setDraggedOrderId(""); }}
        >
          <header style={{ borderTopColor: state.color }}><div><span className="production-state-dot" style={{ background: state.color }} /><strong>{state.name}</strong></div><span>{orders.length}</span></header>
          <div className="production-kanban-cards">
            {orders.map((order) => {
              const due = dueLabel(order.lastDispatchDate || order.requiredDate);
              const completed = Math.max(0, Math.min(order.quantity, order.quantity - (order.pendingQuantity ?? order.quantity)));
              const percent = order.quantity ? Math.round((completed / order.quantity) * 100) : 0;
              const blocker = order.pendingMaterial || order.rawMaterialToOrder
                || (["AT_RISK", "SHORT_COMPONENTS", "BOM_INCOMPLETE"].includes(order.feasibility) ? "Material shortage" : "");
              return <article
                className="production-order-card"
                key={order.id}
                draggable={canManage}
                onDragStart={() => setDraggedOrderId(order.id)}
                onDragEnd={() => setDraggedOrderId("")}
                onClick={() => setDraft(toDraft(order))}
              >
                <div className="production-card-top"><code>{order.externalReference || order.fileNumber || order.id.slice(0, 8)}</code>{order.priority && <span className={`production-priority production-priority--${order.priority.toLocaleLowerCase()}`}>{order.priority}</span>}</div>
                <h3>{order.productName}</h3>
                <p>{order.organisation || "Organisation not set"}</p>
                <div className="production-card-meta"><span>Qty <strong>{order.quantity}</strong></span><span className={due.overdue ? "danger-text" : ""}>{due.text}</span></div>
                <div className="production-line-progress"><i><b style={{ width: `${percent}%` }} /></i><span>{completed} / {order.quantity} complete</span></div>
                {blocker && <p className="production-card-task">⚠ {blocker}</p>}
                <footer><span>{order.responsiblePerson || "Unassigned"}</span><span className={due.overdue ? "danger-text" : blocker ? "warning-text" : ""}>{due.overdue ? "● Overdue" : blocker ? "● Blocked" : "● Active"}</span></footer>
              </article>;
            })}
            {orders.length === 0 && <div className="production-column-empty">Drop product lines here</div>}
          </div>
        </section>;
      })}
    </div>

    {draft && <div className="production-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDraft(null); }}>
      <section className="production-modal" role="dialog" aria-modal="true" aria-label={draft.id ? "Edit product line" : "Add product line"}>
        <header><div><p className="eyebrow">{draft.id ? "PRODUCT LINE DETAIL" : "NEW PRODUCT LINE"}</p><h2>{draft.id ? draft.externalReference || "Product line" : "Add product line"}</h2></div><button className="icon-button" type="button" onClick={() => setDraft(null)} aria-label="Close">×</button></header>
        <div className="production-modal-body">
          <div className="production-form-grid">
            <label>File no.<input value={draft.fileNumber ?? ""} onChange={(event) => setDraft({ ...draft, fileNumber: event.target.value })} /></label>
            <label>Organisation<input value={draft.organisation ?? ""} onChange={(event) => setDraft({ ...draft, organisation: event.target.value })} /></label>
            <label>Purchase order<input value={draft.externalReference} onChange={(event) => setDraft({ ...draft, externalReference: event.target.value })} /></label>
            <label>PO date<input type="date" value={draft.purchaseOrderDate ?? ""} onChange={(event) => setDraft({ ...draft, purchaseOrderDate: event.target.value })} /></label>
            <label>Last dispatch date<input type="date" value={draft.lastDispatchDate ?? ""} onChange={(event) => setDraft({ ...draft, lastDispatchDate: event.target.value, requiredDate: event.target.value || draft.requiredDate })} /></label>
            <label>Workflow state<select value={draft.workflowStateId ?? ""} onChange={(event) => setDraft({ ...draft, workflowStateId: event.target.value })}>{planning.productOrderWorkflowStates.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}</select></label>
            <label className="production-form-wide">Product / Tally Stock Item<select value={draft.productTallyGuid} onChange={(event) => setDraft({ ...draft, productTallyGuid: event.target.value })}><option value="">Select product…</option>{products.map((product) => <option key={product.tallyGuid} value={product.tallyGuid}>{product.name} · {[product.primaryGroupName, product.secondaryGroupName].filter(Boolean).join(" › ") || "Ungrouped"}</option>)}</select></label>
            <label>PO quantity<input type="number" min={1} step={1} value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: Number(event.target.value) })} /></label>
            <label>Pending quantity<input type="number" min={0} step={1} value={draft.pendingQuantity ?? ""} onChange={(event) => setDraft({ ...draft, pendingQuantity: event.target.value === "" ? null : Number(event.target.value) })} /></label>
            <label>Value incl. GST<input type="number" min={0} step="0.01" value={draft.valueIncludingGst ?? ""} onChange={(event) => setDraft({ ...draft, valueIncludingGst: event.target.value === "" ? null : Number(event.target.value) })} /></label>
            <label>Priority<select value={draft.priority ?? ""} onChange={(event) => setDraft({ ...draft, priority: event.target.value })}><option value="">Not set</option><option>High</option><option>Medium</option><option>Low</option></select></label>
            <label>Responsible person<input value={draft.responsiblePerson ?? ""} onChange={(event) => setDraft({ ...draft, responsiblePerson: event.target.value })} /></label>
            <label>Follow-up date<input type="date" value={draft.followUpDate ?? ""} onChange={(event) => setDraft({ ...draft, followUpDate: event.target.value })} /></label>
            <label>CRF<select value={draft.crfStatus ?? ""} onChange={(event) => setDraft({ ...draft, crfStatus: event.target.value })}><option value="">Not set</option><option>Pending</option><option>Signed</option><option>Sent</option><option>Not Required</option></select></label>
            <label>CRAC<select value={draft.cracStatus ?? ""} onChange={(event) => setDraft({ ...draft, cracStatus: event.target.value })}><option value="">Not set</option><option>Pending</option><option>Generated</option><option>Sent</option><option>Received</option><option>Not Required</option></select></label>
            <label className="production-form-wide">Pending material to dispatch<textarea rows={2} value={draft.pendingMaterial ?? ""} onChange={(event) => setDraft({ ...draft, pendingMaterial: event.target.value })} /></label>
            <label className="production-form-wide">Raw material to order<textarea rows={2} value={draft.rawMaterialToOrder ?? ""} onChange={(event) => setDraft({ ...draft, rawMaterialToOrder: event.target.value })} /></label>
            <label className="production-form-wide">Pending task / remarks<textarea rows={2} value={draft.taskRemarks ?? ""} onChange={(event) => setDraft({ ...draft, taskRemarks: event.target.value })} /></label>
            <label className="production-form-wide">Dispatch schedule<input value={draft.dispatchSchedule ?? ""} onChange={(event) => setDraft({ ...draft, dispatchSchedule: event.target.value })} /></label>
            <label className="production-form-wide">Notes<textarea rows={3} value={draft.notes ?? ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
            {planning.productOrderFieldDefinitions.map((field) => <label key={field.id} className={field.type === "TEXT" ? "production-form-wide" : ""}>{field.label}{field.type === "BOOLEAN"
              ? <input type="checkbox" checked={Boolean(draft.customFields?.[field.key])} onChange={(event) => setDraft({ ...draft, customFields: { ...draft.customFields, [field.key]: event.target.checked } })} />
              : <input type={field.type === "NUMBER" ? "number" : field.type === "DATE" ? "date" : "text"} value={String(draft.customFields?.[field.key] ?? "")} onChange={(event) => setDraft({ ...draft, customFields: { ...draft.customFields, [field.key]: field.type === "NUMBER" ? Number(event.target.value) : event.target.value } })} />}</label>)}
          </div>
          {draft.id && <aside className="production-tally-panel"><p className="eyebrow">TALLY + STORES</p><h3>Live readiness</h3>{(() => { const order = planning.productOrders.find((entry) => entry.id === draft.id); return order ? <><dl><div><dt>Stock Item</dt><dd>{order.productName}</dd></div><div><dt>BOM</dt><dd>{order.bomVersionLabel}</dd></div><div><dt>Readiness</dt><dd>{order.feasibility.replaceAll("_", " ")}</dd></div><div><dt>Components</dt><dd>{order.requirements.length}</dd></div></dl><div className="production-requirement-list">{order.requirements.filter((line) => line.shortageNow > 0).slice(0, 6).map((line) => <span key={line.componentTallyGuid}>{line.componentName}<strong>{line.shortageNow} short</strong></span>)}{order.requirements.length > 0 && order.requirements.every((line) => line.shortageNow === 0) && <p>All BOM requirements are currently covered.</p>}</div></> : null; })()}</aside>}
        </div>
        <footer><button className="button button--secondary" type="button" onClick={() => setDraft(null)}>Cancel</button><button className="button" disabled={busy || !canManage || !draft.productTallyGuid} type="button" onClick={() => void saveOrder()}>Save product line</button></footer>
      </section>
    </div>}

    {settingsOpen && <div className="production-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
      <section className="production-modal production-settings-modal" role="dialog" aria-modal="true" aria-label="Configure fields and states">
        <header><div><p className="eyebrow">BOARD CONFIGURATION</p><h2>Fields & states</h2></div><button className="icon-button" type="button" onClick={() => setSettingsOpen(false)} aria-label="Close">×</button></header>
        <div className="production-settings-grid">
          <div><h3>Workflow states</h3><div className="production-config-list">{planning.productOrderWorkflowStates.map((state) => <span key={state.id}><i style={{ background: state.color }} /><b>{state.name}</b>{state.terminal && <small>Terminal</small>}<button className="production-config-delete" type="button" disabled={busy || planning.productOrderWorkflowStates.length <= 1} onClick={() => void deleteWorkflowState(state.id, state.name)} aria-label={`Delete ${state.name}`}>Delete</button></span>)}</div><div className="production-config-form"><label>State name<input value={stateName} onChange={(event) => setStateName(event.target.value)} placeholder="e.g. Quality check" /></label><label>Color<input type="color" value={stateColor} onChange={(event) => setStateColor(event.target.value)} /></label><button className="button" disabled={busy || !stateName.trim()} type="button" onClick={() => void perform(async () => window.desktop.planning.saveProductOrderWorkflowState({ name: stateName, color: stateColor }), "Workflow state added.").then(() => setStateName(""))}>Add state</button></div></div>
          <div><h3>Custom fields</h3><div className="production-config-list">{planning.productOrderFieldDefinitions.map((field) => <span key={field.id}><b>{field.label}</b><small>{field.type.toLocaleLowerCase()}</small><button className="production-config-delete" type="button" disabled={busy} onClick={() => void deleteCustomField(field.id, field.label)} aria-label={`Delete ${field.label}`}>Delete</button></span>)}{planning.productOrderFieldDefinitions.length === 0 && <p>No custom fields yet. The standard tracker fields are already included.</p>}</div><div className="production-config-form"><label>Field label<input value={fieldLabel} onChange={(event) => setFieldLabel(event.target.value)} placeholder="e.g. Customer contact" /></label><label>Type<select value={fieldType} onChange={(event) => setFieldType(event.target.value as ProductOrderFieldType)}><option value="TEXT">Text</option><option value="NUMBER">Number</option><option value="DATE">Date</option><option value="BOOLEAN">Checkbox</option></select></label><button className="button" disabled={busy || !fieldLabel.trim()} type="button" onClick={() => void perform(async () => window.desktop.planning.saveProductOrderFieldDefinition({ label: fieldLabel, type: fieldType }), "Custom order field added.").then(() => setFieldLabel(""))}>Add field</button></div></div>
        </div>
      </section>
    </div>}
  </div>;
}
