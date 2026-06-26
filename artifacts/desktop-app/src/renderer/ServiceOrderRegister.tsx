import { useMemo, useState } from "react";

import { finishedProductItems } from "./stock-item-visibility";
import type {
  PlanningState,
  ProductOrder,
  SaveProductOrderInput,
  StoresState,
} from "./types";

export function serviceOrderProductOptions(stores: StoresState): StoresState["stockItems"] {
  const preferred = finishedProductItems(stores.stockItems);
  return (preferred.length ? preferred : stores.stockItems.filter((item) => item.active && !item.ignored))
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
}

export interface ServiceOrderGroup {
  key: string;
  organisation: string;
  reference: string;
  fileNumber: string;
  dueDate: string;
  owner: string;
  lines: ProductOrder[];
}

interface OrderInfoDraft {
  organisation: string;
  externalReference: string;
  fileNumber: string;
  purchaseOrderDate: string;
  lastDispatchDate: string;
  valueIncludingGst: number | null;
  responsiblePerson: string;
  followUpDate: string;
  dispatchSchedule: string;
  priority: string;
  taskRemarks: string;
  notes: string;
}

const today = () => new Date().toISOString().slice(0, 10);

function orderKey(line: ProductOrder): string {
  return [
    line.organisation.trim().toLocaleLowerCase(),
    (line.externalReference || line.fileNumber || line.id).trim().toLocaleLowerCase(),
  ].join("::");
}

function stageLabel(value: string): string {
  return value.replace(/^Service · /, "");
}

function warrantyLabel(value: ProductOrder["warrantyStatus"]): string {
  return value === "IN_WARRANTY" ? "In Warranty" : "Out of Warranty";
}

const holdStatusBadge: Record<string, { label: string; tone: string } | null> = {
  DRAFT: null,
  CONFIRMED: null,
  ON_HOLD: { label: "On Hold", tone: "needs-correction" },
  CANCELLED: { label: "Cancelled", tone: "rejected" },
  COMPLETED: { label: "Complete", tone: "confirmed" },
};

