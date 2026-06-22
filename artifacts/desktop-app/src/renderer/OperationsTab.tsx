import { useMemo, useState, type ReactNode } from "react";

import type {
  AuthState,
  ConditionBalance,
  OperationsMovement,
  OperationsState,
  Permission,
  PlanningState,
  StockCondition,
  StoresState,
  SupplierFaultRecord,
  UserRole,
} from "./types";
import OrderRegister from "./OrderRegister";
import ProductionOrderKanban from "./ProductionOrderKanban";
import { traceabilityColumns } from "./traceability";

type Section = "overview" | "inspection" | "faults" | "counts" | "returns" | "production" | "exceptions" | "history" | "users";

interface Props {
  stores: StoresState;
  planning: PlanningState;
  operations: OperationsState;
  auth: AuthState;
  permissions: Permission[];
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

const sectionLabels: Array<{ id: Section; label: string; permission?: Permission }> = [
  { id: "overview", label: "Stock conditions" },
  { id: "inspection", label: "Receiving inspection", permission: "INSPECT_STOCK" },
  { id: "faults", label: "Supplier faults" },
  { id: "counts", label: "Stock counts", permission: "STOCK_COUNT" },
  { id: "returns", label: "Returns & scrap" },
  { id: "production", label: "Production execution", permission: "PRODUCTION_EXECUTE" },
  { id: "exceptions", label: "Sync exceptions", permission: "SYNC_EXCEPTION_RESOLVE" },
  { id: "history", label: "Movement history" },
  { id: "users", label: "Users", permission: "AUTH_MANAGE_USERS" },
];

function clientId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function label(value: unknown): string {
  return String(value ?? "")
    .toLocaleLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toLocaleUpperCase());
}

function dateTime(value: unknown): string {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.valueOf()) ? String(value ?? "—") : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function Status({ value }: { value: unknown }) {
  const code = String(value ?? "unknown").toLocaleLowerCase().replaceAll("_", "-");
  return <span className={`review-status review-status--${code}`}>{label(value)}</span>;
}

function SummaryCard({ title, value, note }: { title: string; value: number; note?: string }) {
  return <div className="operations-summary-card"><span>{title}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}

