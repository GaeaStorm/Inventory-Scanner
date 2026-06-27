import { useEffect, useState } from "react";

import { resolvePrimaryGroupFamily } from "../stores/item-family";
import type {
  ChecklistResult,
  FulfilmentConsumptionMode,
  Permission,
  PlanningState,
  SalesOrder,
  SalesOrderFulfilmentLine,
  StoresState,
} from "./types";

interface Props {
  order: SalesOrder;
  stores: StoresState;
  planning: PlanningState;
  permissions: Permission[];
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

const RESALE_STAGES = [
  "pending-supplier", "pending-order", "awaiting-delivery", "items-received",
  "items-repackaged", "awaiting-dispatch", "dispatched", "crac-generated",
];
const RAW_MATERIAL_STAGES = [
  "awaiting-restock", "items-received", "awaiting-dispatch", "dispatched", "crac-generated",
];

function stageLabel(stage: string): string {
  return stage.replaceAll(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function toneFor(status: string, kind: "order" | "approval" | "checklist" | "line"): string {
  if (kind === "order") {
    if (status === "COMPLETED") return "approved";
    if (status === "IN_FULFILMENT") return "confirmed";
    return "pending";
  }
  if (kind === "approval") {
    if (status === "APPROVED") return "approved";
    if (status === "REJECTED") return "rejected";
    if (status === "SUPERSEDED") return "obsolete";
    return "pending";
  }
  if (kind === "checklist") {
    if (status === "SATISFIED") return "approved";
    if (status === "WAIVED") return "needs-correction";
    return "rejected";
  }
  return ["dispatched", "crac-generated"].includes(status) ? "approved" : "pending";
}

function Status({ value, kind }: { value: string; kind: "order" | "approval" | "checklist" | "line" }) {
  return <span className={`review-status review-status--${toneFor(value, kind)}`}>{stageLabel(value)}</span>;
}

const holdStatusBadge: Record<string, { label: string; tone: string } | null> = {
  NONE: null,
  ON_HOLD: { label: "On Hold", tone: "needs-correction" },
  CANCELLED: { label: "Cancelled", tone: "rejected" },
};

function HoldStatus({ value }: { value: "NONE" | "ON_HOLD" | "CANCELLED" }) {
  const badge = holdStatusBadge[value];
  return badge ? <span className={`review-status review-status--${badge.tone}`}>{badge.label}</span> : null;
}

function ItemPicker({ stores, value, onChange, role }: {
  stores: StoresState;
  value: string;
  onChange: (value: string) => void;
  role?: "PRODUCT" | "MATERIAL";
}) {
  const [search, setSearch] = useState("");
  const items = stores.stockItems.filter((item) => !item.ignored && item.active)
    .filter((item) => role === "PRODUCT" ? item.isProduct : role === "MATERIAL" ? !item.isProduct : true)
    .filter((item) => !search.trim() || item.qualifiedName.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <div className="search-picker">
    <label>Item<input placeholder="Filter items…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <select aria-label="Item" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">Select…</option>
      {items.map((item) => <option key={item.tallyGuid} value={item.tallyGuid}>{item.qualifiedName}</option>)}
    </select>
  </div>;
}

function SupplierPicker({ stores, value, onChange }: { stores: StoresState; value: string; onChange: (value: string) => void }) {
  const [search, setSearch] = useState("");
  const suppliers = stores.suppliers.filter((supplier) => !search.trim() || supplier.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <div className="search-picker">
    <label>Supplier<input placeholder="Filter suppliers…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <select aria-label="Supplier" value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">Select…</option>
      {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
    </select>
  </div>;
}

function stageOptionsForLine(line: SalesOrderFulfilmentLine, planning: PlanningState): string[] {
  if (line.family === "RESALE") return RESALE_STAGES;
  if (line.family === "RAW_MATERIAL") return RAW_MATERIAL_STAGES;
  if (line.family === "MANUFACTURED") {
    const states = planning.productOrderWorkflowStates.filter((state) => state.orderType === "PRODUCTION");
    const materialPlanningPosition = states.find((state) => state.id === "material-planning")?.position ?? 0;
    return states.filter((state) => state.position >= materialPlanningPosition).map((state) => state.id);
  }
  return [];
}

function stageDisplayName(stageId: string, planning: PlanningState): string {
  const manufacturedState = planning.productOrderWorkflowStates.find((state) => state.id === stageId);
  return manufacturedState ? manufacturedState.name : stageLabel(stageId);
}

export default function CrfBuilder({ order, stores, planning, permissions, onBack, onRefresh, onNotice, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const [checklist, setChecklist] = useState<ChecklistResult[] | null>(null);
  const [newItemGuid, setNewItemGuid] = useState("");
  const [newParentId, setNewParentId] = useState("");
  const [newQuantity, setNewQuantity] = useState(1);
  const [newConsumptionMode, setNewConsumptionMode] = useState<FulfilmentConsumptionMode>("SOLD_DIRECT");
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.desktop.planning.getChecklistResultsForOrder(order.id)
      .then((result) => { if (!cancelled) setChecklist(result); })
      .catch(() => { if (!cancelled) setChecklist([]); });
    return () => { cancelled = true; };
  }, [order.id, order.updatedAt]);

  async function run(action: () => Promise<unknown>, message: string) {
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

  const newItem = stores.stockItems.find((item) => item.tallyGuid === newItemGuid);
  const newItemFamily = newItem ? resolvePrimaryGroupFamily(newItem.groupPath) : "UNKNOWN";
  const manufacturedLines = order.fulfilmentLines.filter((line) => line.family === "MANUFACTURED");

  async function addLine() {
    if (!newItemGuid) {
      onError("Choose an item for the new fulfilment line.");
      return;
    }
    await run(() => window.desktop.planning.addSalesOrderFulfilmentLine({
      salesOrderId: order.id,
      itemTallyGuid: newItemGuid,
      quantity: newQuantity,
      parentFulfilmentLineId: newParentId || undefined,
      consumptionMode: newItemFamily === "RAW_MATERIAL" ? newConsumptionMode : undefined,
    }), "Fulfilment line added.");
    setNewItemGuid("");
    setNewParentId("");
    setNewQuantity(1);
    setNewConsumptionMode("SOLD_DIRECT");
  }

  async function previewRevision(revisionId: string) {
    try {
      const html = await window.desktop.planning.getCrfHtml(revisionId);
      setPreviewHtml(html);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function printRevision(revisionId: string) {
    try {
      const html = await window.desktop.planning.getCrfHtml(revisionId);
      const result = await window.desktop.printHtml(html);
      if (!result.success) onError(result.failureReason ?? "Printing failed.");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveRevisionAsPdf(revisionId: string, revisionNumber: number) {
    try {
      const html = await window.desktop.planning.getCrfHtml(revisionId);
      const result = await window.desktop.planning.printCrfToPdf(html, `CRF-${order.customerName || order.id}-rev${revisionNumber}.pdf`);
      if (result.savedPath) onNotice(`Saved to ${result.savedPath}`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  const sourceChanged = order.sourceChanged;

  return <div className="order-detail-page">
    <button className="order-back-button" type="button" onClick={onBack}>← Back to Sales Orders</button>

    <header className="order-detail-heading">
      <div>
        <p className="eyebrow">CRF BUILDER</p>
        <h2>{order.customerName || "Customer not set"}</h2>
        <p>{order.poReference || "PO not set"} &middot; Voucher {order.voucherNumber || "—"}</p>
      </div>
      <div className="order-detail-heading__meta">
        <Status value={order.orderStage} kind="order" />
        <HoldStatus value={order.holdStatus} />
        {permissions.includes("SALES_ORDER_EDIT_CRF")
          ? <label>Promised dispatch<input type="date" value={order.dueDate} disabled={busy} onChange={(event) => void run(() => window.desktop.planning.setSalesOrderDueDate(order.id, event.target.value), "Due date updated.")} /></label>
          : <span>Promised dispatch: <strong>{order.dueDate || "Not set"}</strong></span>}
        <div className="inline-actions">
          {permissions.includes("SALES_ORDER_APPROVE_PO") && order.orderStage === "PENDING_PO_APPROVAL" && <button className="button" type="button" disabled={busy} onClick={() => void run(() => window.desktop.planning.requestPoApproval(order.id), "PO approval requested.")}>Request PO Approval</button>}
          {permissions.includes("SALES_ORDER_SUBMIT_CRF") && order.orderStage === "CRF_PENDING" && <button className="button" type="button" disabled={busy} onClick={() => void run(() => window.desktop.planning.submitCrfForApproval(order.id), "CRF submitted for approval.")}>Submit CRF for Approval</button>}
          {permissions.includes("SALES_ORDER_EDIT_CRF") && order.holdStatus !== "CANCELLED" && (order.holdStatus === "ON_HOLD"
            ? <button className="button button--secondary button--small" type="button" disabled={busy} onClick={() => void run(() => window.desktop.planning.setSalesOrderHoldStatus(order.id, "NONE"), "Order resumed.")}>Resume</button>
            : <button className="button button--secondary button--small" type="button" disabled={busy} onClick={() => void run(() => window.desktop.planning.setSalesOrderHoldStatus(order.id, "ON_HOLD"), "Order placed on hold.")}>Hold</button>)}
          {permissions.includes("SALES_ORDER_EDIT_CRF") && order.holdStatus !== "CANCELLED" && <button className="button button--secondary button--small" type="button" disabled={busy} onClick={() => void run(() => window.desktop.planning.setSalesOrderHoldStatus(order.id, "CANCELLED"), "Order cancelled.")}>Cancel</button>}
        </div>
      </div>
    </header>

    {sourceChanged && order.pendingSourceAmendment && <article className="panel" style={{ borderColor: "#b45309" }}>
      <div className="panel__header"><div><p className="eyebrow">TALLY AMENDMENT</p><h3>Source lines changed after fulfilment started</h3></div></div>
      <p>{order.pendingSourceAmendment.diffSummary}</p>
      <div className="inline-actions">
        {permissions.includes("SALES_ORDER_APPROVE_PO") && <button className="button" type="button" disabled={busy} onClick={() => void run(() => window.desktop.planning.applySourceAmendment(order.pendingSourceAmendment!.id), "Amendment applied.")}>Apply Amendment</button>}
        {permissions.includes("SALES_ORDER_SUBMIT_CRF") && <button className="button button--secondary" type="button" disabled={busy || sourceChanged} onClick={() => void run(() => window.desktop.planning.requestCrfReapproval(order.id), "CRF re-approval requested.")}>Request CRF Re-approval</button>}
      </div>
    </article>}

    <article className="panel">
      <div className="panel__header"><div><p className="eyebrow">TALLY SOURCE LINES</p><h3>Read-only</h3></div></div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Item</th><th>Family</th><th className="numeric">Qty</th><th className="numeric">Value</th></tr></thead>
          <tbody>
            {order.sourceLines.map((line) => <tr key={line.id}>
              <td>{line.itemQualifiedNameSnapshot}</td>
              <td>{line.family}</td>
              <td className="numeric">{line.quantity}</td>
              <td className="numeric">{line.value ?? "—"}</td>
            </tr>)}
            {order.sourceLines.length === 0 && <tr><td colSpan={4} className="empty-table">No Tally source lines.</td></tr>}
          </tbody>
        </table>
      </div>
    </article>

    <article className="panel">
      <div className="panel__header"><div><p className="eyebrow">FULFILMENT LINES</p><h3>{order.fulfilmentLines.length} lines</h3></div></div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Item</th><th>Family</th><th className="numeric">Qty</th><th>Consumption</th><th>Stage / Status</th><th /></tr></thead>
          <tbody>
            {order.fulfilmentLines.map((line) => {
              const depth = line.parentFulfilmentLineId ? 1 : 0;
              const stageOptions = stageOptionsForLine(line, planning);
              return <tr key={line.id}>
                <td>{"— ".repeat(depth)}{line.itemQualifiedName}</td>
                <td>{line.family}</td>
                <td className="numeric">{line.quantity}</td>
                <td>{line.consumptionMode === "INTERNAL_CONSUMPTION" ? "Internal Consumption" : "Sold Direct"}</td>
                <td>
                  {line.family === "SERVICE"
                    ? <label><input type="checkbox" checked={line.serviceDone} disabled={busy || !permissions.includes("SALES_ORDER_LINE_PROGRESS") || sourceChanged} onChange={(event) => void run(() => window.desktop.planning.setFulfilmentLineServiceDone(line.id, event.target.checked), "Service line updated.")} /> Done</label>
                    : line.consumptionMode === "INTERNAL_CONSUMPTION"
                      ? <span className="table-subtext">Uses Material Issue / reservations</span>
                      : <Status value={line.stage || "—"} kind="line" />}
                  {line.family === "RESALE" && <div className="table-subtext">{line.resaleSupplierName || "No supplier assigned"}</div>}
                  <HoldStatus value={line.holdStatus} />
                </td>
                <td>
                  {line.family !== "SERVICE" && line.consumptionMode !== "INTERNAL_CONSUMPTION" && permissions.includes("SALES_ORDER_LINE_PROGRESS") && <select
                    aria-label="Advance stage"
                    disabled={busy || sourceChanged}
                    value=""
                    onChange={(event) => { if (event.target.value) void run(() => window.desktop.planning.advanceFulfilmentLineStage(line.id, event.target.value), "Fulfilment line stage updated."); }}
                  >
                    <option value="">Advance to…</option>
                    {stageOptions.map((stage) => <option key={stage} value={stage}>{stageDisplayName(stage, planning)}</option>)}
                  </select>}
                  {line.family === "RESALE" && permissions.includes("SALES_ORDER_EDIT_CRF") && <ResaleSupplierAssign stores={stores} busy={busy} disabled={sourceChanged} onAssign={(supplierId) => void run(() => window.desktop.planning.assignResaleSupplier(line.id, supplierId), "Supplier assigned.")} />}
                  {permissions.includes("SALES_ORDER_LINE_PROGRESS") && line.holdStatus !== "CANCELLED" && <div className="inline-actions">
                    {line.holdStatus === "ON_HOLD"
                      ? <button className="button button--ghost button--small" type="button" disabled={busy} onClick={() => void run(() => window.desktop.planning.setFulfilmentLineHoldStatus(line.id, "NONE"), "Line resumed.")}>Resume</button>
                      : <button className="button button--ghost button--small" type="button" disabled={busy} onClick={() => void run(() => window.desktop.planning.setFulfilmentLineHoldStatus(line.id, "ON_HOLD"), "Line placed on hold.")}>Hold</button>}
                    <button className="button button--ghost button--small" type="button" disabled={busy} onClick={() => void run(() => window.desktop.planning.setFulfilmentLineHoldStatus(line.id, "CANCELLED"), "Line cancelled.")}>Cancel</button>
                  </div>}
                </td>
              </tr>;
            })}
            {order.fulfilmentLines.length === 0 && <tr><td colSpan={6} className="empty-table">No fulfilment lines yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {permissions.includes("SALES_ORDER_EDIT_CRF") && <div className="form-grid form-grid--four">
        <ItemPicker stores={stores} value={newItemGuid} onChange={setNewItemGuid} />
        <label>Quantity<input type="number" min={1} value={newQuantity} onChange={(event) => setNewQuantity(Number(event.target.value))} /></label>
        <label>Parent (Manufactured line, optional)<select value={newParentId} onChange={(event) => setNewParentId(event.target.value)}>
          <option value="">Top-level line</option>
          {manufacturedLines.map((line) => <option key={line.id} value={line.id}>{line.itemQualifiedName}</option>)}
        </select></label>
        {newItemFamily === "RAW_MATERIAL"
          ? <label>Consumption<select value={newConsumptionMode} onChange={(event) => setNewConsumptionMode(event.target.value as FulfilmentConsumptionMode)}>
              <option value="SOLD_DIRECT">Sold Direct</option>
              <option value="INTERNAL_CONSUMPTION">Internal Consumption</option>
            </select></label>
          : <button className="button" type="button" disabled={busy || !newItemGuid} onClick={() => void addLine()}>+ Add fulfilment line</button>}
      </div>}
      {newItemFamily === "RAW_MATERIAL" && permissions.includes("SALES_ORDER_EDIT_CRF") && <div className="inline-actions"><button className="button" type="button" disabled={busy || !newItemGuid} onClick={() => void addLine()}>+ Add fulfilment line</button></div>}
    </article>

    <article className="panel">
      <div className="panel__header"><div><p className="eyebrow">CHECKLIST</p><h3>{checklist?.length ?? 0} requirements</h3></div></div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Requirement</th><th>Status</th><th>Waiver</th><th /></tr></thead>
          <tbody>
            {(checklist ?? []).map((entry) => <tr key={entry.requirementId}>
              <td>{entry.description || entry.targetType}</td>
              <td><Status value={entry.status} kind="checklist" /></td>
              <td>{entry.status === "WAIVED" ? `${entry.waiverReason} (${entry.waiverActorName})` : "—"}</td>
              <td>{entry.status === "UNSATISFIED" && permissions.includes("SALES_ORDER_CHECKLIST_WAIVE") && <button className="button button--ghost button--small" type="button" disabled={busy} onClick={() => {
                const reason = window.prompt("Reason for waiving this requirement:");
                if (reason && reason.trim()) void run(() => window.desktop.planning.waiveChecklistRequirement(order.id, entry.requirementId, reason.trim()), "Requirement waived.");
              }}>Waive</button>}</td>
            </tr>)}
            {checklist != null && checklist.length === 0 && <tr><td colSpan={4} className="empty-table">No checklist template configured yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {permissions.includes("SALES_ORDER_CHECKLIST_CONFIGURE") && <ChecklistTemplateForm busy={busy} onSave={(input) => void run(() => window.desktop.planning.saveChecklistTemplate(input), "Checklist template saved.")} />}
    </article>

    <article className="panel">
      <div className="panel__header"><div><p className="eyebrow">APPROVALS</p><h3>{order.approvalRequests.length} requests</h3></div></div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Gate</th><th>Status</th><th>Decisions</th><th /></tr></thead>
          <tbody>
            {order.approvalRequests.map((request) => {
              const stage = request.entityType === "SALES_ORDER_STAGE"
                ? planning.salesOrderWorkflowStages.find((entry) => entry.orderKind === order.orderKind && entry.id === request.targetStage)
                : null;
              const requiredPermissions = stage?.requiredPermissions ?? [];
              const canDecide = request.status === "PENDING"
                && (request.entityType === "SALES_ORDER_PO" ? permissions.includes("SALES_ORDER_APPROVE_PO")
                  : request.entityType === "SALES_ORDER_CRF"
                    ? permissions.includes("SALES_ORDER_APPROVE_CRF_ACCOUNTS") || permissions.includes("SALES_ORDER_APPROVE_CRF_SALES")
                    : requiredPermissions.some((permission) => permissions.includes(permission as Permission)));
              return <tr key={request.id}>
                <td>{request.entityType === "SALES_ORDER_PO" ? "PO Approval" : request.entityType === "SALES_ORDER_CRF" ? "CRF Approval" : `Stage: ${stage?.name ?? request.targetStage}`}</td>
                <td><Status value={request.status} kind="approval" /></td>
                <td>{request.decisions.map((decision) => <div key={decision.id}>{decision.decidedByName} ({decision.decidedByRole}) — {decision.decision}{decision.comment ? `: ${decision.comment}` : ""}</div>)}</td>
                <td>{canDecide && <div className="inline-actions">
                  <button className="button button--small" type="button" disabled={busy} onClick={() => void run(() => window.desktop.planning.decideApproval(request.id, "APPROVE", ""), "Approved.")}>Approve</button>
                  <button className="button button--ghost button--small" type="button" disabled={busy} onClick={() => {
                    const comment = window.prompt("Reason for rejecting (required):");
                    if (comment && comment.trim()) void run(() => window.desktop.planning.decideApproval(request.id, "REJECT", comment.trim()), "Rejected.");
                  }}>Reject</button>
                </div>}</td>
              </tr>;
            })}
            {order.approvalRequests.length === 0 && <tr><td colSpan={4} className="empty-table">No approval requests yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </article>

    <article className="panel">
      <div className="panel__header"><div><p className="eyebrow">CRF REVISIONS</p><h3>{order.crfRevisions.length} revisions</h3></div></div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Revision</th><th>Created</th><th>Status</th><th /></tr></thead>
          <tbody>
            {order.crfRevisions.map((revision) => <tr key={revision.id}>
              <td>Revision {revision.revisionNumber}</td>
              <td>{revision.createdAt}</td>
              <td>{revision.supersededAt ? <Status value="SUPERSEDED" kind="approval" /> : <span className="review-status review-status--approved">Current</span>}</td>
              <td>{permissions.includes("SALES_ORDER_PRINT_CRF") && <div className="inline-actions">
                <button className="button button--ghost button--small" type="button" onClick={() => void previewRevision(revision.id)}>Preview</button>
                <button className="button button--ghost button--small" type="button" onClick={() => void printRevision(revision.id)}>Print</button>
                <button className="button button--ghost button--small" type="button" onClick={() => void saveRevisionAsPdf(revision.id, revision.revisionNumber)}>Save as PDF</button>
              </div>}</td>
            </tr>)}
            {order.crfRevisions.length === 0 && <tr><td colSpan={4} className="empty-table">No CRF has been submitted yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </article>

    {previewHtml != null && <div className="production-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewHtml(null); }}>
      <div className="production-modal">
        <header><h2>CRF Preview</h2><button className="icon-button" type="button" aria-label="Close" onClick={() => setPreviewHtml(null)}>×</button></header>
        <iframe title="CRF preview" srcDoc={previewHtml} style={{ width: "100%", height: "100%", border: 0 }} />
        <footer><button className="button button--secondary" type="button" onClick={() => setPreviewHtml(null)}>Close</button></footer>
      </div>
    </div>}
  </div>;
}

function ResaleSupplierAssign({ stores, busy, disabled, onAssign }: { stores: StoresState; busy: boolean; disabled: boolean; onAssign: (supplierId: number) => void }) {
  const [supplierId, setSupplierId] = useState("");
  return <div className="inline-actions">
    <SupplierPicker stores={stores} value={supplierId} onChange={setSupplierId} />
    <button className="button button--small" type="button" disabled={busy || disabled || !supplierId} onClick={() => onAssign(Number(supplierId))}>Assign</button>
  </div>;
}

function ChecklistTemplateForm({ busy, onSave }: { busy: boolean; onSave: (input: { name: string; requirements: Array<{ targetType: string; targetValue: string; description: string }> }) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [requirements, setRequirements] = useState<Array<{ targetType: string; targetValue: string; description: string }>>([
    { targetType: "PRIMARY_GROUP", targetValue: "", description: "" },
  ]);

  if (!open) return <button className="text-button" type="button" onClick={() => setOpen(true)}>Manage checklist template</button>;

  return <div className="panel operations-panel">
    <label>Template name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
    {requirements.map((requirement, index) => <div className="form-grid form-grid--three" key={index}>
      <label>Target type<select value={requirement.targetType} onChange={(event) => setRequirements(requirements.map((entry, entryIndex) => entryIndex === index ? { ...entry, targetType: event.target.value } : entry))}>
        <option value="EXACT_ITEM">Exact item</option>
        <option value="GROUP_SUBTREE">Group subtree</option>
        <option value="PRIMARY_GROUP">Primary group</option>
        <option value="TOP_LEVEL_LINES">Top-level lines</option>
        <option value="CHILDREN_OF_MANUFACTURED">Children of Manufactured</option>
        <option value="EACH_MANUFACTURED_PRODUCT">Each Manufactured product</option>
      </select></label>
      <label>Target value<input value={requirement.targetValue} onChange={(event) => setRequirements(requirements.map((entry, entryIndex) => entryIndex === index ? { ...entry, targetValue: event.target.value } : entry))} placeholder="e.g. MANUFACTURED, item GUID, group name" /></label>
      <label>Description<input value={requirement.description} onChange={(event) => setRequirements(requirements.map((entry, entryIndex) => entryIndex === index ? { ...entry, description: event.target.value } : entry))} /></label>
    </div>)}
    <div className="inline-actions">
      <button className="button button--secondary button--small" type="button" onClick={() => setRequirements([...requirements, { targetType: "PRIMARY_GROUP", targetValue: "", description: "" }])}>+ Add requirement</button>
      <button className="button button--small" type="button" disabled={busy || !name.trim()} onClick={() => { onSave({ name: name.trim(), requirements }); setOpen(false); setName(""); setRequirements([{ targetType: "PRIMARY_GROUP", targetValue: "", description: "" }]); }}>Save template</button>
      <button className="text-button" type="button" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  </div>;
}