function draftWarranty(serialNumber: string): string {
  const match = serialNumber.trim().match(/^(\d{2})(0[1-9]|1[0-2])/);
  if (!match) return "Enter a Serial No beginning with YYMM.";
  const manufactured = (2000 + Number(match[1])) * 12 + Number(match[2]) - 1;
  const now = new Date();
  const age = now.getFullYear() * 12 + now.getMonth() - manufactured;
  return age >= 0 && age <= 15 ? "In Warranty" : "Out of Warranty";
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

function isReady(line: ProductOrder): boolean {
  const state = line.workflowStateName.toLocaleLowerCase();
  return line.status === "COMPLETED" || state === "service · dispatch";
}

function groupDueDate(group: Pick<ServiceOrderGroup, "lines">): string {
  return group.lines.map((line) => line.lastDispatchDate || line.requiredDate).filter(Boolean).sort()[0] ?? "";
}

/** Pure grouping (by customer + reference), so the unified register can compute Service Order rows without rendering anything. */
export function buildServiceOrderGroups(planning: PlanningState): ServiceOrderGroup[] {
  const grouped = new Map<string, ServiceOrderGroup>();
  for (const line of planning.productOrders) {
    if (line.orderType !== "SERVICE") continue;
    const key = orderKey(line);
    const current = grouped.get(key);
    if (current) current.lines.push(line);
    else grouped.set(key, {
      key,
      organisation: line.organisation || "Customer not set",
      reference: line.externalReference || line.fileNumber || "Reference not set",
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
  }));
}

export function serviceOrderAttention(group: ServiceOrderGroup): { label: string; tone: string } {
  const due = group.dueDate;
  const openLines = group.lines.filter((line) => !isReady(line));
  if (due && due < today() && openLines.length) return { label: "Overdue", tone: "danger" };
  if (group.lines.some((line) => /pending|await/i.test(`${line.crfStatus} ${line.cracStatus}`))) {
    return { label: "Customer action required", tone: "warning" };
  }
  if (group.lines.some(isReady) && openLines.length) return { label: "Partially dispatched", tone: "warning" };
  if (group.lines.length > 0 && group.lines.every(isReady)) return { label: "Dispatched", tone: "success" };
  return { label: "On track", tone: "neutral" };
}

function toDraft(line: ProductOrder): SaveProductOrderInput {
  return {
    id: line.id,
    orderType: "SERVICE",
    serialNumber: line.serialNumber,
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

export function newServiceOrderDraft(planning: PlanningState, group?: ServiceOrderGroup): SaveProductOrderInput {
  const first = group?.lines[0];
  return {
    orderType: "SERVICE",
    serialNumber: first?.serialNumber ?? "",
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
    priority: first?.priority ?? "LOW",
    requiredDate: first?.requiredDate ?? today(),
    status: "CONFIRMED",
    workflowStateId: planning.productOrderWorkflowStates.find((stage) => stage.orderType === "SERVICE")?.id ?? "",
    notes: "",
    customFields: {},
  };
}

function orderInfoDraft(group: ServiceOrderGroup): OrderInfoDraft {
  const first = group.lines[0];
  return {
    organisation: first?.organisation ?? "",
    externalReference: first?.externalReference ?? "",
    fileNumber: first?.fileNumber ?? "",
    purchaseOrderDate: first?.purchaseOrderDate ?? "",
    lastDispatchDate: first?.lastDispatchDate || first?.requiredDate || "",
    valueIncludingGst: first?.valueIncludingGst ?? null,
    responsiblePerson: first?.responsiblePerson ?? "",
    followUpDate: first?.followUpDate ?? "",
    dispatchSchedule: first?.dispatchSchedule ?? "",
    priority: first?.priority ?? "LOW",
    taskRemarks: first?.taskRemarks ?? "",
    notes: first?.notes ?? "",
  };
}

interface DetailProps {
  group: ServiceOrderGroup;
  planning: PlanningState;
  stores: StoresState;
  canManage: boolean;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

/** The Service Order detail/edit experience — same backend calls and stage/warranty logic as before, driven externally by the unified register instead of its own internal list. */
export default function ServiceOrderDetail({ group, planning, stores, canManage, onBack, onRefresh, onNotice, onError }: DetailProps) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<SaveProductOrderInput | null>(null);
  const [infoDraft, setInfoDraft] = useState<OrderInfoDraft | null>(null);

  const products = useMemo(() => serviceOrderProductOptions(stores), [stores]);

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
      onNotice(draft.id ? "Service order item updated." : "Service order item added.");
      setDraft(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveOrderInfo() {
    if (!infoDraft) return;
    setBusy(true);
    onError("");
    try {
      for (const line of group.lines) {
        await window.desktop.planning.saveProductOrder({
          ...toDraft(line),
          ...infoDraft,
          requiredDate: infoDraft.lastDispatchDate || line.requiredDate,
        });
      }
      await onRefresh();
      onNotice("Order information updated across all lines.");
      setInfoDraft(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function nextStage(line: ProductOrder) {
    const stages = planning.productOrderWorkflowStates.filter((stage) => stage.orderType === "SERVICE");
    const currentIndex = stages.findIndex((stage) => stage.id === line.workflowStateId);
    return stages.slice(currentIndex + 1)[0] ?? null;
  }

  async function setGroupStatus(status: "ON_HOLD" | "CONFIRMED" | "CANCELLED" | "COMPLETED") {
    setBusy(true);
    onError("");
    try {
      for (const line of group.lines) {
        await window.desktop.planning.updateProductOrderStatus(line.id, status);
      }
      await onRefresh();
      onNotice(status === "ON_HOLD" ? "Order placed on hold."
        : status === "CANCELLED" ? "Order cancelled."
        : status === "COMPLETED" ? "Order marked complete."
        : "Order resumed.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function advanceGroup() {
    const advances = group.lines.map((line) => ({ line, stage: nextStage(line) })).filter((entry) => entry.stage);
    if (advances.length === 0) return;
    setBusy(true);
    onError("");
    try {
      for (const entry of advances) {
        await window.desktop.planning.updateProductOrderWorkflowState(entry.line.id, entry.stage!.id);
      }
      await onRefresh();
      onNotice(`Advanced ${advances.length} order item${advances.length === 1 ? "" : "s"} to the next stage.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const health = serviceOrderAttention(group);
  const ordered = group.lines.reduce((sum, line) => sum + line.quantity, 0);
  const completed = group.lines.reduce((sum, line) => sum + completedQuantity(line), 0);
  const first = group.lines[0];
  const groupOnHold = group.lines.length > 0 && group.lines.every((line) => line.status === "ON_HOLD");
  const groupTerminal = group.lines.length > 0 && group.lines.every((line) => line.status === "CANCELLED" || line.status === "COMPLETED");

  return <div className="order-detail-page">
    <button className="order-back-button" type="button" onClick={onBack}>← Back to Orders</button>
    <header className="order-detail-heading">
      <div><div className="order-detail-type-row"><p className="eyebrow">SERVICE ORDER DETAIL</p><span className="order-type-badge order-type-badge--service">Service Order</span></div><h2>{group.organisation}</h2><p>{group.reference}</p></div>
      <div className="order-detail-heading__meta">
        <span>Promised dispatch: <strong>{displayDate(group.dueDate)}</strong></span>
        <span className={`order-attention order-attention--${health.tone}`}>{health.label}</span>
        {groupOnHold && <span className="review-status review-status--needs-correction">On Hold</span>}
        {groupTerminal && group.lines.every((line) => line.status === "CANCELLED") && <span className="review-status review-status--rejected">Cancelled</span>}
        {groupTerminal && group.lines.every((line) => line.status === "COMPLETED") && <span className="review-status review-status--confirmed">Complete</span>}
        {canManage && <div className="inline-actions">
          <button className="button button--secondary button--small" type="button" onClick={() => setInfoDraft(orderInfoDraft(group))}>Edit order information</button>
          <button className="button button--small" type="button" disabled={busy || group.lines.every((line) => !nextStage(line))} onClick={() => void advanceGroup()}>Advance to next stage</button>
          {!groupTerminal && (groupOnHold
            ? <button className="button button--secondary button--small" type="button" disabled={busy} onClick={() => void setGroupStatus("CONFIRMED")}>Resume</button>
            : <button className="button button--secondary button--small" type="button" disabled={busy} onClick={() => void setGroupStatus("ON_HOLD")}>Hold</button>)}
          {!groupTerminal && <button className="button button--secondary button--small" type="button" disabled={busy} onClick={() => void setGroupStatus("CANCELLED")}>Cancel</button>}
          {!groupTerminal && <button className="button button--secondary button--small" type="button" disabled={busy} onClick={() => void setGroupStatus("COMPLETED")}>Complete</button>}
        </div>}
      </div>
    </header>
    <div className="order-detail-layout">
      <article className="order-detail-card order-detail-card--lines">
        <div className="order-detail-card__header"><div><p className="eyebrow">ORDER ITEMS</p><h3>{completed} of {ordered} units complete</h3></div>{canManage && <button className="button button--secondary" type="button" onClick={() => setDraft(newServiceOrderDraft(planning, group))}>+ Add item</button>}</div>
        <div className="order-lines-table">
          <div className="order-lines-table__head"><span>Product</span><span>Qty</span><span>Stage</span><span>Complete</span><span /></div>
          {group.lines.map((line) => {
            const badge = holdStatusBadge[line.status];
            return <button className="order-lines-table__row" type="button" key={line.id} onClick={() => setDraft(toDraft(line))}>
              <strong>{line.productName}<small className="table-subtext">{line.serialNumber} · {warrantyLabel(line.warrantyStatus)}</small></strong><span>{line.quantity}</span><span>{stageLabel(line.workflowStateName)}</span><span>{completedQuantity(line)} / {line.quantity}</span>
              <span>{badge && <span className={`review-status review-status--${badge.tone}`}>{badge.label}</span>}</span>
            </button>;
          })}
        </div>
      </article>
      <aside className="order-detail-card order-detail-sidebar">
        <div><p className="eyebrow">ORDER INFORMATION</p><dl><div><dt>File No</dt><dd>{first?.fileNumber || "Not set"}</dd></div><div><dt>Order date</dt><dd>{displayDate(first?.purchaseOrderDate || "")}</dd></div><div><dt>Serial No</dt><dd>{first?.serialNumber || "Not set"}</dd></div><div><dt>Warranty</dt><dd>{first ? warrantyLabel(first.warrantyStatus) : "Not set"}</dd></div><div><dt>Owner</dt><dd>{group.owner || "Unassigned"}</dd></div><div><dt>Priority</dt><dd>{first?.priority || "Not set"}</dd></div><div><dt>Dispatch schedule</dt><dd>{first?.dispatchSchedule || "Not set"}</dd></div></dl></div>
        <div><p className="eyebrow">NEXT FOLLOW-UP</p><strong>{displayDate(first?.followUpDate || "")}</strong><p>{first?.taskRemarks || first?.notes || "No follow-up note recorded."}</p></div>
      </aside>
    </div>
    <article className="order-activity">
      <p className="eyebrow">RECENT ACTIVITY</p>
      {group.lines.flatMap((line) => line.activity.map((activity) => ({ ...activity, productName: line.productName }))).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 30).map((activity) => <div key={activity.id}><time>{new Date(activity.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</time><span><strong>{activity.actorName}</strong> · {activity.summary}<small className="table-subtext">{activity.productName}</small></span></div>)}
    </article>
    {draft && <ServiceOrderLineDrawer draft={draft} setDraft={setDraft} planning={planning} products={products} busy={busy} canManage={canManage} onSave={() => void saveLine()} />}
    {infoDraft && <OrderInfoDrawer draft={infoDraft} setDraft={setInfoDraft} busy={busy} onSave={() => void saveOrderInfo()} />}
  </div>;
}

function OrderInfoDrawer({ draft, setDraft, busy, onSave }: {
  draft: OrderInfoDraft;
  setDraft: (draft: OrderInfoDraft | null) => void;
  busy: boolean;
  onSave: () => void;
}) {
  return <div className="product-line-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDraft(null); }}>
    <aside className="product-line-drawer order-info-drawer" role="dialog" aria-modal="true" aria-label="Edit order information">
      <header><div><p className="eyebrow">EDIT ORDER INFORMATION</p><h2>{draft.externalReference || draft.fileNumber || "Order details"}</h2></div><button className="icon-button" type="button" onClick={() => setDraft(null)} aria-label="Close">×</button></header>
      <div className="product-line-drawer__body">
        <div className="product-line-order-fields">
          <label>Customer<input value={draft.organisation} onChange={(event) => setDraft({ ...draft, organisation: event.target.value })} /></label>
          <label>Service order reference<input value={draft.externalReference} onChange={(event) => setDraft({ ...draft, externalReference: event.target.value })} /></label>
        </div>
        <div className="product-line-drawer__pair">
          <label>File No<input value={draft.fileNumber} onChange={(event) => setDraft({ ...draft, fileNumber: event.target.value })} /></label>
          <label>Order date<input type="date" value={draft.purchaseOrderDate} onChange={(event) => setDraft({ ...draft, purchaseOrderDate: event.target.value })} /></label>
        </div>
        <div className="product-line-drawer__pair">
          <label>Promised dispatch<input type="date" value={draft.lastDispatchDate} onChange={(event) => setDraft({ ...draft, lastDispatchDate: event.target.value })} /></label>
          <label>Value including GST<input type="number" min={0} step="0.01" value={draft.valueIncludingGst ?? ""} onChange={(event) => setDraft({ ...draft, valueIncludingGst: event.target.value ? Number(event.target.value) : null })} /></label>
        </div>
        <div className="product-line-drawer__pair">
          <label>Owner<input value={draft.responsiblePerson} onChange={(event) => setDraft({ ...draft, responsiblePerson: event.target.value })} /></label>
          <label>Priority<select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value })}><option value="">Not set</option><option value="LOW">Low</option><option value="NORMAL">Normal</option><option value="HIGH">High</option><option value="URGENT">Urgent</option></select></label>
        </div>
        <div className="product-line-drawer__pair">
          <label>Follow-up date<input type="date" value={draft.followUpDate} onChange={(event) => setDraft({ ...draft, followUpDate: event.target.value })} /></label>
          <label>Dispatch schedule<input value={draft.dispatchSchedule} onChange={(event) => setDraft({ ...draft, dispatchSchedule: event.target.value })} placeholder="Courier, pickup, phased dispatch…" /></label>
        </div>
        <label>Follow-up note<textarea rows={3} value={draft.taskRemarks} onChange={(event) => setDraft({ ...draft, taskRemarks: event.target.value })} placeholder="Next action, customer response, person to contact…" /></label>
        <label>General notes<textarea rows={3} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
        <p className="order-info-drawer__hint">Changes apply to every item line belonging to this order.</p>
      </div>
      <footer><button className="button button--secondary" type="button" onClick={() => setDraft(null)}>Cancel</button><button className="button" type="button" disabled={busy || !draft.organisation.trim()} onClick={onSave}>{busy ? "Saving…" : "Save order information"}</button></footer>
    </aside>
  </div>;
}

export function ServiceOrderLineDrawer({ draft, setDraft, planning, products, busy, canManage, onSave }: {
  draft: SaveProductOrderInput;
  setDraft: (draft: SaveProductOrderInput | null) => void;
  planning: PlanningState;
  products: StoresState["stockItems"];
  busy: boolean;
  canManage: boolean;
  onSave: () => void;
}) {
  const current = draft.id ? planning.productOrders.find((order) => order.id === draft.id) : null;
  const stages = planning.productOrderWorkflowStates.filter((stage) => stage.orderType === "SERVICE");
  return <div className="product-line-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDraft(null); }}>
    <aside className="product-line-drawer" role="dialog" aria-modal="true" aria-label={draft.id ? "Edit order item" : "Add order item"}>
      <header><div><p className="eyebrow">{draft.id ? "EDIT SERVICE ORDER ITEM" : "NEW SERVICE ORDER ITEM"}</p><h2>{draft.externalReference || "New order"}</h2></div><button className="icon-button" type="button" onClick={() => setDraft(null)} aria-label="Close">×</button></header>
      <div className="product-line-drawer__body">
        <div className="product-line-order-fields">
          <label>Customer<input value={draft.organisation ?? ""} onChange={(event) => setDraft({ ...draft, organisation: event.target.value })} /></label>
          <label>Service order reference<input value={draft.externalReference} onChange={(event) => setDraft({ ...draft, externalReference: event.target.value })} /></label>
        </div>
        <label>Serial No<input value={draft.serialNumber ?? ""} onChange={(event) => setDraft({ ...draft, serialNumber: event.target.value })} placeholder="YYMM…" required /><small>{current ? warrantyLabel(current.warrantyStatus) : draftWarranty(draft.serialNumber ?? "")} · first four digits are manufacturing year and month.</small></label>
        <label>Product<select value={draft.productTallyGuid} onChange={(event) => setDraft({ ...draft, productTallyGuid: event.target.value })}><option value="">Select product…</option>{products.map((product) => <option key={product.tallyGuid} value={product.tallyGuid}>{product.name}</option>)}</select></label>
        <div className="product-line-drawer__pair"><label>Quantity ordered<input type="number" min={1} value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: Number(event.target.value) })} /></label><label>Remaining<input type="number" min={0} max={draft.quantity} value={draft.pendingQuantity ?? draft.quantity} onChange={(event) => setDraft({ ...draft, pendingQuantity: Number(event.target.value) })} /></label></div>
        <label>Stage<select value={draft.workflowStateId ?? ""} onChange={(event) => setDraft({ ...draft, workflowStateId: event.target.value })}>{stages.map((state) => <option key={state.id} value={state.id}>{stageLabel(state.name)}</option>)}</select><small>Servicing includes Fault Finding, Initial Testing, Burn Test, and Final Testing as separately timed stages.</small></label>
        <label>Owner<input value={draft.responsiblePerson ?? ""} onChange={(event) => setDraft({ ...draft, responsiblePerson: event.target.value })} /></label>
        <label>Required date<input type="date" value={draft.lastDispatchDate || draft.requiredDate || ""} onChange={(event) => setDraft({ ...draft, lastDispatchDate: event.target.value, requiredDate: event.target.value })} /></label>
        <label>Notes<textarea rows={3} value={draft.taskRemarks ?? ""} onChange={(event) => setDraft({ ...draft, taskRemarks: event.target.value })} /></label>
      </div>
      <footer><button className="button button--secondary" type="button" onClick={() => setDraft(null)}>Cancel</button><button className="button" type="button" disabled={busy || !canManage || !draft.productTallyGuid || !/^(\d{2})(0[1-9]|1[0-2])/.test(draft.serialNumber ?? "")} onClick={onSave}>Save service order</button></footer>
    </aside>
  </div>;
}