function ItemPicker({ stores, value, onChange, labelText = "Stock item", includeInactive = true, role }: {
  stores: StoresState;
  value: string;
  onChange: (value: string) => void;
  labelText?: string;
  includeInactive?: boolean;
  role?: "FINISHED_PRODUCT" | "MATERIAL";
}) {
  const [search, setSearch] = useState("");
  const items = stores.stockItems.filter((item) => !item.ignored && (includeInactive || item.active))
    .filter((item) => role === "FINISHED_PRODUCT" ? item.catalogRole === "FINISHED_PRODUCT" : role === "MATERIAL" ? item.catalogRole !== "FINISHED_PRODUCT" : true)
    .filter((item) =>
    !search.trim() || `${item.name} ${item.primaryGroupName} ${item.secondaryGroupName}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <div className="search-picker"><label>{labelText}<input placeholder="Filter items…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><select aria-label={labelText} value={value} onChange={(event) => onChange(event.target.value)}><option value="">Select…</option>{items.map((item) => <option key={item.tallyGuid} value={item.tallyGuid}>{item.name} · {[item.primaryGroupName, item.secondaryGroupName].filter(Boolean).join(" › ") || "Ungrouped"}</option>)}</select></div>;
}

function SupplierPicker({ stores, value, onChange }: { stores: StoresState; value: string; onChange: (value: string) => void }) {
  const [search, setSearch] = useState("");
  const suppliers = stores.suppliers.filter((supplier) => !search.trim() || supplier.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <div className="search-picker"><label>Supplier<input placeholder="Filter suppliers…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><select aria-label="Supplier" value={value} onChange={(event) => onChange(event.target.value)}><option value="">Select…</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></div>;
}

function LotPicker({ balances, tallyItemGuid, condition, value, onChange, includeAllConditions = false }: {
  balances: ConditionBalance[];
  tallyItemGuid: string;
  condition?: string;
  value: string;
  onChange: (value: string) => void;
  includeAllConditions?: boolean;
}) {
  const lots = balances.filter((entry) => (!tallyItemGuid || entry.tallyItemGuid === tallyItemGuid)
    && (includeAllConditions || !condition || entry.condition === condition));
  return <label>Supplier lot<select value={value} onChange={(event) => onChange(event.target.value)}><option value="">Auto-select / unknown provenance</option>{lots.map((entry) => <option key={`${entry.lotId}:${entry.condition}`} value={entry.lotId}>{entry.itemName} · {entry.supplierName || "Unknown supplier"} · {entry.grnNumber || entry.sourceReference || "Local lot"} · {label(entry.condition)} {entry.quantity}{entry.batchNumber ? ` · Batch ${entry.batchNumber}` : ""}</option>)}</select></label>;
}

function SerialField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label>Serial numbers<textarea rows={2} placeholder="One per line or comma-separated" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function serials(value: string): string[] {
  return value.split(/[\n,;]+/).map((entry) => entry.trim()).filter(Boolean);
}

function OperationPanel({ eyebrow, title, children, actions }: { eyebrow: string; title: string; children: ReactNode; actions?: ReactNode }) {
  return <article className="panel operations-panel"><div className="panel__header"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>{actions}</div>{children}</article>;
}

export default function OperationsTab({ stores, planning, operations, auth, permissions, onRefresh, onNotice, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const [productView, setProductView] = useState<"register" | "board">("register");

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    onError("");
    try {
      await action();
      await onRefresh();
      onNotice(message);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return <section className="tab-page operations-page">
    <div className="page-heading"><div><p className="eyebrow">CUSTOMER ORDERS</p><h1>Orders &amp; Production</h1></div><button className="button button--secondary" type="button" onClick={() => void onRefresh()}>Refresh</button></div>
    <nav className="planning-subnav" aria-label="Orders and production sections">
      <button type="button" className={productView === "register" ? "planning-subnav__active" : ""} onClick={() => setProductView("register")}>Order Register</button>
      <button type="button" className={productView === "board" ? "planning-subnav__active" : ""} onClick={() => setProductView("board")}>Production Board</button>
    </nav>
    {productView === "register"
      ? <OrderRegister
          planning={planning}
          stores={stores}
          canManage={permissions.includes("PRODUCT_ORDER_MANAGE")}
          onRefresh={onRefresh}
          onNotice={onNotice}
          onError={onError}
        />
      : <ProductionOrderKanban
          planning={planning}
          stores={stores}
          canManage={permissions.includes("PRODUCT_ORDER_MANAGE")}
          onRefresh={onRefresh}
          onNotice={onNotice}
          onError={onError}
        />}
  </section>;
}

function Overview({ stores, operations }: { stores: StoresState; operations: OperationsState }) {
  const [item, setItem] = useState("");
  const [condition, setCondition] = useState("");
  const [expiry, setExpiry] = useState("");
  const rows = operations.balances.filter((entry) => (!item || entry.tallyItemGuid === item)
    && (!condition || entry.condition === condition)
    && (!expiry || (expiry === "EXPIRED" ? entry.expired : entry.expiringSoon)));
  const columns = traceabilityColumns(rows);
  const showBatch = columns.batch;
  const showSerial = columns.serial;
  const showExpiry = columns.expiry;
  const showSupplierLot = columns.supplierLot;
  return <div className="planning-section-stack">
    <div className="operations-summary-grid">
      <SummaryCard title="Available" value={operations.reports.available} note="Eligible for FIFO and production" />
      <SummaryCard title="Pending inspection" value={operations.reports.pendingInspection} />
      <SummaryCard title="Faulty" value={operations.reports.faulty} />
      <SummaryCard title="Expired" value={operations.reports.expired} note="No automatic disposal" />
      <SummaryCard title="Expiring soon" value={operations.reports.expiringSoon} />
      <SummaryCard title="Serialized" value={operations.reports.serialized} />
      <SummaryCard title="Open supplier faults" value={operations.reports.unresolvedFaults} />
      <SummaryCard title="Sync exceptions" value={operations.reports.unresolvedSyncExceptions} />
    </div>
    <OperationPanel eyebrow="CONDITION REPORT" title="On-hand stock by supplier lot">
      <div className="operations-filters"><ItemPicker stores={stores} value={item} onChange={setItem} /><label>Condition<select value={condition} onChange={(event) => setCondition(event.target.value)}><option value="">All on-hand conditions</option><option>AVAILABLE</option><option>PENDING_INSPECTION</option><option>FAULTY</option></select></label><label>Expiry<select value={expiry} onChange={(event) => setExpiry(event.target.value)}><option value="">All dates</option><option value="EXPIRED">Expired</option><option value="EXPIRING">Expiring within 30 days</option></select></label></div>
      <div className="table-scroll"><table><thead><tr><th>Item</th><th>Group</th><th>Condition</th><th>Qty</th><th>Supplier</th><th>GRN / receipt</th>{showBatch && <th>Batch</th>}{showSerial && <th>Serials</th>}{showExpiry && <th>Expiry</th>}{showSupplierLot && <th>Supplier lot</th>}</tr></thead><tbody>{rows.map((row) => <tr key={`${row.lotId}:${row.condition}`}><td>{row.itemName}</td><td>{row.itemGroup}</td><td><Status value={row.condition} /></td><td>{row.quantity}</td><td>{row.supplierName || "Unknown"}</td><td>{row.grnNumber || row.sourceReference || "—"}</td>{showBatch && <td>{row.batchNumber || "—"}</td>}{showSerial && <td>{row.serialNumbers.join(", ") || "—"}</td>}{showExpiry && <td>{row.expiryDate ? <span className={row.expired ? "expiry-warning" : row.expiringSoon ? "expiry-soon" : ""}>{row.expiryDate}</span> : "—"}</td>}{showSupplierLot && <td>{row.supplierLotReference || "—"}</td>}</tr>)}{rows.length === 0 && <tr><td colSpan={10} className="empty-table">No matching on-hand stock.</td></tr>}</tbody></table></div>
    </OperationPanel>
  </div>;
}

function Inspection({ stores, operations, busy, run }: { stores: StoresState; operations: OperationsState; busy: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<void> }) {
  const first = operations.balances.find((entry) => entry.condition === "PENDING_INSPECTION") ?? operations.balances[0];
  const [item, setItem] = useState(first?.tallyItemGuid ?? "");
  const [lotId, setLotId] = useState(first?.lotId ?? "");
  const [from, setFrom] = useState<"AVAILABLE" | "PENDING_INSPECTION" | "FAULTY">((first?.condition as any) ?? "PENDING_INSPECTION");
  const [to, setTo] = useState<StockCondition>("AVAILABLE");
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [serialText, setSerialText] = useState("");
  const pendingRows = operations.balances.filter((entry) => entry.condition === "PENDING_INSPECTION");

  function chooseItem(value: string) {
    setItem(value);
    const balance = operations.balances.find((entry) => entry.tallyItemGuid === value && entry.condition === from);
    setLotId(balance?.lotId ?? "");
  }


  return <div className="planning-section-stack">
    <OperationPanel eyebrow="RECEIVING INSPECTION" title="Pending material">
      <div className="table-scroll"><table><thead><tr><th>Item</th><th>Qty pending</th><th>Supplier</th><th>Receipt</th><th>Tracking</th></tr></thead><tbody>{pendingRows.map((row) => <tr key={row.lotId}><td>{row.itemName}</td><td>{row.quantity}</td><td>{row.supplierName || "Unknown"}</td><td>{row.grnNumber || row.sourceReference}</td><td>{[row.batchNumber && `Batch ${row.batchNumber}`, row.serialNumbers.length && `${row.serialNumbers.length} serials`, row.expiryDate && `Expiry ${row.expiryDate}`].filter(Boolean).join(" · ") || "—"}</td></tr>)}{pendingRows.length === 0 && <tr><td colSpan={5} className="empty-table">No stock is awaiting inspection.</td></tr>}</tbody></table></div>
    </OperationPanel>
    <OperationPanel eyebrow="CONDITION MOVEMENT" title="Complete inspection or reclassify stock">
      <form className="operations-form" onSubmit={(event) => { event.preventDefault(); void run(() => window.desktop.operations.transitionCondition({ clientTransactionId: clientId("condition"), tallyItemGuid: item, lotId, quantity, fromCondition: from, toCondition: to, reason, notes, serialNumbers: serials(serialText), faultDiscoveryPoint: to === "FAULTY" ? "IN_STORES" : undefined }), "Stock condition updated."); }}>
        <ItemPicker stores={stores} value={item} onChange={chooseItem} />
        <label>From condition<select value={from} onChange={(event) => { const next = event.target.value as typeof from; setFrom(next); setLotId(operations.balances.find((entry) => entry.tallyItemGuid === item && entry.condition === next)?.lotId ?? ""); }}><option>AVAILABLE</option><option>PENDING_INSPECTION</option><option>FAULTY</option></select></label>
        <LotPicker balances={operations.balances} tallyItemGuid={item} condition={from} value={lotId} onChange={setLotId} />
        <label>Quantity<input type="number" min={1} step={1} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} /></label>
        <label>New condition<select value={to} onChange={(event) => setTo(event.target.value as StockCondition)}><option>AVAILABLE</option><option>PENDING_INSPECTION</option><option>FAULTY</option><option>RETURNED_TO_SUPPLIER</option><option>SCRAPPED</option></select></label>
        <label>Reason<input value={reason} onChange={(event) => setReason(event.target.value)} required /></label>
        <SerialField value={serialText} onChange={setSerialText} />
        <label className="operations-form-wide">Notes<textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <div className="operations-form-actions"><button className="button" disabled={busy || !item || !lotId} type="submit">Record condition movement</button></div>
      </form>
    </OperationPanel>
  </div>;
}

function Faults({ stores, operations, busy, permissions, run }: { stores: StoresState; operations: OperationsState; busy: boolean; permissions: Permission[]; run: (action: () => Promise<unknown>, message: string) => Promise<void> }) {
  const [supplier, setSupplier] = useState("");
  const [itemFilter, setItemFilter] = useState("");
  const [status, setStatus] = useState("");
  const [resolutionFilter, setResolutionFilter] = useState("");
  const [reference, setReference] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const faults = operations.faults.filter((fault) => (!supplier || String(fault.supplierId ?? "") === supplier)
    && (!itemFilter || fault.tallyItemGuid === itemFilter)
    && (!status || fault.status === status)
    && (!resolutionFilter || fault.currentResolution === resolutionFilter)
    && (!reference || `${fault.receiptReference} ${fault.purchaseOrderReference} ${fault.challanReference}`.toLocaleLowerCase().includes(reference.toLocaleLowerCase()))
    && (!dateFrom || fault.dateDiscovered >= dateFrom) && (!dateTo || fault.dateDiscovered <= dateTo));
  const [selected, setSelected] = useState(operations.faults.find((fault) => fault.unresolvedQuantity > 0)?.id ?? "");
  const selectedFault = operations.faults.find((fault) => fault.id === selected) ?? null;
  const [quantity, setQuantity] = useState(1);
  const [resolution, setResolution] = useState("PENDING");
  const [resolutionReference, setResolutionReference] = useState("");
  const [notes, setNotes] = useState("");
  const [serialText, setSerialText] = useState("");
  const [newItem, setNewItem] = useState("");
  const [lotId, setLotId] = useState("");
  const [newQuantity, setNewQuantity] = useState(1);
  const [discovery, setDiscovery] = useState("IN_STORES");
  const [reason, setReason] = useState("");
  const canDiscover = permissions.includes("MARK_FAULTY");
  const resolutionOptions = [
    permissions.includes("MARK_FAULTY") && "PENDING",
    permissions.includes("SUPPLIER_RETURN") && "RETURNED_TO_SUPPLIER",
    permissions.includes("PURCHASING_MANAGE") && "REPLACEMENT_EXPECTED",
    permissions.includes("RECEIVE_MATERIAL") && "REPLACEMENT_RECEIVED",
    permissions.includes("PURCHASING_MANAGE") && "CREDIT_NOTE_EXPECTED",
    permissions.includes("PURCHASING_MANAGE") && "CREDIT_NOTE_RECEIVED",
    permissions.includes("SCRAP_STOCK") && "SCRAPPED",
    permissions.includes("INSPECT_STOCK") && "ACCEPTED_BACK_INTO_AVAILABLE",
    permissions.includes("PURCHASING_MANAGE") && "CLOSED_WITHOUT_FURTHER_ACTION",
  ].filter((entry): entry is string => Boolean(entry));
  const canResolve = resolutionOptions.length > 0;

  return <div className="planning-section-stack">
    {canDiscover && <OperationPanel eyebrow="FAULT DISCOVERY" title="Record faulty supplier material">
      <form className="operations-form" onSubmit={(event) => { event.preventDefault(); void run(() => window.desktop.operations.createFault({ clientTransactionId: clientId("fault"), tallyItemGuid: newItem, lotId: lotId || undefined, sourceCondition: "AVAILABLE", quantity: newQuantity, discoveryPoint: discovery as any, faultReason: reason, notes, serialNumbers: serials(serialText) }), "Supplier fault recorded."); }}>
        <ItemPicker stores={stores} value={newItem} onChange={(value) => { setNewItem(value); setLotId(operations.balances.find((entry) => entry.tallyItemGuid === value && entry.condition === "AVAILABLE")?.lotId ?? ""); }} />
        <LotPicker balances={operations.balances} tallyItemGuid={newItem} condition="AVAILABLE" value={lotId} onChange={setLotId} />
        <label>Quantity<input type="number" min={1} step={1} value={newQuantity} onChange={(event) => setNewQuantity(Number(event.target.value))} /></label>
        <label>Discovered<select value={discovery} onChange={(event) => setDiscovery(event.target.value)}><option value="AT_RECEIPT">At receipt</option><option value="IN_STORES">In stores</option><option value="DURING_PRODUCTION">During production</option><option value="AFTER_PRODUCTION_RETURN">After production return</option><option value="AFTER_CUSTOMER_RETURN">After customer return</option></select></label>
        <label>Fault reason<input value={reason} onChange={(event) => setReason(event.target.value)} required /></label><SerialField value={serialText} onChange={setSerialText} />
        <div className="operations-form-actions"><button className="button" disabled={busy || !newItem} type="submit">Mark faulty</button></div>
      </form>
    </OperationPanel>}
    <OperationPanel eyebrow="SUPPLIER FAULT REPORT" title="Fault lifecycle and recurrence">
      <div className="operations-filters"><SupplierPicker stores={stores} value={supplier} onChange={setSupplier} /><ItemPicker stores={stores} value={itemFilter} onChange={setItemFilter} /><label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All</option><option>OPEN</option><option>PARTIALLY_RESOLVED</option><option>RESOLVED</option><option>CLOSED</option></select></label><label>Resolution<select value={resolutionFilter} onChange={(event) => setResolutionFilter(event.target.value)}><option value="">All</option>{["PENDING","RETURNED_TO_SUPPLIER","REPLACEMENT_EXPECTED","REPLACEMENT_RECEIVED","CREDIT_NOTE_EXPECTED","CREDIT_NOTE_RECEIVED","SCRAPPED","ACCEPTED_BACK_INTO_AVAILABLE","CLOSED_WITHOUT_FURTHER_ACTION"].map((entry) => <option key={entry}>{entry}</option>)}</select></label><label>Receipt / PO<input value={reference} onChange={(event) => setReference(event.target.value)} /></label><label>From<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label>To<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div>
      <div className="table-scroll"><table><thead><tr><th>Discovered</th><th>Supplier</th><th>Item</th><th>Total</th><th>Open</th><th>Where</th><th>Reason</th><th>Receipt / PO</th><th>Status</th></tr></thead><tbody>{faults.map((fault) => <tr key={fault.id} className={selected === fault.id ? "selected-row" : ""} onClick={() => { setSelected(fault.id); setQuantity(Math.max(1, fault.unresolvedQuantity)); }}><td>{fault.dateDiscovered}</td><td>{fault.supplierName || "Unknown"}</td><td>{fault.itemName}</td><td>{fault.quantity}</td><td>{fault.unresolvedQuantity}</td><td>{label(fault.discoveryPoint)}</td><td>{fault.faultReason}</td><td>{[fault.receiptReference, fault.purchaseOrderReference].filter(Boolean).join(" / ") || "—"}</td><td><Status value={fault.status} /></td></tr>)}{faults.length === 0 && <tr><td colSpan={9} className="empty-table">No matching supplier faults.</td></tr>}</tbody></table></div>
      <div className="fault-summary-grid">{operations.faultSummary.slice(0, 20).map((summary) => <div key={`${summary.supplierId}:${summary.tallyItemGuid}`}><strong>{summary.supplierName || "Unknown supplier"}</strong><span>{summary.itemName}: {summary.totalFaulty} faulty · {summary.unresolved} open</span></div>)}</div>
    </OperationPanel>
    {selectedFault && canResolve && <OperationPanel eyebrow="PARTIAL RESOLUTION" title={`${selectedFault.itemName} · ${selectedFault.unresolvedQuantity} unresolved`}>
      <form className="operations-form" onSubmit={(event) => { event.preventDefault(); void run(() => window.desktop.operations.resolveFault({ clientTransactionId: clientId("fault-resolution"), faultId: selectedFault.id, quantity, resolution: (resolutionOptions.includes(resolution) ? resolution : resolutionOptions[0]) as any, reference: resolutionReference, notes, expectedVersion: selectedFault.version, serialNumbers: serials(serialText) }), "Fault resolution recorded."); }}>
        <label>Quantity<input type="number" min={1} max={selectedFault.unresolvedQuantity} step={1} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} /></label>
        <label>Resolution<select value={resolutionOptions.includes(resolution) ? resolution : (resolutionOptions[0] ?? "")} onChange={(event) => setResolution(event.target.value)}>{resolutionOptions.map((entry) => <option key={entry}>{entry}</option>)}</select></label>
        <label>Reference<input value={resolutionReference} onChange={(event) => setResolutionReference(event.target.value)} /></label><SerialField value={serialText} onChange={setSerialText} /><label className="operations-form-wide">Notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <div className="operations-form-actions"><button className="button" disabled={busy || quantity > selectedFault.unresolvedQuantity} type="submit">Record resolution</button></div>
      </form>
      {selectedFault.resolutions.length > 0 && <div className="table-scroll"><table><thead><tr><th>Date</th><th>Resolution</th><th>Qty</th><th>Reference</th><th>Recorded by</th></tr></thead><tbody>{selectedFault.resolutions.map((entry) => <tr key={entry.id}><td>{dateTime(entry.recordedAt)}</td><td>{label(entry.resolution)}</td><td>{entry.quantity}</td><td>{entry.reference || "—"}</td><td>{entry.recordedBy}</td></tr>)}</tbody></table></div>}
    </OperationPanel>}
  </div>;
}

function Counts({ stores, operations, busy, canFinalize, run }: { stores: StoresState; operations: OperationsState; busy: boolean; canFinalize: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"FULL" | "CYCLE">("CYCLE");
  const [cycleItem, setCycleItem] = useState("");
  const [includeAvailable, setIncludeAvailable] = useState(true);
  const [includeFaulty, setIncludeFaulty] = useState(true);
  const [selected, setSelected] = useState(operations.countDetails.find((entry) => entry.status !== "FINALIZED")?.id ?? operations.countDetails[0]?.id ?? "");
  const detail = operations.countDetails.find((entry) => entry.id === selected) ?? null;
  const [entryItem, setEntryItem] = useState("");
  const [entryCondition, setEntryCondition] = useState<"AVAILABLE" | "FAULTY">("AVAILABLE");
  const [counted, setCounted] = useState(0);
  const [reason, setReason] = useState("COUNT_SURPLUS");
  const [notes, setNotes] = useState("");

  return <div className="planning-section-stack">
    <OperationPanel eyebrow="STOCKTAKE" title="Start a count session">
      <form className="operations-form" onSubmit={(event) => { event.preventDefault(); void run(async () => { const next = await window.desktop.operations.createCount({ clientTransactionId: clientId("count"), name, scope, tallyItemGuids: scope === "CYCLE" ? [cycleItem] : undefined, includeAvailable, includeFaulty }); setSelected(next.id); }, "Count session created."); }}>
        <label>Session name<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Scope<select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="FULL">Full stocktake</option><option value="CYCLE">Selected-item cycle count</option></select></label>{scope === "CYCLE" && <ItemPicker stores={stores} value={cycleItem} onChange={setCycleItem} />}<label className="check-row"><input type="checkbox" checked={includeAvailable} onChange={(event) => setIncludeAvailable(event.target.checked)} />Available stock</label><label className="check-row"><input type="checkbox" checked={includeFaulty} onChange={(event) => setIncludeFaulty(event.target.checked)} />Faulty stock</label><div className="operations-form-actions"><button className="button" disabled={busy || !name || (scope === "CYCLE" && !cycleItem)} type="submit">Create draft session</button></div>
      </form>
    </OperationPanel>
    <OperationPanel eyebrow="COUNT SESSIONS" title="Drafts, recounts, and finalization">
      <div className="table-scroll"><table><thead><tr><th>Name</th><th>Scope</th><th>Started</th><th>Lines</th><th>Counted</th><th>Variance</th><th>Later movements</th><th>Status</th></tr></thead><tbody>{operations.countSessions.map((session) => <tr key={session.id} className={selected === session.id ? "selected-row" : ""} onClick={() => setSelected(session.id)}><td>{session.name}</td><td>{session.scope}</td><td>{dateTime(session.startedAt)}</td><td>{session.itemCount}</td><td>{session.countedLines}</td><td>{session.varianceUnits}</td><td>{session.movementsAfterSnapshot > 0 ? <span className="expiry-warning">{session.movementsAfterSnapshot}</span> : 0}</td><td><Status value={session.status} /></td></tr>)}</tbody></table></div>
    </OperationPanel>
    {detail && <OperationPanel eyebrow="COUNT WORKSHEET" title={detail.name} actions={canFinalize && detail.status !== "FINALIZED" ? <button className="button" disabled={busy || detail.lines.some((line) => line.countedQuantity == null)} type="button" onClick={() => void run(() => window.desktop.operations.finalizeCount({ clientTransactionId: clientId("finalize-count"), sessionId: detail.id, expectedVersion: detail.version }), "Count finalized and adjustment movements created.")}>Finalize count</button> : undefined}>
      {detail.movementsAfterSnapshot > 0 && <div className="alert alert--warning">{detail.movementsAfterSnapshot} stock movement{detail.movementsAfterSnapshot === 1 ? " occurred" : "s occurred"} after the snapshot. Current expected quantities and variances include those movements.</div>}
      <div className="table-scroll"><table><thead><tr><th>Item</th><th>Condition</th><th>Snapshot</th><th>Post-snapshot</th><th>Current expected</th><th>Counted</th><th>Variance</th><th>Entries</th><th>Reason</th></tr></thead><tbody>{detail.lines.map((line) => <tr key={`${line.tallyItemGuid}:${line.condition}`} className={entryItem === line.tallyItemGuid && entryCondition === line.condition ? "selected-row" : ""} onClick={() => { setEntryItem(line.tallyItemGuid); setEntryCondition(line.condition); setCounted(line.countedQuantity ?? line.currentExpected); }}><td>{line.itemName}</td><td>{line.condition}</td><td>{line.snapshotExpected}</td><td>{line.postSnapshotMovement}</td><td>{line.currentExpected}</td><td>{line.countedQuantity ?? "—"}</td><td>{line.variance ?? "—"}</td><td>{line.entryCount}</td><td>{line.reason ? label(line.reason) : "—"}</td></tr>)}</tbody></table></div>
      {detail.status !== "FINALIZED" && <form className="operations-form operations-form-compact" onSubmit={(event) => { event.preventDefault(); void run(() => window.desktop.operations.recordCount({ clientTransactionId: clientId("count-entry"), sessionId: detail.id, tallyItemGuid: entryItem, condition: entryCondition, countedQuantity: counted, reason: reason as any, notes, expectedVersion: detail.version }), "Count entry saved. A later entry for the same line is treated as a recount."); }}>
        <ItemPicker stores={stores} value={entryItem} onChange={setEntryItem} /><label>Condition<select value={entryCondition} onChange={(event) => setEntryCondition(event.target.value as typeof entryCondition)}><option>AVAILABLE</option><option>FAULTY</option></select></label><label>Counted quantity<input type="number" min={0} step={1} value={counted} onChange={(event) => setCounted(Number(event.target.value))} /></label><label>Reason<select value={reason} onChange={(event) => setReason(event.target.value)}>{["COUNT_SURPLUS","COUNT_SHORTAGE","DAMAGED_OR_FAULTY","EXPIRED","DATA_ENTRY_CORRECTION","UNRECORDED_RECEIPT","UNRECORDED_ISSUE","RECOVERED_STOCK","OPENING_STOCK_CORRECTION","OTHER"].map((entry) => <option key={entry}>{entry}</option>)}</select></label><label>Notes<input value={notes} required={reason === "OTHER"} onChange={(event) => setNotes(event.target.value)} /></label><div className="operations-form-actions"><button className="button" disabled={busy || !entryItem} type="submit">Save count / recount</button></div>
      </form>}
    </OperationPanel>}
  </div>;
}

function ReturnsAndScrap({ stores, planning, operations, busy, permissions, run }: { stores: StoresState; planning: PlanningState; operations: OperationsState; busy: boolean; permissions: Permission[]; run: (action: () => Promise<unknown>, message: string) => Promise<void> }) {
  const initialMode: "production" | "supplier" | "customer" | "scrap" = permissions.includes("PRODUCTION_RETURN") ? "production"
    : permissions.includes("SUPPLIER_RETURN") ? "supplier"
      : (permissions.includes("CUSTOMER_RETURN_INITIATE") || permissions.includes("CUSTOMER_RETURN_RECEIVE")) ? "customer" : "scrap";
  const [mode, setMode] = useState<"production" | "supplier" | "customer" | "scrap">(initialMode);
  const [item, setItem] = useState("");
  const [lotId, setLotId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [condition, setCondition] = useState<"AVAILABLE" | "PENDING_INSPECTION" | "FAULTY">("AVAILABLE");
  const [target, setTarget] = useState<"AVAILABLE" | "PENDING_INSPECTION" | "FAULTY">("AVAILABLE");
  const [reference, setReference] = useState("");
  const [productOrderId, setProductOrderId] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [serialText, setSerialText] = useState("");
  const [faultId, setFaultId] = useState("");
  const [replacementStatus, setReplacementStatus] = useState("PENDING");
  const [creditStatus, setCreditStatus] = useState("PENDING");
  const [transactionDate, setTransactionDate] = useState("");
  const [customerReturnId, setCustomerReturnId] = useState("");
  const customerRows = operations.customerReturns as Array<any>;

  const canMode = (next: typeof mode) => next === "production" ? permissions.includes("PRODUCTION_RETURN") : next === "supplier" ? permissions.includes("SUPPLIER_RETURN") : next === "customer" ? (permissions.includes("CUSTOMER_RETURN_INITIATE") || permissions.includes("CUSTOMER_RETURN_RECEIVE")) : permissions.includes("SCRAP_STOCK");
  const modes = (["production","supplier","customer","scrap"] as const).filter(canMode);


  async function updateSupplierFollowUp(entry: any) {
    const replacement = window.prompt("Replacement status (PENDING, EXPECTED, RECEIVED, NOT_EXPECTED):", String(entry.replacementStatus || "PENDING"));
    if (replacement === null) return;
    const credit = window.prompt("Credit status (PENDING, EXPECTED, RECEIVED, NOT_EXPECTED):", String(entry.creditStatus || "PENDING"));
    if (credit === null) return;
    const followUpNotes = window.prompt("Follow-up notes:", String(entry.notes || ""));
    if (followUpNotes === null) return;
    await window.desktop.operations.updateSupplierReturn({
      returnId: String(entry.id),
      replacementStatus: replacement.trim().toLocaleUpperCase(),
      creditStatus: credit.trim().toLocaleUpperCase(),
      notes: followUpNotes.trim(),
      expectedVersion: Number(entry.version ?? 1),
    });
  }

  async function submit() {
    if (mode === "production") {
      await window.desktop.operations.productionReturn({ clientTransactionId: clientId("production-return"), tallyItemGuid: item, quantity, originalMovementId: reference || undefined, productOrderId: productOrderId || undefined, lotId: lotId || undefined, targetCondition: target, explanation: reference ? undefined : notes, eventDate: transactionDate || undefined, serialNumbers: serials(serialText) });
    } else if (mode === "supplier") {
      await window.desktop.operations.supplierReturn({ clientTransactionId: clientId("supplier-return"), tallyItemGuid: item, quantity, lotId, sourceCondition: condition, faultId: faultId || undefined, supplierReturnReference: reference, returnDate: transactionDate || undefined, notes, replacementStatus, creditStatus, serialNumbers: serials(serialText) });
    } else if (mode === "scrap") {
      await window.desktop.operations.scrap({ clientTransactionId: clientId("scrap"), tallyItemGuid: item, quantity, lotId: lotId || undefined, sourceCondition: condition, productOrderId: productOrderId || undefined, reason, notes, faultId: faultId || undefined, eventDate: transactionDate || undefined, serialNumbers: serials(serialText) });
    } else if (customerReturnId) {
      await window.desktop.operations.receiveCustomerReturn({ clientTransactionId: clientId("customer-return-receipt"), returnId: customerReturnId, condition: target, serialNumbers: serials(serialText), traceabilityNotes: notes });
    } else {
      await window.desktop.operations.initiateCustomerReturn({ clientTransactionId: clientId("customer-return"), externalReference: reference, tallyItemGuid: item, quantity, notes, serialNumbers: serials(serialText) });
    }
  }

  return <div className="planning-section-stack">
    <OperationPanel eyebrow="RETURNS & WRITE-OFF" title="Choose a distinct inventory workflow">
      <div className="operations-mode-tabs">{modes.map((entry) => <button type="button" key={entry} className={mode === entry ? "active" : ""} onClick={() => setMode(entry)}>{label(entry)}</button>)}</div>
      {modes.length > 0 ? <form className="operations-form" onSubmit={(event) => { event.preventDefault(); void run(submit, `${label(mode)} recorded.`); }}>
        {mode === "customer" && customerRows.some((row) => row.status === "AWAITING_STORE_RECEIPT") && <label>Receive an initiated return<select value={customerReturnId} onChange={(event) => setCustomerReturnId(event.target.value)}><option value="">Create a new sales return request</option>{customerRows.filter((row) => row.status === "AWAITING_STORE_RECEIPT").map((row) => <option key={String(row.id)} value={String(row.id)}>{String(row.externalReference)} · {String(row.itemName)} × {Number(row.quantity)}</option>)}</select></label>}
        {!(mode === "customer" && customerReturnId) && <ItemPicker stores={stores} value={item} onChange={(value) => { setItem(value); setLotId(operations.balances.find((entry) => entry.tallyItemGuid === value && entry.condition === condition)?.lotId ?? ""); }} />}
        {mode !== "customer" && <LotPicker balances={operations.balances} tallyItemGuid={item} condition={condition} value={lotId} onChange={setLotId} />}
        {!(mode === "customer" && customerReturnId) && <label>Quantity<input type="number" min={1} step={1} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} /></label>}
        {(mode === "supplier" || mode === "scrap") && <label>Source condition<select value={condition} onChange={(event) => setCondition(event.target.value as typeof condition)}><option>AVAILABLE</option><option>PENDING_INSPECTION</option><option>FAULTY</option></select></label>}
        {(mode === "production" || mode === "customer") && <label>Receive into<select value={target} onChange={(event) => setTarget(event.target.value as typeof target)}><option>AVAILABLE</option><option>PENDING_INSPECTION</option><option>FAULTY</option></select></label>}
        {mode === "production" && <><label>Original issue movement<input placeholder="Optional movement ID" value={reference} onChange={(event) => setReference(event.target.value)} /></label><label>Product order<select value={productOrderId} onChange={(event) => setProductOrderId(event.target.value)}><option value="">Unlinked</option>{planning.productOrders.map((entry) => <option key={entry.id} value={entry.id}>{entry.externalReference} · {entry.productName}</option>)}</select></label></>}
        {mode === "supplier" && <><label>Supplier return reference<input value={reference} onChange={(event) => setReference(event.target.value)} required /></label><label>Linked supplier fault<select value={faultId} onChange={(event) => setFaultId(event.target.value)}><option value="">None</option>{operations.faults.filter((fault) => fault.unresolvedQuantity > 0 && (!item || fault.tallyItemGuid === item)).map((fault) => <option key={fault.id} value={fault.id}>{fault.id} · {fault.itemName} · {fault.unresolvedQuantity} unresolved</option>)}</select></label><label>Replacement status<select value={replacementStatus} onChange={(event) => setReplacementStatus(event.target.value)}><option>PENDING</option><option>EXPECTED</option><option>RECEIVED</option><option>NOT_EXPECTED</option></select></label><label>Credit status<select value={creditStatus} onChange={(event) => setCreditStatus(event.target.value)}><option>PENDING</option><option>EXPECTED</option><option>RECEIVED</option><option>NOT_EXPECTED</option></select></label></>}
        {mode === "customer" && !customerReturnId && <label>Sales / customer reference<input value={reference} onChange={(event) => setReference(event.target.value)} required /></label>}
        {mode === "scrap" && <><label>Scrap reason<input value={reason} onChange={(event) => setReason(event.target.value)} required /></label><label>Product order<select value={productOrderId} onChange={(event) => setProductOrderId(event.target.value)}><option value="">None</option>{planning.productOrders.map((entry) => <option key={entry.id} value={entry.id}>{entry.externalReference} · {entry.productName}</option>)}</select></label><label>Linked supplier fault<select value={faultId} onChange={(event) => setFaultId(event.target.value)}><option value="">None</option>{operations.faults.filter((fault) => fault.unresolvedQuantity > 0 && (!item || fault.tallyItemGuid === item)).map((fault) => <option key={fault.id} value={fault.id}>{fault.id} · {fault.unresolvedQuantity} unresolved</option>)}</select></label></>}
        {mode !== "customer" || customerReturnId ? <label>Date<input type="date" value={transactionDate} onChange={(event) => setTransactionDate(event.target.value)} /></label> : null}<SerialField value={serialText} onChange={setSerialText} /><label className="operations-form-wide">Notes / explanation<textarea value={notes} onChange={(event) => setNotes(event.target.value)} required={mode === "production" && !reference} /></label><div className="operations-form-actions"><button className="button" disabled={busy || (!(mode === "customer" && customerReturnId) && !item)} type="submit">Record {label(mode)}</button></div>
      </form> : <p className="empty-state">Your role can review return and scrap history but cannot record physical inventory movements.</p>}
    </OperationPanel>
    <OperationPanel eyebrow="RETURN & SCRAP HISTORY" title="Completed terminal and return movements">
      <div className="table-scroll"><table><thead><tr><th>Date</th><th>Type</th><th>Item</th><th>Qty</th><th>Condition</th><th>Product order</th><th>Operator</th></tr></thead><tbody>{operations.movements.filter((entry) => ["PRODUCTION_RETURN","SUPPLIER_RETURN","CUSTOMER_RETURN_RECEIPT","SCRAP"].includes(entry.movementType)).map((entry) => <tr key={entry.id}><td>{entry.eventDate}</td><td>{label(entry.movementType)}</td><td>{entry.itemName}</td><td>{entry.quantity}</td><td>{entry.targetCondition || entry.sourceCondition || "—"}</td><td>{entry.productOrderId || "—"}</td><td>{entry.operator}</td></tr>)}</tbody></table></div>
    </OperationPanel>
    <OperationPanel eyebrow="SUPPLIER RETURN REPORT" title="Replacement and credit follow-up">
      <div className="table-scroll"><table><thead><tr><th>Date</th><th>Supplier</th><th>Return reference</th><th>Fault</th><th>Replacement</th><th>Credit</th><th>Notes</th>{permissions.includes("PURCHASING_MANAGE") && <th>Follow-up</th>}</tr></thead><tbody>{(operations.supplierReturns as Array<any>).map((entry) => <tr key={String(entry.id)}><td>{String(entry.returnDate || "—")}</td><td>{String(entry.supplierName || "Unknown")}</td><td>{String(entry.supplierReturnReference || "—")}</td><td>{String(entry.faultId || "—")}</td><td><Status value={entry.replacementStatus || "PENDING"} /></td><td><Status value={entry.creditStatus || "PENDING"} /></td><td>{String(entry.notes || "—")}</td>{permissions.includes("PURCHASING_MANAGE") && <td><button className="button button--small button--secondary" type="button" disabled={busy} onClick={() => void run(() => updateSupplierFollowUp(entry), "Supplier-return follow-up updated.")}>Update</button></td>}</tr>)}{operations.supplierReturns.length === 0 && <tr><td colSpan={8} className="empty-table">No supplier returns recorded.</td></tr>}</tbody></table></div>
    </OperationPanel>
  </div>;
}


function Production({ stores, planning, operations, busy, run }: { stores: StoresState; planning: PlanningState; operations: OperationsState; busy: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<void> }) {
  const [orderId, setOrderId] = useState(planning.productOrders.find((order) => !["COMPLETED","CANCELLED"].includes(order.status))?.id ?? "");
  const order = planning.productOrders.find((entry) => entry.id === orderId);
  const execution = operations.productionExecutions.find((entry) => entry.productOrderId === orderId);
  const [component, setComponent] = useState("");
  const [destination, setDestination] = useState(order?.productTallyGuid ?? "");
  const [issueQty, setIssueQty] = useState(1);
  const [substitution, setSubstitution] = useState("");
  const [additional, setAdditional] = useState(false);
  const [issueSerialText, setIssueSerialText] = useState("");
  const [finishedItem, setFinishedItem] = useState(order?.productTallyGuid ?? "");
  const [completed, setCompleted] = useState(1);
  const [available, setAvailable] = useState(1);
  const [pending, setPending] = useState(0);
  const [faulty, setFaulty] = useState(0);
  const [batch, setBatch] = useState("");
  const [supplierLotReference, setSupplierLotReference] = useState("");
  const [availableSerialText, setAvailableSerialText] = useState("");
  const [pendingSerialText, setPendingSerialText] = useState("");
  const [faultySerialText, setFaultySerialText] = useState("");
  const [manufacturingDate, setManufacturingDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [notes, setNotes] = useState("");

  return <div className="planning-section-stack">
    <OperationPanel eyebrow="PRODUCT ORDER EXECUTION" title="Release, issue, return, scrap, and complete">
      <div className="operations-filters"><label>Product order<select value={orderId} onChange={(event) => { const next = event.target.value; setOrderId(next); const selected = planning.productOrders.find((entry) => entry.id === next); setDestination(selected?.productTallyGuid ?? ""); setFinishedItem(selected?.productTallyGuid ?? ""); }}><option value="">Select…</option>{planning.productOrders.map((entry) => <option key={entry.id} value={entry.id}>{entry.externalReference} · {entry.productName} × {entry.quantity}</option>)}</select></label>{order && <div className="operations-order-summary"><strong>{order.productName}</strong><span>{order.quantity} planned · due {order.requiredDate || "not set"}</span><Status value={execution?.status ?? order.status} /></div>}</div>
      {orderId && <div className="inline-actions"><button className="button" disabled={busy || !!execution && execution.status !== "PLANNED"} type="button" onClick={() => void run(() => window.desktop.operations.releaseProductOrder({ clientTransactionId: clientId("release-order"), productOrderId: orderId, notes }), "Product order released.")}>Release order</button><button className="button button--secondary" disabled={busy} type="button" onClick={() => void run(() => window.desktop.operations.setProductOrderStatus({ clientTransactionId: clientId("close-order"), productOrderId: orderId, status: "CLOSED", notes }), "Product order closed.")}>Close</button><button className="button button--danger" disabled={busy} type="button" onClick={() => void run(() => window.desktop.operations.setProductOrderStatus({ clientTransactionId: clientId("cancel-order"), productOrderId: orderId, status: "CANCELLED", notes }), "Product order cancelled. Issued stock remains auditable and must be returned or consumed.")}>Cancel</button></div>}
    </OperationPanel>
    {orderId && <div className="operations-two-column">
      <OperationPanel eyebrow="COMPONENT ISSUE" title="Partial, additional, or substituted material">
        <form className="operations-form operations-form-single" onSubmit={(event) => { event.preventDefault(); void run(() => window.desktop.operations.issueProductionMaterial({ clientTransactionId: clientId("production-issue"), productOrderId: orderId, tallyItemGuid: component, destinationTallyItemGuid: destination || order?.productTallyGuid || "", quantity: issueQty, substitutionForTallyGuid: substitution || undefined, additionalConsumption: additional, notes, serialNumbers: serials(issueSerialText) }), "Production-linked material issued."); }}>
          <ItemPicker stores={stores} value={component} onChange={setComponent} labelText="Component" role="MATERIAL" /><ItemPicker stores={stores} value={destination} onChange={setDestination} labelText="Destination product" role="FINISHED_PRODUCT" /><label>Quantity<input type="number" min={1} step={1} value={issueQty} onChange={(event) => setIssueQty(Number(event.target.value))} /></label><ItemPicker stores={stores} value={substitution} onChange={setSubstitution} labelText="Substitution for (optional)" role="MATERIAL" /><label className="check-row"><input type="checkbox" checked={additional} onChange={(event) => setAdditional(event.target.checked)} />Additional consumption beyond BOM</label><SerialField value={issueSerialText} onChange={setIssueSerialText} /><label>Notes<input value={notes} onChange={(event) => setNotes(event.target.value)} required={additional || !!substitution} /></label><button className="button" disabled={busy || !component} type="submit">Issue material</button>
        </form>
      </OperationPanel>
      <OperationPanel eyebrow="FINISHED GOODS" title="Partial production completion">
        <form className="operations-form operations-form-single" onSubmit={(event) => { event.preventDefault(); void run(() => window.desktop.operations.productionCompletion({ clientTransactionId: clientId("production-completion"), productOrderId: orderId, tallyItemGuid: finishedItem, completedQuantity: completed, availableQuantity: available, pendingInspectionQuantity: pending, faultyQuantity: faulty, batchNumber: batch, supplierLotReference, availableSerialNumbers: serials(availableSerialText), pendingSerialNumbers: serials(pendingSerialText), faultySerialNumbers: serials(faultySerialText), manufacturingDate, expiryDate, traceabilityNotes: notes }), "Finished goods received into inventory."); }}>
          <ItemPicker stores={stores} value={finishedItem} onChange={setFinishedItem} labelText="Finished product" role="FINISHED_PRODUCT" /><label>Total completed<input type="number" min={1} step={1} value={completed} onChange={(event) => setCompleted(Number(event.target.value))} /></label><label>Available<input type="number" min={0} step={1} value={available} onChange={(event) => setAvailable(Number(event.target.value))} /></label><label>Pending inspection<input type="number" min={0} step={1} value={pending} onChange={(event) => setPending(Number(event.target.value))} /></label><label>Faulty output<input type="number" min={0} step={1} value={faulty} onChange={(event) => setFaulty(Number(event.target.value))} /></label><label>Batch<input value={batch} onChange={(event) => setBatch(event.target.value)} /></label><label>Supplier / maker lot<input value={supplierLotReference} onChange={(event) => setSupplierLotReference(event.target.value)} /></label><label>Available serials<textarea value={availableSerialText} onChange={(event) => setAvailableSerialText(event.target.value)} placeholder="Comma or line separated" /></label><label>Pending serials<textarea value={pendingSerialText} onChange={(event) => setPendingSerialText(event.target.value)} placeholder="Comma or line separated" /></label><label>Faulty serials<textarea value={faultySerialText} onChange={(event) => setFaultySerialText(event.target.value)} placeholder="Comma or line separated" /></label><label>Manufactured<input type="date" value={manufacturingDate} onChange={(event) => setManufacturingDate(event.target.value)} /></label><label>Expiry<input type="date" value={expiryDate} onChange={(event) => setExpiryDate(event.target.value)} /></label><label>Traceability notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label><button className="button" disabled={busy || !finishedItem || available + pending + faulty !== completed} type="submit">Receive finished goods</button>
        </form>
      </OperationPanel>
    </div>}
    {execution && <OperationPanel eyebrow="EXPECTED VS ACTUAL" title={`${execution.productName} · ${execution.externalReference}`}>
      <div className="operations-summary-grid"><SummaryCard title="Ordered" value={execution.orderedQuantity} /><SummaryCard title="Finished" value={execution.finishedQuantity} /><SummaryCard title="Faulty output" value={execution.faultyFinishedQuantity} /></div>
      <div className="table-scroll"><table><thead><tr><th>Component</th><th>BOM expected</th><th>Reserved</th><th>Issued</th><th>Returned</th><th>Scrapped</th><th>Net consumed</th><th>Variance</th></tr></thead><tbody>{execution.expectedComponents.map((entry) => <tr key={entry.tallyItemGuid}><td>{entry.itemName}</td><td>{entry.expectedQuantity}</td><td>{entry.reservedQuantity}</td><td>{entry.issuedQuantity}</td><td>{entry.returnedQuantity}</td><td>{entry.scrappedQuantity}</td><td>{entry.netConsumed}</td><td>{entry.variance}</td></tr>)}{execution.expectedComponents.length === 0 && <tr><td colSpan={8} className="empty-table">No active BOM component expectations are available for this order.</td></tr>}</tbody></table></div>
    </OperationPanel>}
  </div>;
}

function Exceptions({ operations, busy, run }: { operations: OperationsState; busy: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<void> }) {
  const [selected, setSelected] = useState(operations.syncExceptions.find((entry) => entry.status === "OPEN")?.id ?? "");
  const exception = operations.syncExceptions.find((entry) => entry.id === selected) ?? null;
  const [action, setAction] = useState("RETRY");
  const [notes, setNotes] = useState("");
  const [corrected, setCorrected] = useState("");
  return <div className="planning-section-stack">
    <OperationPanel eyebrow="OFFLINE & SYNCHRONIZATION" title="Transactions requiring a business decision">
      <div className="table-scroll"><table><thead><tr><th>Received</th><th>Device</th><th>Operator</th><th>Operation</th><th>Item</th><th>Requested</th><th>Available</th><th>Reason</th><th>Status</th></tr></thead><tbody>{operations.syncExceptions.map((entry) => <tr key={entry.id} className={selected === entry.id ? "selected-row" : ""} onClick={() => setSelected(entry.id)}><td>{dateTime(entry.serverTimestamp)}</td><td>{entry.deviceId}</td><td>{entry.operator || "—"}</td><td>{entry.operationType}</td><td>{entry.itemName || "—"}</td><td>{entry.requestedQuantity}</td><td>{entry.availableQuantity}</td><td>{entry.reason}</td><td><Status value={entry.status} /></td></tr>)}{operations.syncExceptions.length === 0 && <tr><td colSpan={9} className="empty-table">No synchronization exceptions.</td></tr>}</tbody></table></div>
    </OperationPanel>
    {exception?.status === "OPEN" && <OperationPanel eyebrow="RESOLUTION" title={exception.clientTransactionId}>
      <form className="operations-form" onSubmit={(event) => { event.preventDefault(); let correctedPayload: Record<string, unknown> | undefined; if (corrected.trim()) { try { correctedPayload = JSON.parse(corrected) as Record<string, unknown>; } catch { correctedPayload = undefined; } } void run(() => window.desktop.operations.resolveSyncException({ clientTransactionId: clientId("resolve-sync"), exceptionId: exception.id, action: action as any, notes, correctedPayload, expectedVersion: exception.version }), "Synchronization exception resolved."); }}>
        <label>Action<select value={action} onChange={(event) => setAction(event.target.value)}><option value="RETRY">Retry</option><option value="APPLY_AFTER_MISSING_RECEIPT">Apply after recording missing receipt</option><option value="AUTHORIZED_SHORTAGE">Authorized shortage / negative-stock correction</option><option value="REDUCE_TO_AVAILABLE">Reduce to available; retain remainder exception</option><option value="CANCEL">Cancel transaction</option><option value="REPLACE_WITH_CORRECTED">Replace with corrected transaction</option></select></label><label className="operations-form-wide">Resolution notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} required /></label>{action === "REPLACE_WITH_CORRECTED" && <label className="operations-form-wide">Corrected payload JSON<textarea rows={6} value={corrected} onChange={(event) => setCorrected(event.target.value)} /></label>}<div className="operations-form-actions"><button className="button" disabled={busy} type="submit">Apply resolution</button></div>
      </form>
      <details className="movement-detail"><summary>Original requested movement</summary><pre>{JSON.stringify(exception.originalPayload, null, 2)}</pre></details>
    </OperationPanel>}
  </div>;
}

function History({ stores, operations, busy, canReverse, canReview, run }: { stores: StoresState; operations: OperationsState; busy: boolean; canReverse: boolean; canReview: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<void> }) {
  const [item, setItem] = useState(""); const [primaryGroup, setPrimaryGroup] = useState(""); const [secondaryGroup, setSecondaryGroup] = useState(""); const [supplier, setSupplier] = useState(""); const [productOrder, setProductOrder] = useState(""); const [movementType, setMovementType] = useState(""); const [condition, setCondition] = useState(""); const [batch, setBatch] = useState(""); const [serial, setSerial] = useState(""); const [dateFrom, setDateFrom] = useState(""); const [dateTo, setDateTo] = useState(""); const [operator, setOperator] = useState(""); const [status, setStatus] = useState("");
  const groupByGuid = useMemo(() => new Map(stores.stockItems.map((entry) => [entry.tallyGuid, entry])), [stores.stockItems]);
  const rows = useMemo(() => operations.movements.filter((entry) => {
    const groups = groupByGuid.get(entry.tallyItemGuid);
    return (!item || entry.tallyItemGuid === item) && (!primaryGroup || groups?.primaryGroupName === primaryGroup) && (!secondaryGroup || groups?.secondaryGroupName === secondaryGroup) && (!supplier || String(entry.supplierId ?? "") === supplier) && (!productOrder || entry.productOrderId.toLocaleLowerCase().includes(productOrder.toLocaleLowerCase())) && (!movementType || entry.movementType === movementType) && (!condition || entry.sourceCondition === condition || entry.targetCondition === condition) && (!batch || entry.lines.some((line) => line.batchNumber.toLocaleLowerCase().includes(batch.toLocaleLowerCase()))) && (!serial || entry.lines.some((line) => line.serialNumbers.some((value) => value.toLocaleLowerCase().includes(serial.toLocaleLowerCase())))) && (!dateFrom || entry.eventDate >= dateFrom) && (!dateTo || entry.eventDate <= dateTo) && (!operator || entry.operator.toLocaleLowerCase().includes(operator.toLocaleLowerCase())) && (!status || entry.status === status);
  }), [operations.movements, groupByGuid, item, primaryGroup, secondaryGroup, supplier, productOrder, movementType, condition, batch, serial, dateFrom, dateTo, operator, status]);
  const [selected, setSelected] = useState(operations.movements[0]?.id ?? "");
  const movement = operations.movements.find((entry) => entry.id === selected) ?? null;
  const [reverseQty, setReverseQty] = useState(1); const [reverseReason, setReverseReason] = useState(""); const [reverseSerials, setReverseSerials] = useState("");
  const [reviewReference, setReviewReference] = useState("");
  const primaryGroups = [...new Set(stores.stockItems.map((entry) => entry.primaryGroupName).filter(Boolean))].sort();
  const secondaryGroups = [...new Set(stores.stockItems.filter((entry) => !primaryGroup || entry.primaryGroupName === primaryGroup).map((entry) => entry.secondaryGroupName).filter(Boolean))].sort();
  return <div className="planning-section-stack">
    <OperationPanel eyebrow="MOVEMENT REPORT" title="Complete linked inventory history">
      <div className="operations-history-filters"><ItemPicker stores={stores} value={item} onChange={setItem} /><label>Primary group<select value={primaryGroup} onChange={(event) => { setPrimaryGroup(event.target.value); setSecondaryGroup(""); }}><option value="">All</option>{primaryGroups.map((entry) => <option key={entry}>{entry}</option>)}</select></label><label>Secondary group<select value={secondaryGroup} onChange={(event) => setSecondaryGroup(event.target.value)} disabled={secondaryGroups.length === 0}><option value="">All</option>{secondaryGroups.map((entry) => <option key={entry}>{entry}</option>)}</select></label><SupplierPicker stores={stores} value={supplier} onChange={setSupplier} /><label>Product order<input value={productOrder} onChange={(event) => setProductOrder(event.target.value)} /></label><label>Movement type<select value={movementType} onChange={(event) => setMovementType(event.target.value)}><option value="">All</option>{[...new Set(operations.movements.map((entry) => entry.movementType))].map((entry) => <option key={entry}>{entry}</option>)}</select></label><label>Condition<select value={condition} onChange={(event) => setCondition(event.target.value)}><option value="">All</option><option>AVAILABLE</option><option>PENDING_INSPECTION</option><option>FAULTY</option><option>SCRAPPED</option><option>RETURNED_TO_SUPPLIER</option></select></label><label>Batch<input value={batch} onChange={(event) => setBatch(event.target.value)} /></label><label>Serial<input value={serial} onChange={(event) => setSerial(event.target.value)} /></label><label>From<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label>To<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label><label>Operator<input value={operator} onChange={(event) => setOperator(event.target.value)} /></label><label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All</option><option>APPLIED</option><option>REVERSED</option><option>EXCEPTION</option><option>MANUAL_REVIEW</option></select></label></div>
      <div className="table-scroll"><table><thead><tr><th>Date</th><th>Movement</th><th>Item</th><th>Qty</th><th>From</th><th>To</th><th>Supplier / receipt</th><th>Product order</th><th>Operator</th><th>Status</th></tr></thead><tbody>{rows.map((entry) => <tr key={entry.id} className={selected === entry.id ? "selected-row" : ""} onClick={() => { setSelected(entry.id); setReverseQty(Math.max(1, entry.reversibleQuantity)); }}><td>{entry.eventDate}</td><td>{label(entry.movementType)}</td><td>{entry.itemName}</td><td>{entry.quantity}</td><td>{entry.sourceCondition ? label(entry.sourceCondition) : "—"}</td><td>{entry.targetCondition ? label(entry.targetCondition) : "—"}</td><td>{entry.supplierName || entry.receiptReference || "—"}</td><td>{entry.productOrderId || "—"}</td><td>{entry.operator}</td><td><Status value={entry.status} /></td></tr>)}{rows.length === 0 && <tr><td colSpan={10} className="empty-table">No movements match these filters.</td></tr>}</tbody></table></div>
    </OperationPanel>
    {movement && <OperationPanel eyebrow="MOVEMENT DETAIL" title={`${label(movement.movementType)} · ${movement.id}`}>
      <dl className="movement-detail-grid"><div><dt>Client transaction</dt><dd>{movement.clientTransactionId}</dd></div><div><dt>Recorded</dt><dd>{dateTime(movement.eventTimestamp)}</dd></div><div><dt>Operator</dt><dd>{movement.operator} · {label(movement.operatorRole)}</dd></div><div><dt>References</dt><dd>{[movement.purchaseOrderReference, movement.receiptReference, movement.referenceMovementId].filter(Boolean).join(" / ") || "—"}</dd></div><div><dt>Notes</dt><dd>{movement.notes || "—"}</dd></div><div><dt>Reversible</dt><dd>{movement.reversibleQuantity}</dd></div></dl>
      <div className="table-scroll"><table><thead><tr><th>Purchase lot</th><th>Qty</th><th>From</th><th>To</th><th>Batch</th><th>Serials</th></tr></thead><tbody>{movement.lines.map((line, index) => <tr key={`${line.lotId}:${index}`}><td>{line.purchaseLotId}</td><td>{line.quantity}</td><td>{line.sourceCondition || "—"}</td><td>{line.targetCondition || "—"}</td><td>{line.batchNumber || "—"}</td><td>{line.serialNumbers.join(", ") || "—"}</td></tr>)}</tbody></table></div>
      {canReverse && movement.reversibleQuantity > 0 && movement.movementType !== "TRANSACTION_REVERSAL" && <form className="operations-form operations-form-compact" onSubmit={(event) => { event.preventDefault(); void run(() => window.desktop.operations.reverseMovement({ clientTransactionId: clientId("reversal"), movementId: movement.id, quantity: reverseQty, reason: reverseReason, serialNumbers: serials(reverseSerials) }), "Reversal recorded. If later movements prevented a clean reversal, an exception was created instead."); }}><label>Reverse quantity<input type="number" min={1} max={movement.reversibleQuantity} step={1} value={reverseQty} onChange={(event) => setReverseQty(Number(event.target.value))} /></label><label>Reason<input value={reverseReason} onChange={(event) => setReverseReason(event.target.value)} required /></label><SerialField value={reverseSerials} onChange={setReverseSerials} /><button className="button button--danger" disabled={busy} type="submit">Create reversal</button></form>}
    </OperationPanel>}
    {canReview && <OperationPanel eyebrow="MANUAL TALLY REVIEW" title="Unsupported or condition-sensitive mappings">
      <div className="table-scroll"><table><thead><tr><th>Date</th><th>Movement</th><th>Item</th><th>Qty</th><th>Reason</th><th>Status</th><th>Voucher reference</th><th>Action</th></tr></thead><tbody>{operations.manualTallyReviews.map((entry) => <tr key={entry.id}><td>{entry.eventDate}</td><td>{label(entry.movementType)}</td><td>{entry.itemName}</td><td>{entry.quantity}</td><td>{entry.reviewReason}</td><td><Status value={entry.status} /></td><td>{entry.tallyVoucherReference || "—"}</td><td>{entry.status !== "PROCESSED" && <div className="inline-actions"><input aria-label="Tally voucher reference" value={reviewReference} onChange={(event) => setReviewReference(event.target.value)} /><button className="button button--small" type="button" disabled={busy || !reviewReference} onClick={() => void run(() => window.desktop.operations.reviewManualTally({ reviewId: entry.id, status: "PROCESSED", tallyVoucherReference: reviewReference }), "Manual Tally review completed.")}>Processed</button></div>}</td></tr>)}{operations.manualTallyReviews.length === 0 && <tr><td colSpan={8} className="empty-table">No manual Tally reviews are pending.</td></tr>}</tbody></table></div>
    </OperationPanel>}
  </div>;
}

function Users({ auth, busy, run }: { auth: AuthState; busy: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<void> }) {
  const [selected, setSelected] = useState("");
  const current = auth.users.find((entry) => entry.userId === selected);
  const [displayName, setDisplayName] = useState(""); const [username, setUsername] = useState(""); const [role, setRole] = useState<UserRole>("STORE"); const [active, setActive] = useState(true); const [auditIdentity, setAuditIdentity] = useState(""); const [credential, setCredential] = useState(""); const [credentialType, setCredentialType] = useState<"PASSWORD" | "PIN">("PASSWORD");
  function choose(id: string) { const user = auth.users.find((entry) => entry.userId === id); setSelected(id); setDisplayName(user?.displayName ?? ""); setUsername(user?.username ?? ""); setRole(user?.role ?? "STORE"); setActive(user?.active ?? true); setAuditIdentity(user?.auditIdentity ?? ""); setCredential(""); setCredentialType(user?.credentialType ?? "PASSWORD"); }
  return <div className="operations-two-column">
    <OperationPanel eyebrow="LOCAL USERS" title="Roles and audit identities">
      <div className="table-scroll"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Audit identity</th><th>Last login</th><th>Status</th></tr></thead><tbody>{auth.users.map((user) => <tr key={user.userId} className={selected === user.userId ? "selected-row" : ""} onClick={() => choose(user.userId)}><td>{user.displayName}</td><td>{user.username}</td><td>{user.role}</td><td>{user.auditIdentity}</td><td>{user.lastLogin ? dateTime(user.lastLogin) : "Never"}</td><td><Status value={user.active ? "ACTIVE" : "INACTIVE"} /></td></tr>)}</tbody></table></div><button className="button button--secondary" type="button" onClick={() => choose("")}>New user</button>
    </OperationPanel>
    <OperationPanel eyebrow={current ? "EDIT USER" : "CREATE USER"} title={current?.displayName ?? "New local account"}>
      <form className="operations-form operations-form-single" onSubmit={(event) => { event.preventDefault(); void run(() => window.desktop.operations.saveUser({ id: selected || undefined, displayName, username, role, active, auditIdentity: auditIdentity || undefined, credential: credential || undefined, credentialType }), selected ? "User updated." : "User created."); }}><label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label><label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} required /></label><label>Role<select value={role} onChange={(event) => setRole(event.target.value as UserRole)}><option>STORE</option><option>ACCOUNTS</option><option>PRODUCTION</option><option>SALES</option><option>ADMIN</option></select></label><label>Audit identity<input value={auditIdentity} onChange={(event) => setAuditIdentity(event.target.value)} placeholder="Defaults to username" /></label><label>Credential type<select value={credentialType} onChange={(event) => setCredentialType(event.target.value as typeof credentialType)}><option>PASSWORD</option><option>PIN</option></select></label><label>{selected ? "New credential (optional)" : "Credential"}<input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} required={!selected} /></label><label className="check-row"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />Active account</label><button className="button" disabled={busy} type="submit">Save user</button>{selected && <button className="button button--secondary" disabled={busy || !credential} type="button" onClick={() => void run(() => window.desktop.operations.resetCredential({ userId: selected, credential, credentialType }), "Credential reset. Existing sessions were signed out.")}>Reset credential</button>}</form>
    </OperationPanel>
  </div>;
}
