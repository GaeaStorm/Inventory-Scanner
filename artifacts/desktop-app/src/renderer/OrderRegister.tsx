import { useMemo, useState } from "react";

import { finishedProductItems } from "./stock-item-visibility";
import type {
  PlanningState,
  ProductOrder,
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

type QuickFilter = "all" | "overdue" | "blocked" | "ready";

interface OrderGroup {
  key: string;
  organisation: string;
  reference: string;
  fileNumber: string;
  dueDate: string;
  owner: string;
  lines: ProductOrder[];
}

const today = () => new Date().toISOString().slice(0, 10);

function orderKey(line: ProductOrder): string {
  return [
    line.organisation.trim().toLocaleLowerCase(),
    (line.externalReference || line.fileNumber || line.id).trim().toLocaleLowerCase(),
  ].join("::");
}

function displayDate(value: string): string {
  if (!value) return "Not set";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

function completedQuantity(line: ProductOrder): number {
  return Math.max(0, Math.min(line.quantity, line.quantity - (line.pendingQuantity ?? line.quantity)));
}

function isBlocked(line: ProductOrder): boolean {
  return ["AT_RISK", "SHORT_COMPONENTS", "BOM_INCOMPLETE"].includes(line.feasibility)
    || Boolean(line.pendingMaterial.trim() || line.rawMaterialToOrder.trim());
}

function isReady(line: ProductOrder): boolean {
  const state = line.workflowStateName.toLocaleLowerCase();
  return line.pendingQuantity === 0
    || line.status === "COMPLETED"
    || state.includes("ready")
    || state.includes("complete")
    || state.includes("dispatch");
}

function groupDueDate(group: OrderGroup): string {
  return group.lines.map((line) => line.lastDispatchDate || line.requiredDate).filter(Boolean).sort()[0] ?? "";
}

function attention(group: OrderGroup): { label: string; tone: string } {
  const due = groupDueDate(group);
  const openLines = group.lines.filter((line) => !isReady(line));
  if (due && due < today() && openLines.length) return { label: "Overdue", tone: "danger" };
  if (group.lines.some(isBlocked)) return { label: "Material blocked", tone: "danger" };
  if (group.lines.some((line) => /pending|await/i.test(`${line.crfStatus} ${line.cracStatus}`))) {
    return { label: "Customer action required", tone: "warning" };
  }
  if (group.lines.some(isReady) && openLines.length) return { label: "Partially ready", tone: "warning" };
  if (group.lines.length > 0 && group.lines.every(isReady)) return { label: "Ready for dispatch", tone: "success" };
  return { label: "On track", tone: "neutral" };
}

function toDraft(line: ProductOrder): SaveProductOrderInput {
  return {
    id: line.id,
    fileNumber: line.fileNumber,
    organisation: line.organisation,
    externalReference: line.externalReference,
    purchaseOrderDate: line.purchaseOrderDate,
    lastDispatchDate: line.lastDispatchDate,
    productTallyGuid: line.productTallyGuid,
    quantity: line.quantity,
    pendingQuantity: line.pendingQuantity,
    valueIncludingGst: line.valueIncludingGst,
    pendingMaterial: line.pendingMaterial,
    rawMaterialToOrder: line.rawMaterialToOrder,
    crfStatus: line.crfStatus,
    cracStatus: line.cracStatus,
    taskRemarks: line.taskRemarks,
    responsiblePerson: line.responsiblePerson,
    followUpDate: line.followUpDate,
    dispatchSchedule: line.dispatchSchedule,
    priority: line.priority,
    requiredDate: line.requiredDate,
    status: line.status === "DRAFT" ? "DRAFT" : "CONFIRMED",
    workflowStateId: line.workflowStateId,
    notes: line.notes,
    customFields: { ...line.customFields },
  };
}

function newDraft(planning: PlanningState, group?: OrderGroup): SaveProductOrderInput {
  const first = group?.lines[0];
  return {
    fileNumber: first?.fileNumber ?? "",
    organisation: first?.organisation ?? "",
    externalReference: first?.externalReference ?? "",
    purchaseOrderDate: first?.purchaseOrderDate ?? "",
    lastDispatchDate: first?.lastDispatchDate ?? group?.dueDate ?? "",
    productTallyGuid: "",
    quantity: 1,
    pendingQuantity: 1,
    valueIncludingGst: null,
    pendingMaterial: "",
    rawMaterialToOrder: "",
    crfStatus: first?.crfStatus ?? "",
    cracStatus: first?.cracStatus ?? "",
    taskRemarks: "",
    responsiblePerson: first?.responsiblePerson ?? "",
    followUpDate: first?.followUpDate ?? "",
    dispatchSchedule: first?.dispatchSchedule ?? "",
    priority: first?.priority ?? "",
    requiredDate: first?.requiredDate ?? today(),
    status: "CONFIRMED",
    workflowStateId: planning.productOrderWorkflowStates[0]?.id ?? "",
    notes: "",
    customFields: {},
  };
}

export default function OrderRegister({ planning, stores, canManage, onRefresh, onNotice, onError }: Props) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [due, setDue] = useState("");
  const [owner, setOwner] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState("");
  const [draft, setDraft] = useState<SaveProductOrderInput | null>(null);
  const [busy, setBusy] = useState(false);

  const products = useMemo(() => {
    const preferred = finishedProductItems(stores.stockItems);
    return (preferred.length ? preferred : stores.stockItems.filter((item) => item.active && !item.ignored))
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [stores.stockItems]);

  const groups = useMemo(() => {
    const grouped = new Map<string, OrderGroup>();
    for (const line of planning.productOrders) {
      const key = orderKey(line);
      const current = grouped.get(key);
      if (current) current.lines.push(line);
      else grouped.set(key, {
        key,
        organisation: line.organisation || "Customer not set",
        reference: line.externalReference || line.fileNumber || "PO not set",
        fileNumber: line.fileNumber,
        dueDate: line.lastDispatchDate || line.requiredDate,
        owner: line.responsiblePerson,
        lines: [line],
      });
    }
    return [...grouped.values()].map((group) => ({
      ...group,
      dueDate: groupDueDate(group),
      owner: group.lines.find((line) => line.responsiblePerson)?.responsiblePerson ?? "",
    })).sort((left, right) => (left.dueDate || "9999").localeCompare(right.dueDate || "9999"));
  }, [planning.productOrders]);

  const owners = [...new Set(planning.productOrders.map((line) => line.responsiblePerson).filter(Boolean))].sort();
  const filteredGroups = groups.filter((group) => {
    const groupAttention = attention(group);
    const haystack = `${group.organisation} ${group.reference} ${group.fileNumber} ${group.lines.map((line) => line.productName).join(" ")}`.toLocaleLowerCase();
    const dueDate = group.dueDate;
    const dueMatch = !due
      || (due === "overdue" && Boolean(dueDate && dueDate < today()))
      || (due === "week" && Boolean(dueDate && dueDate >= today() && dueDate <= new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)))
      || (due === "unset" && !dueDate);
    return (!search || haystack.includes(search.toLocaleLowerCase()))
      && (!status || groupAttention.label === status)
      && (!owner || group.lines.some((line) => line.responsiblePerson === owner))
      && dueMatch
      && (quickFilter === "all"
        || (quickFilter === "overdue" && groupAttention.label === "Overdue")
        || (quickFilter === "blocked" && groupAttention.label === "Material blocked")
        || (quickFilter === "ready" && groupAttention.label === "Ready for dispatch"));
  });

  const selected = groups.find((group) => group.key === selectedKey) ?? null;

  async function saveLine() {
    if (!draft?.productTallyGuid) {
      onError("Choose a product for this order line.");
      return;
    }
    setBusy(true);
    onError("");
    try {
      await window.desktop.planning.saveProductOrder(draft);
      await onRefresh();
      onNotice(draft.id ? "Product line updated." : "Product line added.");
      setDraft(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function toggleExpanded(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (selected) {
    const health = attention(selected);
    const ordered = selected.lines.reduce((sum, line) => sum + line.quantity, 0);
    const completed = selected.lines.reduce((sum, line) => sum + completedQuantity(line), 0);
    const first = selected.lines[0];
    return <div className="order-detail-page">
      <button className="order-back-button" type="button" onClick={() => setSelectedKey("")}>← Back to orders</button>
      <header className="order-detail-heading">
        <div><p className="eyebrow">ORDER DETAIL</p><h2>{selected.organisation}</h2><p>{selected.reference}</p></div>
        <div className="order-detail-heading__meta"><span>Promised dispatch: <strong>{displayDate(selected.dueDate)}</strong></span><span className={`order-attention order-attention--${health.tone}`}>{health.label}</span></div>
      </header>
      <div className="order-detail-layout">
        <article className="order-detail-card order-detail-card--lines">
          <div className="order-detail-card__header"><div><p className="eyebrow">PRODUCT LINES</p><h3>{completed} of {ordered} units complete</h3></div>{canManage && <button className="button button--secondary" type="button" onClick={() => setDraft(newDraft(planning, selected))}>+ Add product line</button>}</div>
          <div className="order-lines-table">
            <div className="order-lines-table__head"><span>Product</span><span>Qty</span><span>Stage</span><span>Complete</span><span>Blocker</span></div>
            {selected.lines.map((line) => <button className="order-lines-table__row" type="button" key={line.id} onClick={() => setDraft(toDraft(line))}>
              <strong>{line.productName}</strong><span>{line.quantity}</span><span>{line.workflowStateName}</span><span>{completedQuantity(line)} / {line.quantity}</span><span className={isBlocked(line) ? "danger-text" : ""}>{isBlocked(line) ? line.pendingMaterial || line.rawMaterialToOrder || "Material shortage" : "—"}</span>
            </button>)}
          </div>
        </article>
        <aside className="order-detail-card order-detail-sidebar">
          <div><p className="eyebrow">ORDER INFORMATION</p><dl><div><dt>CRF</dt><dd>{first?.crfStatus || "Not set"}</dd></div><div><dt>CRAC</dt><dd>{first?.cracStatus || "Not set"}</dd></div><div><dt>Owner</dt><dd>{selected.owner || "Unassigned"}</dd></div><div><dt>Priority</dt><dd>{first?.priority || "Not set"}</dd></div></dl></div>
          <div><p className="eyebrow">NEXT FOLLOW-UP</p><strong>{displayDate(first?.followUpDate || "")}</strong><p>{first?.taskRemarks || first?.notes || "No follow-up note recorded."}</p></div>
        </aside>
      </div>
      <article className="order-activity">
        <p className="eyebrow">RECENT ACTIVITY</p>
        {selected.lines.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map((line) => <div key={line.id}><time>{displayDate(line.updatedAt.slice(0, 10))}</time><span>{line.productName} updated · {line.workflowStateName}</span></div>)}
      </article>
      {draft && <LineDrawer draft={draft} setDraft={setDraft} planning={planning} products={products} busy={busy} canManage={canManage} onSave={() => void saveLine()} />}
    </div>;
  }

  return <div className="order-register">
    <div className="order-register-toolbar">
      <input className="order-register-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search orders…" />
      <select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option>Overdue</option><option>Material blocked</option><option>Customer action required</option><option>Partially ready</option><option>Ready for dispatch</option><option>On track</option></select>
      <select value={due} onChange={(event) => setDue(event.target.value)}><option value="">Any due date</option><option value="overdue">Overdue</option><option value="week">Due this week</option><option value="unset">Date not set</option></select>
      <select value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">All owners</option>{owners.map((entry) => <option key={entry}>{entry}</option>)}</select>
      {canManage && <button className="button" type="button" onClick={() => setDraft(newDraft(planning))}>+ New order</button>}
    </div>
    <div className="order-quick-filters" aria-label="Quick order filters">
      {(["all", "overdue", "blocked", "ready"] as QuickFilter[]).map((value) => <button type="button" key={value} className={quickFilter === value ? "active" : ""} onClick={() => setQuickFilter(value)}>{value === "all" ? "All" : value === "ready" ? "Ready to dispatch" : value[0].toLocaleUpperCase() + value.slice(1)}</button>)}
    </div>
    <div className="order-register-table">
      <div className="order-register-row order-register-row--head"><span /><span>Due</span><span>Customer / PO</span><span>Lines</span><span>Progress</span><span>Attention</span><span>Owner</span></div>
      {filteredGroups.map((group) => {
        const open = expanded.has(group.key);
        const ordered = group.lines.reduce((sum, line) => sum + line.quantity, 0);
        const completed = group.lines.reduce((sum, line) => sum + completedQuantity(line), 0);
        const percent = ordered ? Math.round((completed / ordered) * 100) : 0;
        const groupAttention = attention(group);
        return <div className="order-register-group" key={group.key}>
          <div className="order-register-row">
            <button className="order-expand-button" type="button" aria-label={open ? "Collapse order" : "Expand order"} onClick={() => toggleExpanded(group.key)}>{open ? "⌄" : "›"}</button>
            <span className={group.dueDate && group.dueDate < today() && completed < ordered ? "danger-text" : ""}>{displayDate(group.dueDate)}</span>
            <button className="order-link-button" type="button" onClick={() => setSelectedKey(group.key)}><strong>{group.organisation}</strong><span>{group.reference}</span></button>
            <span>{group.lines.length} line{group.lines.length === 1 ? "" : "s"}</span>
            <div className="order-progress"><span>{completed} of {ordered} complete</span><i><b style={{ width: `${percent}%` }} /></i></div>
            <span><span className={`order-attention order-attention--${groupAttention.tone}`}>{groupAttention.label}</span></span>
            <span>{group.owner || "Unassigned"}</span>
          </div>
          {open && <div className="order-expanded-lines">
            <div className="order-expanded-lines__head"><span>Product</span><span>Qty</span><span>Stage</span><span>Blocker</span><span>Complete</span></div>
            {group.lines.map((line) => <button type="button" className="order-expanded-lines__row" key={line.id} onClick={() => setDraft(toDraft(line))}><strong>{line.productName}</strong><span>{line.quantity}</span><span>{line.workflowStateName}</span><span className={isBlocked(line) ? "danger-text" : ""}>{isBlocked(line) ? line.pendingMaterial || line.rawMaterialToOrder || "Material shortage" : "—"}</span><span>{completedQuantity(line)} / {line.quantity}</span></button>)}
          </div>}
        </div>;
      })}
      {filteredGroups.length === 0 && <div className="order-register-empty">No purchase orders match these filters.</div>}
    </div>
    {draft && <LineDrawer draft={draft} setDraft={setDraft} planning={planning} products={products} busy={busy} canManage={canManage} onSave={() => void saveLine()} />}
  </div>;
}

function LineDrawer({ draft, setDraft, planning, products, busy, canManage, onSave }: {
  draft: SaveProductOrderInput;
  setDraft: (draft: SaveProductOrderInput | null) => void;
  planning: PlanningState;
  products: StoresState["stockItems"];
  busy: boolean;
  canManage: boolean;
  onSave: () => void;
}) {
  return <div className="product-line-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDraft(null); }}>
    <aside className="product-line-drawer" role="dialog" aria-modal="true" aria-label={draft.id ? "Edit product line" : "Add product line"}>
      <header><div><p className="eyebrow">{draft.id ? "EDIT PRODUCT LINE" : "NEW PRODUCT LINE"}</p><h2>{draft.externalReference || "New order"}</h2></div><button className="icon-button" type="button" onClick={() => setDraft(null)} aria-label="Close">×</button></header>
      <div className="product-line-drawer__body">
        <div className="product-line-order-fields">
          <label>Customer<input value={draft.organisation ?? ""} onChange={(event) => setDraft({ ...draft, organisation: event.target.value })} /></label>
          <label>Purchase order<input value={draft.externalReference} onChange={(event) => setDraft({ ...draft, externalReference: event.target.value })} /></label>
        </div>
        <label>Product<select value={draft.productTallyGuid} onChange={(event) => setDraft({ ...draft, productTallyGuid: event.target.value })}><option value="">Select product…</option>{products.map((product) => <option key={product.tallyGuid} value={product.tallyGuid}>{product.name}</option>)}</select></label>
        <div className="product-line-drawer__pair"><label>Quantity ordered<input type="number" min={1} value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: Number(event.target.value) })} /></label><label>Remaining<input type="number" min={0} max={draft.quantity} value={draft.pendingQuantity ?? draft.quantity} onChange={(event) => setDraft({ ...draft, pendingQuantity: Number(event.target.value) })} /></label></div>
        <label>Stage<select value={draft.workflowStateId ?? ""} onChange={(event) => setDraft({ ...draft, workflowStateId: event.target.value })}>{planning.productOrderWorkflowStates.map((state) => <option key={state.id} value={state.id}>{state.name}</option>)}</select></label>
        <label>Owner<input value={draft.responsiblePerson ?? ""} onChange={(event) => setDraft({ ...draft, responsiblePerson: event.target.value })} /></label>
        <label>Required date<input type="date" value={draft.lastDispatchDate || draft.requiredDate || ""} onChange={(event) => setDraft({ ...draft, lastDispatchDate: event.target.value, requiredDate: event.target.value })} /></label>
        <label>Material blocker<textarea rows={2} placeholder="Leave blank when material is available" value={draft.pendingMaterial ?? ""} onChange={(event) => setDraft({ ...draft, pendingMaterial: event.target.value })} /></label>
        <label>Notes<textarea rows={3} value={draft.taskRemarks ?? ""} onChange={(event) => setDraft({ ...draft, taskRemarks: event.target.value })} /></label>
      </div>
      <footer><button className="button button--secondary" type="button" onClick={() => setDraft(null)}>Cancel</button><button className="button" type="button" disabled={busy || !canManage || !draft.productTallyGuid} onClick={onSave}>Save product line</button></footer>
    </aside>
  </div>;
}
