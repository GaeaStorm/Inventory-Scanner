import { useEffect, useMemo, useState } from "react";

import { finishedProductItems } from "./stock-item-visibility";
import type {
  AuthUser,
  PlanningState,
  ProductOrder,
  SaveProductOrderInput,
  StoresState,
} from "./types";

interface Props {
  planning: PlanningState;
  stores: StoresState;
  currentUser: AuthUser | null;
  canManage: boolean;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

type QuickFilter = "all" | "overdue" | "blocked" | "dispatched";
type OrderTypeFilter = "" | ProductOrder["orderType"];
const FILTER_STORAGE_KEY = "inventory-scanner.order-filter";

interface OrderGroup {
  key: string;
  orderType: ProductOrder["orderType"];
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
  crfStatus: string;
  cracStatus: string;
  taskRemarks: string;
  notes: string;
}

const today = () => new Date().toISOString().slice(0, 10);

function orderKey(line: ProductOrder): string {
  return [
    line.orderType,
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

function isBlocked(line: ProductOrder): boolean {
  if (line.orderType === "SERVICE") return false;
  return ["AT_RISK", "SHORT_COMPONENTS", "BOM_INCOMPLETE"].includes(line.feasibility)
    || Boolean(line.pendingMaterial.trim() || line.rawMaterialToOrder.trim());
}

function isReady(line: ProductOrder): boolean {
  const state = line.workflowStateName.toLocaleLowerCase();
  return line.status === "COMPLETED" || state === "dispatched" || state === "crac generated" || state === "service · dispatch";
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
  if (group.lines.some(isReady) && openLines.length) return { label: "Partially dispatched", tone: "warning" };
  if (group.lines.length > 0 && group.lines.every(isReady)) return { label: "Dispatched", tone: "success" };
  return { label: "On track", tone: "neutral" };
}

function toDraft(line: ProductOrder): SaveProductOrderInput {
  return {
    id: line.id,
    orderType: line.orderType,
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

function newDraft(planning: PlanningState, orderType: ProductOrder["orderType"], group?: OrderGroup): SaveProductOrderInput {
  const first = group?.lines[0];
  const type = first?.orderType ?? orderType;
  return {
    orderType: type,
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
    priority: first?.priority ?? (type === "SERVICE" ? "LOW" : ""),
    requiredDate: first?.requiredDate ?? today(),
    status: "CONFIRMED",
    workflowStateId: planning.productOrderWorkflowStates.find((stage) => stage.orderType === type)?.id ?? "",
    notes: "",
    customFields: {},
  };
}

function orderInfoDraft(group: OrderGroup): OrderInfoDraft {
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
    priority: first?.priority ?? (group.orderType === "SERVICE" ? "LOW" : ""),
    crfStatus: first?.crfStatus ?? "",
    cracStatus: first?.cracStatus ?? "",
    taskRemarks: first?.taskRemarks ?? "",
    notes: first?.notes ?? "",
  };
}

export default function OrderRegister({ planning, stores, currentUser, canManage, onRefresh, onNotice, onError }: Props) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [orderType, setOrderType] = useState<OrderTypeFilter>("");
  const [due, setDue] = useState("");
  const [owner, setOwner] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [followUpOnly, setFollowUpOnly] = useState(false);
  const [myOrders, setMyOrders] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [bulkOwner, setBulkOwner] = useState("");
  const [bulkPriority, setBulkPriority] = useState("");
  const [bulkStage, setBulkStage] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [draft, setDraft] = useState<SaveProductOrderInput | null>(null);
  const [infoDraft, setInfoDraft] = useState<OrderInfoDraft | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) ?? "{}") as {
        orderType?: OrderTypeFilter; due?: string; owner?: string; quickFilter?: QuickFilter; myOrders?: boolean;
      };
      setOrderType(saved.orderType ?? "");
      setDue(saved.due ?? "");
      setOwner(saved.owner ?? "");
      setQuickFilter(saved.quickFilter ?? "all");
      setMyOrders(Boolean(saved.myOrders));
    } catch {
      // Ignore an invalid local preference and use the defaults.
    }
  }, []);

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
        orderType: line.orderType,
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
    })).sort((left, right) =>
      (left.orderType === right.orderType ? 0 : left.orderType === "PRODUCTION" ? -1 : 1)
      || (left.dueDate || "9999").localeCompare(right.dueDate || "9999"));
  }, [planning.productOrders]);

  const owners = [...new Set(planning.productOrders.map((line) => line.responsiblePerson).filter(Boolean))].sort();
  const filteredGroups = groups.filter((group) => {
    const groupAttention = attention(group);
    const haystack = `${group.organisation} ${group.reference} ${group.fileNumber} ${group.lines.map((line) => `${line.productName} ${line.serialNumber} ${line.responsiblePerson} ${line.workflowStateName} ${line.taskRemarks} ${line.notes} ${line.crfStatus} ${line.cracStatus}`).join(" ")}`.toLocaleLowerCase();
    const dueDate = group.dueDate;
    const dueMatch = !due
      || (due === "overdue" && Boolean(dueDate && dueDate < today()))
      || (due === "week" && Boolean(dueDate && dueDate >= today() && dueDate <= new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)))
      || (due === "unset" && !dueDate);
    return (!search || haystack.includes(search.toLocaleLowerCase()))
      && (!orderType || group.orderType === orderType)
      && (!status || group.lines.some((line) => line.workflowStateId === status))
      && (!owner || group.lines.some((line) => line.responsiblePerson === owner))
      && (!myOrders || group.lines.some((line) => [currentUser?.displayName, currentUser?.username, currentUser?.auditIdentity].filter(Boolean).some((identity) => line.responsiblePerson.toLocaleLowerCase() === String(identity).toLocaleLowerCase())))
      && (!followUpOnly || group.lines.some((line) => line.followUpDate && line.followUpDate <= today()))
      && dueMatch
      && (quickFilter === "all"
        || (quickFilter === "overdue" && groupAttention.label === "Overdue")
        || (quickFilter === "blocked" && groupAttention.label === "Material blocked")
        || (quickFilter === "dispatched" && groupAttention.label === "Dispatched"));
  });

  const selected = groups.find((group) => group.key === selectedKey) ?? null;
  const openOrders = groups.filter((group) => group.lines.some((line) => !isReady(line)));
  const overdueCount = openOrders.filter((group) => Boolean(groupDueDate(group) && groupDueDate(group) < today())).length;
  const followUpDue = openOrders.filter((group) => group.lines.some((line) => line.followUpDate && line.followUpDate <= today())).length;
  const awaitingApproval = openOrders.filter((group) => group.lines.some((line) => line.workflowStateId === "service-estimate-approval")).length;
  const awaitingPayment = openOrders.filter((group) => group.lines.some((line) => line.workflowStateId === "service-payment")).length;
  const readyDispatch = openOrders.filter((group) => group.lines.some((line) => ["pending-dispatch", "service-dispatch"].includes(line.workflowStateId))).length;
  const selectedTypes = new Set(planning.productOrders.filter((line) => selectedOrders.has(line.id)).map((line) => line.orderType));

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

  async function saveOrderInfo(group: OrderGroup) {
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
      const nextKey = [
        group.orderType,
        infoDraft.organisation.trim().toLocaleLowerCase(),
        (infoDraft.externalReference || infoDraft.fileNumber || group.lines[0]?.id || "").trim().toLocaleLowerCase(),
      ].join("::");
      setSelectedKey(nextKey);
      await onRefresh();
      onNotice("Order information updated across all lines.");
      setInfoDraft(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function saveFilters() {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({ orderType, due, owner, quickFilter, myOrders }));
    onNotice("Order filters saved on this computer.");
  }

  function nextStage(line: ProductOrder) {
    const stages = planning.productOrderWorkflowStates.filter((stage) => stage.orderType === line.orderType);
    const currentIndex = stages.findIndex((stage) => stage.id === line.workflowStateId);
    return stages.slice(currentIndex + 1).find((stage) =>
      stage.id !== "quality-control" || line.stageHistory.some((entry) => entry.stateId === "material-purchase")) ?? null;
  }

  async function advanceGroup(group: OrderGroup) {
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

  async function applyBulkUpdate() {
    const orderIds = [...selectedOrders];
    if (orderIds.length === 0 || (!bulkOwner && !bulkPriority && !bulkStage)) return;
    setBusy(true);
    onError("");
    try {
      await window.desktop.planning.bulkUpdateProductOrders({
        orderIds,
        responsiblePerson: bulkOwner || undefined,
        priority: bulkPriority || undefined,
        workflowStateId: bulkStage || undefined,
      });
      await onRefresh();
      setSelectedOrders(new Set());
      setBulkOwner("");
      setBulkPriority("");
      setBulkStage("");
      onNotice(`Updated ${orderIds.length} order item${orderIds.length === 1 ? "" : "s"}.`);
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
        <div><div className="order-detail-type-row"><p className="eyebrow">ORDER DETAIL</p><span className={`order-type-badge order-type-badge--${selected.orderType.toLocaleLowerCase()}`}>{selected.orderType === "SERVICE" ? "Service Order" : "Production Order"}</span></div><h2>{selected.organisation}</h2><p>{selected.reference}</p></div>
        <div className="order-detail-heading__meta"><span>Promised dispatch: <strong>{displayDate(selected.dueDate)}</strong></span><span className={`order-attention order-attention--${health.tone}`}>{health.label}</span>{canManage && <div className="inline-actions"><button className="button button--secondary button--small" type="button" onClick={() => setInfoDraft(orderInfoDraft(selected))}>Edit order information</button><button className="button button--small" type="button" disabled={busy || selected.lines.every((line) => !nextStage(line))} onClick={() => void advanceGroup(selected)}>Advance to next stage</button></div>}</div>
      </header>
      <div className="order-detail-layout">
        <article className="order-detail-card order-detail-card--lines">
          <div className="order-detail-card__header"><div><p className="eyebrow">ORDER ITEMS</p><h3>{completed} of {ordered} units complete</h3></div>{canManage && <button className="button button--secondary" type="button" onClick={() => setDraft(newDraft(planning, selected.orderType, selected))}>+ Add item</button>}</div>
          <div className="order-lines-table">
            <div className="order-lines-table__head"><span>Product</span><span>Qty</span><span>Stage</span><span>Complete</span><span>Blocker</span></div>
            {selected.lines.map((line) => <button className="order-lines-table__row" type="button" key={line.id} onClick={() => setDraft(toDraft(line))}>
              <strong>{line.productName}{line.orderType === "SERVICE" && <small className="table-subtext">{line.serialNumber} · {warrantyLabel(line.warrantyStatus)}</small>}</strong><span>{line.quantity}</span><span>{stageLabel(line.workflowStateName)}</span><span>{completedQuantity(line)} / {line.quantity}</span><span className={isBlocked(line) ? "danger-text" : ""}>{isBlocked(line) ? line.pendingMaterial || line.rawMaterialToOrder || "Material shortage" : "—"}</span>
            </button>)}
          </div>
        </article>
        <aside className="order-detail-card order-detail-sidebar">
          <div><p className="eyebrow">ORDER INFORMATION</p><dl><div><dt>File No</dt><dd>{first?.fileNumber || "Not set"}</dd></div><div><dt>Order date</dt><dd>{displayDate(first?.purchaseOrderDate || "")}</dd></div>{selected.orderType === "SERVICE" ? <><div><dt>Serial No</dt><dd>{first?.serialNumber || "Not set"}</dd></div><div><dt>Warranty</dt><dd>{first ? warrantyLabel(first.warrantyStatus) : "Not set"}</dd></div></> : <><div><dt>CRF</dt><dd>{first?.crfStatus || "Not set"}</dd></div><div><dt>CRAC</dt><dd>{first?.cracStatus || "Not set"}</dd></div></>}<div><dt>Owner</dt><dd>{selected.owner || "Unassigned"}</dd></div><div><dt>Priority</dt><dd>{first?.priority || "Not set"}</dd></div><div><dt>Dispatch schedule</dt><dd>{first?.dispatchSchedule || "Not set"}</dd></div></dl></div>
          <div><p className="eyebrow">NEXT FOLLOW-UP</p><strong>{displayDate(first?.followUpDate || "")}</strong><p>{first?.taskRemarks || first?.notes || "No follow-up note recorded."}</p></div>
        </aside>
      </div>
      <article className="order-activity">
        <p className="eyebrow">RECENT ACTIVITY</p>
        {selected.lines.flatMap((line) => line.activity.map((activity) => ({ ...activity, productName: line.productName }))).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 30).map((activity) => <div key={activity.id}><time>{new Date(activity.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</time><span><strong>{activity.actorName}</strong> · {activity.summary}<small className="table-subtext">{activity.productName}</small></span></div>)}
      </article>
      {draft && <LineDrawer draft={draft} setDraft={setDraft} planning={planning} products={products} busy={busy} canManage={canManage} onSave={() => void saveLine()} />}
      {infoDraft && <OrderInfoDrawer orderType={selected.orderType} draft={infoDraft} setDraft={setInfoDraft} busy={busy} onSave={() => void saveOrderInfo(selected)} />}
    </div>;
  }

  return <div className="order-register">
    <section className="order-action-summary" aria-label="Order attention summary">
      <button type="button" onClick={() => { setFollowUpOnly(false); setQuickFilter("overdue"); setDue("overdue"); }}><span>Overdue</span><strong>{overdueCount}</strong></button>
      <button type="button" onClick={() => { setDue(""); setQuickFilter("all"); setSearch(""); setFollowUpOnly(true); }}><span>Follow-up due</span><strong>{followUpDue}</strong></button>
      <button type="button" onClick={() => { setFollowUpOnly(false); setOrderType("SERVICE"); setStatus("service-estimate-approval"); }}><span>Awaiting approval</span><strong>{awaitingApproval}</strong></button>
      <button type="button" onClick={() => { setFollowUpOnly(false); setOrderType("SERVICE"); setStatus("service-payment"); }}><span>Awaiting payment</span><strong>{awaitingPayment}</strong></button>
      <button type="button" onClick={() => { setFollowUpOnly(false); setStatus(""); setQuickFilter("all"); setSearch("dispatch"); }}><span>Dispatch queue</span><strong>{readyDispatch}</strong></button>
    </section>
    <div className="order-register-toolbar">
      <input className="order-register-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search orders…" />
      <select value={orderType} onChange={(event) => { setOrderType(event.target.value as OrderTypeFilter); setStatus(""); }}><option value="">All order types</option><option value="PRODUCTION">Production Orders</option><option value="SERVICE">Service Orders</option></select>
      <select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All stages</option>{planning.productOrderWorkflowStates.filter((stage) => !orderType || stage.orderType === orderType).map((stage) => <option key={stage.id} value={stage.id}>{stage.orderType === "SERVICE" ? `Service · ${stageLabel(stage.name)}` : stage.name}</option>)}</select>
      <select value={due} onChange={(event) => setDue(event.target.value)}><option value="">Any due date</option><option value="overdue">Overdue</option><option value="week">Due this week</option><option value="unset">Date not set</option></select>
      <select value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">All owners</option>{owners.map((entry) => <option key={entry}>{entry}</option>)}</select>
      {canManage && <><button className="button" type="button" onClick={() => setDraft(newDraft(planning, "PRODUCTION"))}>+ Production Order</button><button className="button button--secondary" type="button" onClick={() => setDraft(newDraft(planning, "SERVICE"))}>+ Service Order</button></>}
    </div>
    <div className="order-quick-filters" aria-label="Quick order filters">
      {(["all", "overdue", "blocked", "dispatched"] as QuickFilter[]).map((value) => <button type="button" key={value} className={quickFilter === value ? "active" : ""} onClick={() => setQuickFilter(value)}>{value === "all" ? "All" : value[0].toLocaleUpperCase() + value.slice(1)}</button>)}
      <button type="button" className={myOrders ? "active" : ""} onClick={() => setMyOrders((value) => !value)}>My Orders</button>
      <button type="button" onClick={saveFilters}>Save filters</button>
      <button type="button" onClick={() => { localStorage.removeItem(FILTER_STORAGE_KEY); setOrderType(""); setStatus(""); setDue(""); setOwner(""); setQuickFilter("all"); setMyOrders(false); setFollowUpOnly(false); setSearch(""); }}>Reset</button>
    </div>
    {selectedOrders.size > 0 && <div className="order-bulk-toolbar">
      <strong>{selectedOrders.size} item{selectedOrders.size === 1 ? "" : "s"} selected</strong>
      <input value={bulkOwner} onChange={(event) => setBulkOwner(event.target.value)} placeholder="Set owner" />
      <select value={bulkPriority} onChange={(event) => setBulkPriority(event.target.value)}><option value="">Keep priority</option><option value="LOW">Low</option><option value="NORMAL">Normal</option><option value="HIGH">High</option><option value="URGENT">Urgent</option></select>
      <select value={bulkStage} onChange={(event) => setBulkStage(event.target.value)} disabled={selectedTypes.size !== 1}><option value="">{selectedTypes.size === 1 ? "Keep stage" : "Select one order type for stage"}</option>{planning.productOrderWorkflowStates.filter((stage) => selectedTypes.has(stage.orderType)).map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select>
      <button className="button button--small" type="button" disabled={busy || (!bulkOwner && !bulkPriority && !bulkStage)} onClick={() => void applyBulkUpdate()}>Apply</button>
      <button className="text-button" type="button" onClick={() => setSelectedOrders(new Set())}>Clear</button>
    </div>}
    <div className="order-register-table">
      <div className="order-register-row order-register-row--head"><span /><span /><span>Due</span><span>Customer / Order</span><span>Lines</span><span>Progress</span><span>Attention</span><span>Owner</span></div>
      {filteredGroups.map((group) => {
        const open = expanded.has(group.key);
        const ordered = group.lines.reduce((sum, line) => sum + line.quantity, 0);
        const completed = group.lines.reduce((sum, line) => sum + completedQuantity(line), 0);
        const percent = ordered ? Math.round((completed / ordered) * 100) : 0;
        const groupAttention = attention(group);
        return <div className="order-register-group" key={group.key}>
          <div className="order-register-row">
            <input type="checkbox" aria-label={`Select ${group.reference}`} checked={group.lines.every((line) => selectedOrders.has(line.id))} onChange={(event) => setSelectedOrders((current) => {
              const next = new Set(current);
              for (const line of group.lines) event.target.checked ? next.add(line.id) : next.delete(line.id);
              return next;
            })} />
            <button className="order-expand-button" type="button" aria-label={open ? "Collapse order" : "Expand order"} onClick={() => toggleExpanded(group.key)}>{open ? "⌄" : "›"}</button>
            <span className={group.dueDate && group.dueDate < today() && completed < ordered ? "danger-text" : ""}>{displayDate(group.dueDate)}</span>
            <button className="order-link-button" type="button" onClick={() => setSelectedKey(group.key)}><strong>{group.organisation}</strong><span>{group.orderType === "SERVICE" ? "SERVICE · " : "PRODUCTION · "}{group.reference}</span></button>
            <span>{group.lines.length} line{group.lines.length === 1 ? "" : "s"}</span>
            <div className="order-progress"><span>{completed} of {ordered} complete</span><i><b style={{ width: `${percent}%` }} /></i></div>
            <span><span className={`order-attention order-attention--${groupAttention.tone}`}>{groupAttention.label}</span></span>
            <span>{group.owner || "Unassigned"}</span>
          </div>
          {open && <div className="order-expanded-lines">
            <div className="order-expanded-lines__head"><span>Product</span><span>Qty</span><span>Stage</span><span>Blocker</span><span>Complete</span></div>
            {group.lines.map((line) => <button type="button" className="order-expanded-lines__row" key={line.id} onClick={() => setDraft(toDraft(line))}><strong>{line.productName}{line.orderType === "SERVICE" && <small className="table-subtext">{line.serialNumber} · {warrantyLabel(line.warrantyStatus)}</small>}</strong><span>{line.quantity}</span><span>{stageLabel(line.workflowStateName)}</span><span className={isBlocked(line) ? "danger-text" : ""}>{isBlocked(line) ? line.pendingMaterial || line.rawMaterialToOrder || "Material shortage" : "—"}</span><span>{completedQuantity(line)} / {line.quantity}</span></button>)}
          </div>}
        </div>;
      })}
      {filteredGroups.length === 0 && <div className="order-register-empty">No purchase orders match these filters.</div>}
    </div>
    {draft && <LineDrawer draft={draft} setDraft={setDraft} planning={planning} products={products} busy={busy} canManage={canManage} onSave={() => void saveLine()} />}
  </div>;
}

function OrderInfoDrawer({ orderType, draft, setDraft, busy, onSave }: {
  orderType: ProductOrder["orderType"];
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
          <label>{orderType === "SERVICE" ? "Service order reference" : "Purchase order"}<input value={draft.externalReference} onChange={(event) => setDraft({ ...draft, externalReference: event.target.value })} /></label>
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
        {orderType === "PRODUCTION" && <div className="product-line-drawer__pair">
          <label>CRF status<input value={draft.crfStatus} onChange={(event) => setDraft({ ...draft, crfStatus: event.target.value })} /></label>
          <label>CRAC status<input value={draft.cracStatus} onChange={(event) => setDraft({ ...draft, cracStatus: event.target.value })} /></label>
        </div>}
        <label>Follow-up note<textarea rows={3} value={draft.taskRemarks} onChange={(event) => setDraft({ ...draft, taskRemarks: event.target.value })} placeholder="Next action, customer response, person to contact…" /></label>
        <label>General notes<textarea rows={3} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
        <p className="order-info-drawer__hint">Changes apply to every item line belonging to this order.</p>
      </div>
      <footer><button className="button button--secondary" type="button" onClick={() => setDraft(null)}>Cancel</button><button className="button" type="button" disabled={busy || !draft.organisation.trim()} onClick={onSave}>{busy ? "Saving…" : "Save order information"}</button></footer>
    </aside>
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
  const current = draft.id ? planning.productOrders.find((order) => order.id === draft.id) : null;
  const orderType = draft.orderType ?? "PRODUCTION";
  const materialPurchaseOccurred = current?.stageHistory.some((entry) => entry.stateId === "material-purchase")
    || draft.workflowStateId === "material-purchase";
  const stages = planning.productOrderWorkflowStates.filter((stage) =>
    stage.orderType === orderType
    && (stage.id !== "quality-control" || materialPurchaseOccurred));
  return <div className="product-line-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDraft(null); }}>
    <aside className="product-line-drawer" role="dialog" aria-modal="true" aria-label={draft.id ? "Edit order item" : "Add order item"}>
      <header><div><p className="eyebrow">{draft.id ? "EDIT ORDER ITEM" : "NEW ORDER ITEM"}</p><h2>{draft.externalReference || "New order"}</h2></div><button className="icon-button" type="button" onClick={() => setDraft(null)} aria-label="Close">×</button></header>
      <div className="product-line-drawer__body">
        <label>Order type<select value={orderType} disabled={Boolean(draft.id)} onChange={(event) => {
          const nextType = event.target.value as ProductOrder["orderType"];
          setDraft({
            ...draft,
            orderType: nextType,
            serialNumber: "",
            priority: nextType === "SERVICE" ? "LOW" : "",
            workflowStateId: planning.productOrderWorkflowStates.find((stage) => stage.orderType === nextType)?.id ?? "",
          });
        }}><option value="PRODUCTION">Production Order</option><option value="SERVICE">Service Order</option></select></label>
        <div className="product-line-order-fields">
          <label>Customer<input value={draft.organisation ?? ""} onChange={(event) => setDraft({ ...draft, organisation: event.target.value })} /></label>
          <label>{orderType === "SERVICE" ? "Service order reference" : "Purchase order"}<input value={draft.externalReference} onChange={(event) => setDraft({ ...draft, externalReference: event.target.value })} /></label>
        </div>
        {orderType === "SERVICE" && <label>Serial No<input value={draft.serialNumber ?? ""} onChange={(event) => setDraft({ ...draft, serialNumber: event.target.value })} placeholder="YYMM…" required /><small>{current ? warrantyLabel(current.warrantyStatus) : draftWarranty(draft.serialNumber ?? "")} · first four digits are manufacturing year and month.</small></label>}
        <label>Product<select value={draft.productTallyGuid} onChange={(event) => setDraft({ ...draft, productTallyGuid: event.target.value })}><option value="">Select product…</option>{products.map((product) => <option key={product.tallyGuid} value={product.tallyGuid}>{product.name}</option>)}</select></label>
        <div className="product-line-drawer__pair"><label>Quantity ordered<input type="number" min={1} value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: Number(event.target.value) })} /></label><label>Remaining<input type="number" min={0} max={draft.quantity} value={draft.pendingQuantity ?? draft.quantity} onChange={(event) => setDraft({ ...draft, pendingQuantity: Number(event.target.value) })} /></label></div>
        <label>Stage<select value={draft.workflowStateId ?? ""} onChange={(event) => setDraft({ ...draft, workflowStateId: event.target.value })}>{stages.map((state) => <option key={state.id} value={state.id}>{stageLabel(state.name)}</option>)}</select>{orderType === "PRODUCTION" && !materialPurchaseOccurred && <small>Quality Control appears after Material Purchase has been used.</small>}{orderType === "SERVICE" && <small>Servicing includes Fault Finding, Initial Testing, Burn Test, and Final Testing as separately timed stages.</small>}</label>
        <label>Owner<input value={draft.responsiblePerson ?? ""} onChange={(event) => setDraft({ ...draft, responsiblePerson: event.target.value })} /></label>
        <label>Required date<input type="date" value={draft.lastDispatchDate || draft.requiredDate || ""} onChange={(event) => setDraft({ ...draft, lastDispatchDate: event.target.value, requiredDate: event.target.value })} /></label>
        {orderType === "PRODUCTION" && <label>Material blocker<textarea rows={2} placeholder="Leave blank when material is available" value={draft.pendingMaterial ?? ""} onChange={(event) => setDraft({ ...draft, pendingMaterial: event.target.value })} /></label>}
        <label>Notes<textarea rows={3} value={draft.taskRemarks ?? ""} onChange={(event) => setDraft({ ...draft, taskRemarks: event.target.value })} /></label>
      </div>
      <footer><button className="button button--secondary" type="button" onClick={() => setDraft(null)}>Cancel</button><button className="button" type="button" disabled={busy || !canManage || !draft.productTallyGuid || (orderType === "SERVICE" && !/^(\d{2})(0[1-9]|1[0-2])/.test(draft.serialNumber ?? ""))} onClick={onSave}>Save {orderType === "SERVICE" ? "service order" : "product line"}</button></footer>
    </aside>
  </div>;
}
