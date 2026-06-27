import { useMemo, useState } from "react";

import CrfBuilder from "./CrfBuilder";
import ServiceOrderDetail, {
  buildServiceOrderGroups,
  newServiceOrderDraft,
  serviceOrderAttention,
  serviceOrderProductOptions,
  ServiceOrderLineDrawer,
  type ServiceOrderGroup,
} from "./ServiceOrderRegister";
import type {
  AuthUser,
  Permission,
  PlanningState,
  SalesOrder,
  SaveProductOrderInput,
  SaveProductOrderWorkflowStateInput,
  SaveSalesOrderInput,
  SaveSalesOrderWorkflowStageInput,
  StoresState,
} from "./types";

interface Props {
  stores: StoresState;
  planning: PlanningState;
  currentUser: AuthUser | null;
  permissions: Permission[];
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

interface MergedRow {
  kind: "SALES" | "SERVICE";
  key: string;
  displayType: string;
  dueDate: string;
  customer: string;
  reference: string;
  statusLabel: string;
  statusTone: string;
  lines: number;
  owner: string;
  inactive: boolean;
  salesOrder?: SalesOrder;
  serviceGroup?: ServiceOrderGroup;
}

function stageLabel(stage: string): string {
  return stage.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function salesStageTone(stage: SalesOrder["orderStage"]): string {
  if (stage === "COMPLETED") return "approved";
  if (stage === "IN_FULFILMENT") return "confirmed";
  return "pending";
}

function salesStatus(order: SalesOrder): { label: string; tone: string; inactive: boolean } {
  if (order.holdStatus === "CANCELLED") return { label: "Cancelled", tone: "rejected", inactive: true };
  if (order.holdStatus === "ON_HOLD") return { label: "On Hold", tone: "needs-correction", inactive: false };
  if (order.orderStage === "COMPLETED") return { label: "Complete", tone: "approved", inactive: true };
  return { label: stageLabel(order.orderStage), tone: salesStageTone(order.orderStage), inactive: false };
}

function displayDate(value: string): string {
  if (!value) return "Not set";
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

const today = () => new Date().toISOString().slice(0, 10);

function newSalesOrderDraft(): SaveSalesOrderInput {
  return {
    orderKind: "SALES",
    customerName: "",
    poReference: "",
    voucherDate: today(),
    dueDate: "",
    sourceLines: [{ itemTallyGuid: "", quantity: 1, value: null }],
  };
}

export default function OrderRegister({ stores, planning, permissions, onRefresh, onNotice, onError }: Props) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"" | "SALES" | "SERVICE">("");
  const [selectedRow, setSelectedRow] = useState<MergedRow | null>(null);
  const [creatingSalesOrder, setCreatingSalesOrder] = useState<SaveSalesOrderInput | null>(null);
  const [creatingServiceOrder, setCreatingServiceOrder] = useState<SaveProductOrderInput | null>(null);
  const [workflowDraft, setWorkflowDraft] = useState<SaveSalesOrderWorkflowStageInput | null>(null);
  const [itemWorkflowDraft, setItemWorkflowDraft] = useState<SaveProductOrderWorkflowStateInput | null>(null);
  const [busy, setBusy] = useState(false);

  const canManageServiceOrders = permissions.includes("PRODUCT_ORDER_MANAGE");
  const canEditSalesOrders = permissions.includes("SALES_ORDER_EDIT_CRF");
  const canConfigureWorkflow = permissions.includes("SALES_ORDER_CHECKLIST_CONFIGURE");
  const canConfigureItemWorkflow = permissions.includes("PRODUCT_ORDER_MANAGE");
  const canExportVouchers = permissions.includes("TALLY_REVIEW");
  const products = useMemo(() => serviceOrderProductOptions(stores), [stores]);
  const orderLineItems = useMemo(
    () => stores.stockItems.filter((item) => item.active && !item.ignored).slice().sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName)),
    [stores],
  );

  const rows = useMemo<MergedRow[]>(() => {
    const salesRows: MergedRow[] = planning.salesOrders.map((order) => {
      const status = salesStatus(order);
      return {
        kind: "SALES",
        key: order.id,
        displayType: order.orderKind === "SERVICE" ? "Service Voucher" : "Sales Order",
        dueDate: order.dueDate,
        customer: order.customerName || "Customer not set",
        reference: order.poReference || order.voucherNumber || "PO not set",
        statusLabel: status.label,
        statusTone: status.tone,
        lines: order.fulfilmentLines.length || order.sourceLines.length,
        owner: "",
        inactive: status.inactive,
        salesOrder: order,
      };
    });
    const serviceRows: MergedRow[] = buildServiceOrderGroups(planning).map((group) => {
      const health = serviceOrderAttention(group);
      return {
        kind: "SERVICE",
        key: group.key,
        displayType: "Service Order",
        dueDate: group.dueDate,
        customer: group.organisation,
        reference: group.reference,
        statusLabel: health.label,
        statusTone: health.tone === "danger" ? "rejected" : health.tone === "warning" ? "needs-correction" : health.tone === "success" ? "approved" : "pending",
        lines: group.lines.length,
        owner: group.owner,
        inactive: group.lines.length > 0 && group.lines.every((line) => line.status === "CANCELLED" || line.status === "COMPLETED"),
        serviceGroup: group,
      };
    });
    return [...salesRows, ...serviceRows].sort((left, right) =>
      Number(left.inactive) - Number(right.inactive)
      || (left.dueDate || "9999").localeCompare(right.dueDate || "9999"),
    );
  }, [planning]);

  const filtered = rows.filter((row) => {
    const query = search.trim().toLocaleLowerCase();
    const haystack = `${row.customer} ${row.reference} ${row.owner}`.toLocaleLowerCase();
    return (!row.inactive || query)
      && (!query || haystack.includes(query))
      && (!typeFilter || row.kind === typeFilter);
  });

  if (selectedRow?.kind === "SALES" && selectedRow.salesOrder) {
    const liveOrder = planning.salesOrders.find((order) => order.id === selectedRow.salesOrder!.id) ?? selectedRow.salesOrder;
    return <CrfBuilder
      order={liveOrder}
      stores={stores}
      planning={planning}
      permissions={permissions}
      onBack={() => setSelectedRow(null)}
      onRefresh={onRefresh}
      onNotice={onNotice}
      onError={onError}
    />;
  }

  if (selectedRow?.kind === "SERVICE" && selectedRow.serviceGroup) {
    const liveGroup = buildServiceOrderGroups(planning).find((group) => group.key === selectedRow.serviceGroup!.key) ?? selectedRow.serviceGroup;
    return <ServiceOrderDetail
      group={liveGroup}
      planning={planning}
      stores={stores}
      canManage={canManageServiceOrders}
      onBack={() => setSelectedRow(null)}
      onRefresh={onRefresh}
      onNotice={onNotice}
      onError={onError}
    />;
  }

  async function saveNewServiceOrder() {
    if (!creatingServiceOrder?.productTallyGuid) {
      onError("Choose a product for this order line.");
      return;
    }
    setBusy(true);
    onError("");
    try {
      await window.desktop.planning.saveProductOrder(creatingServiceOrder);
      await onRefresh();
      onNotice("Service order added.");
      setCreatingServiceOrder(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveNewSalesOrder() {
    if (!creatingSalesOrder?.sourceLines.some((line) => line.itemTallyGuid)) {
      onError("Add at least one item line.");
      return;
    }
    setBusy(true);
    onError("");
    try {
      await window.desktop.planning.saveSalesOrder({
        ...creatingSalesOrder,
        sourceLines: creatingSalesOrder.sourceLines.filter((line) => line.itemTallyGuid),
      });
      await onRefresh();
      onNotice("Order created.");
      setCreatingSalesOrder(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveWorkflowStage() {
    if (!workflowDraft) return;
    setBusy(true);
    onError("");
    try {
      await window.desktop.planning.saveSalesOrderWorkflowStage({
        ...workflowDraft,
        requiredPermissions: (workflowDraft.requiredPermissions ?? []).map((entry) => entry.trim()).filter(Boolean),
      });
      await onRefresh();
      onNotice("Workflow stage saved.");
      setWorkflowDraft(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveItemWorkflowStage() {
    if (!itemWorkflowDraft) return;
    setBusy(true);
    onError("");
    try {
      await window.desktop.planning.saveProductOrderWorkflowState({
        ...itemWorkflowDraft,
        requiredPermissions: (itemWorkflowDraft.requiredPermissions ?? []).map((entry) => entry.trim()).filter(Boolean),
      });
      await onRefresh();
      onNotice("Item stage saved.");
      setItemWorkflowDraft(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function deleteWorkflowStage(stage: PlanningState["salesOrderWorkflowStages"][number]) {
    if (!window.confirm(`Delete ${stage.name}? This only works when the stage has not been used by any orders or approvals.`)) return;
    setBusy(true);
    onError("");
    try {
      await window.desktop.planning.deleteSalesOrderWorkflowStage({
        id: stage.id,
        orderKind: stage.orderKind,
        stockGroupName: stage.stockGroupName,
      });
      await onRefresh();
      onNotice(`${stage.name} deleted.`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function deleteItemWorkflowStage(stage: PlanningState["productOrderWorkflowStates"][number]) {
    if (!window.confirm(`Delete ${stage.name}? This only works when the stage has not been used by any orders or approvals.`)) return;
    setBusy(true);
    onError("");
    try {
      await window.desktop.planning.deleteProductOrderWorkflowState(stage.id);
      await onRefresh();
      onNotice(`${stage.name} deleted.`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function exportVoucher(order: SalesOrder) {
    setBusy(true);
    onError("");
    try {
      const result = await window.desktop.planning.exportSalesOrderVouchers({ salesOrderIds: [order.id] });
      onNotice(`Tally voucher files created: ${result.xmlPath}`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return <article className="panel">
    <div className="panel__header">
      <div><p className="eyebrow">CUSTOMER ORDERS</p><h2>Sales &amp; Service Orders</h2></div>
      <div className="inline-actions">
        {canEditSalesOrders && <button className="button button--secondary" type="button" onClick={() => setCreatingSalesOrder(newSalesOrderDraft())}>+ Sales Order</button>}
        {canManageServiceOrders && <button className="button button--secondary" type="button" onClick={() => setCreatingServiceOrder(newServiceOrderDraft(planning))}>+ Service Order</button>}
        <button className="button button--secondary" type="button" onClick={() => void onRefresh()}>Refresh</button>
      </div>
    </div>
    <p className="table-footnote">Create and track orders here first, then export reviewed Sales Order Master or Service Order Master vouchers for Tally import.</p>
    <div className="form-grid form-grid--three">
      <label>Search<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Customer, PO, voucher, or owner…" /></label>
      <label>Type<select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as "" | "SALES" | "SERVICE")}>
        <option value="">All orders</option>
        <option value="SALES">Sales Orders</option>
        <option value="SERVICE">Service Orders</option>
      </select></label>
    </div>
    <div className="table-scroll">
      <table>
        <thead><tr><th>Due</th><th>Type</th><th>Customer / Order</th><th>Status</th><th className="numeric">Lines</th><th>Owner</th><th></th></tr></thead>
        <tbody>
          {filtered.map((row) => <tr key={`${row.kind}:${row.key}`} style={{ cursor: "pointer" }} onClick={() => setSelectedRow(row)}>
            <td className={row.dueDate && row.dueDate < today() ? "danger-text" : ""}>{displayDate(row.dueDate)}</td>
            <td>{row.displayType}</td>
            <td><strong>{row.customer}</strong><small className="table-subtext">{row.reference}</small></td>
            <td><span className={`review-status review-status--${row.statusTone}`}>{row.statusLabel}</span>{row.kind === "SALES" && row.salesOrder?.sourceChanged && <span className="review-status review-status--needs-correction">Amendment pending</span>}</td>
            <td className="numeric">{row.lines}</td>
            <td>{row.owner || "—"}</td>
            <td className="table-actions">{row.salesOrder && canExportVouchers && <button className="button button--ghost button--small" type="button" disabled={busy} onClick={(event) => { event.stopPropagation(); void exportVoucher(row.salesOrder!); }}>Export</button>}</td>
          </tr>)}
          {filtered.length === 0 && <tr><td colSpan={7} className="empty-table">No orders match these filters.</td></tr>}
        </tbody>
      </table>
    </div>
    {canConfigureWorkflow && <section className="stacked-section">
      <div className="section-heading">
        <div><p className="eyebrow">WORKFLOW</p><h3>Order stages by type</h3></div>
        <button className="button button--secondary" type="button" onClick={() => setWorkflowDraft({ orderKind: "SALES", stockGroupName: "", name: "", color: "#6B778C", requiredPermissions: [] })}>+ Stage</button>
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Kind</th><th>Stage</th><th>Approvals needed</th><th /></tr></thead>
          <tbody>{planning.salesOrderWorkflowStages.map((stage) => <tr key={`${stage.orderKind}:${stage.stockGroupName}:${stage.id}`}>
            <td>{stage.orderKind}</td><td>{stage.position}. {stage.name}</td><td>{stage.requiredPermissions.join(", ") || "None"}</td><td className="table-actions"><button className="button button--ghost button--small" type="button" onClick={() => setWorkflowDraft(stage)}>Edit</button><button className="button button--ghost button--small" type="button" disabled={busy} onClick={() => void deleteWorkflowStage(stage)}>Delete</button></td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>}
    {canConfigureItemWorkflow && <section className="stacked-section">
      <div className="section-heading">
        <div><p className="eyebrow">ITEM STAGES</p><h3>Production stages by Stock Group</h3></div>
        <button className="button button--secondary" type="button" onClick={() => setItemWorkflowDraft({ orderType: "PRODUCTION", stockGroupName: "", name: "", color: "#6B778C", requiredPermissions: [] })}>+ Item Stage</button>
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Type</th><th>Stock Group</th><th>Stage</th><th>Approvals needed</th><th /></tr></thead>
          <tbody>{planning.productOrderWorkflowStates.map((stage) => <tr key={`${stage.orderType}:${stage.stockGroupName}:${stage.id}`}>
            <td>{stage.orderType}</td><td>{stage.stockGroupName || "Default"}</td><td>{stage.position}. {stage.name}</td><td>{stage.requiredPermissions.join(", ") || "None"}</td><td className="table-actions"><button className="button button--ghost button--small" type="button" onClick={() => setItemWorkflowDraft(stage)}>Edit</button><button className="button button--ghost button--small" type="button" disabled={busy} onClick={() => void deleteItemWorkflowStage(stage)}>Delete</button></td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>}
    {creatingSalesOrder && <div className="production-modal-backdrop">
      <div className="production-modal">
        <header><h2>New Order</h2><button className="icon-button" type="button" onClick={() => setCreatingSalesOrder(null)}>×</button></header>
        <div className="production-modal-body">
          <div className="form-grid form-grid--three">
            <label>Voucher<select value={creatingSalesOrder.orderKind} onChange={(event) => setCreatingSalesOrder({ ...creatingSalesOrder, orderKind: event.target.value as "SALES" | "SERVICE" })}><option value="SALES">Sales Order Master</option><option value="SERVICE">Service Order Master</option></select></label>
            <label>Customer<input value={creatingSalesOrder.customerName} onChange={(event) => setCreatingSalesOrder({ ...creatingSalesOrder, customerName: event.target.value })} /></label>
            <label>PO / Reference<input value={creatingSalesOrder.poReference} onChange={(event) => setCreatingSalesOrder({ ...creatingSalesOrder, poReference: event.target.value })} /></label>
            <label>Voucher date<input type="date" value={creatingSalesOrder.voucherDate ?? ""} onChange={(event) => setCreatingSalesOrder({ ...creatingSalesOrder, voucherDate: event.target.value })} /></label>
            <label>Due date<input type="date" value={creatingSalesOrder.dueDate ?? ""} onChange={(event) => setCreatingSalesOrder({ ...creatingSalesOrder, dueDate: event.target.value })} /></label>
            <label>Value<input type="number" min="0" value={creatingSalesOrder.poValue ?? ""} onChange={(event) => setCreatingSalesOrder({ ...creatingSalesOrder, poValue: event.target.value ? Number(event.target.value) : null })} /></label>
          </div>
          <div className="bom-line-editor">
            <div className="bom-line-editor__head"><span>Item</span><span>Qty</span><span>Value</span><span></span></div>
            {creatingSalesOrder.sourceLines.map((line, index) => <div className="bom-line-editor__row" key={index}>
              <select value={line.itemTallyGuid} onChange={(event) => {
                const sourceLines = [...creatingSalesOrder.sourceLines];
                sourceLines[index] = { ...line, itemTallyGuid: event.target.value };
                setCreatingSalesOrder({ ...creatingSalesOrder, sourceLines });
              }}><option value="">Choose item…</option>{orderLineItems.map((item) => <option key={item.tallyGuid} value={item.tallyGuid}>{item.qualifiedName}</option>)}</select>
              <input type="number" min="1" value={line.quantity} onChange={(event) => {
                const sourceLines = [...creatingSalesOrder.sourceLines];
                sourceLines[index] = { ...line, quantity: Number(event.target.value) || 1 };
                setCreatingSalesOrder({ ...creatingSalesOrder, sourceLines });
              }} />
              <input type="number" min="0" value={line.value ?? ""} onChange={(event) => {
                const sourceLines = [...creatingSalesOrder.sourceLines];
                sourceLines[index] = { ...line, value: event.target.value ? Number(event.target.value) : null };
                setCreatingSalesOrder({ ...creatingSalesOrder, sourceLines });
              }} />
              <button className="button button--ghost button--small" type="button" onClick={() => setCreatingSalesOrder({ ...creatingSalesOrder, sourceLines: creatingSalesOrder.sourceLines.filter((_, lineIndex) => lineIndex !== index) })}>Remove</button>
            </div>)}
          </div>
          <button className="button button--secondary" type="button" onClick={() => setCreatingSalesOrder({ ...creatingSalesOrder, sourceLines: [...creatingSalesOrder.sourceLines, { itemTallyGuid: "", quantity: 1, value: null }] })}>+ Line</button>
        </div>
        <footer><button className="button button--ghost" type="button" onClick={() => setCreatingSalesOrder(null)}>Cancel</button><button className="button" type="button" disabled={busy} onClick={() => void saveNewSalesOrder()}>Save order</button></footer>
      </div>
    </div>}
    {workflowDraft && <div className="production-modal-backdrop">
      <div className="production-modal production-settings-modal">
        <header><h2>Workflow stage</h2><button className="icon-button" type="button" onClick={() => setWorkflowDraft(null)}>×</button></header>
        <div className="production-modal-body">
          <div className="form-grid form-grid--three">
            <label>Kind<select value={workflowDraft.orderKind} onChange={(event) => setWorkflowDraft({ ...workflowDraft, orderKind: event.target.value as "SALES" | "SERVICE" })}><option value="SALES">Sales</option><option value="SERVICE">Service</option></select></label>
            <label>Stage name<input value={workflowDraft.name} onChange={(event) => setWorkflowDraft({ ...workflowDraft, name: event.target.value })} /></label>
            <label>Position<input type="number" min="1" value={workflowDraft.position ?? ""} onChange={(event) => setWorkflowDraft({ ...workflowDraft, position: event.target.value ? Number(event.target.value) : undefined })} /></label>
            <label>Color<input type="color" value={workflowDraft.color ?? "#6B778C"} onChange={(event) => setWorkflowDraft({ ...workflowDraft, color: event.target.value })} /></label>
            <label>Terminal<select value={workflowDraft.terminal ? "yes" : "no"} onChange={(event) => setWorkflowDraft({ ...workflowDraft, terminal: event.target.value === "yes" })}><option value="no">No</option><option value="yes">Yes</option></select></label>
          </div>
          <label>Approval permissions<input value={(workflowDraft.requiredPermissions ?? []).join(", ")} onChange={(event) => setWorkflowDraft({ ...workflowDraft, requiredPermissions: event.target.value.split(",") })} placeholder="SALES_ORDER_APPROVE_PO, SALES_ORDER_APPROVE_CRF_SALES" /></label>
        </div>
        <footer><button className="button button--ghost" type="button" onClick={() => setWorkflowDraft(null)}>Cancel</button><button className="button" type="button" disabled={busy} onClick={() => void saveWorkflowStage()}>Save stage</button></footer>
      </div>
    </div>}
    {itemWorkflowDraft && <div className="production-modal-backdrop">
      <div className="production-modal production-settings-modal">
        <header><h2>Item stage</h2><button className="icon-button" type="button" onClick={() => setItemWorkflowDraft(null)}>×</button></header>
        <div className="production-modal-body">
          <div className="form-grid form-grid--three">
            <label>Type<select value={itemWorkflowDraft.orderType} onChange={(event) => setItemWorkflowDraft({ ...itemWorkflowDraft, orderType: event.target.value as "PRODUCTION" | "SERVICE" })}><option value="PRODUCTION">Production</option><option value="SERVICE">Service</option></select></label>
            <label>Stock Group<select value={itemWorkflowDraft.stockGroupName ?? ""} onChange={(event) => setItemWorkflowDraft({ ...itemWorkflowDraft, stockGroupName: event.target.value })}><option value="">Default workflow</option>{stores.catalogGroups.map((group) => <option key={group.name} value={group.name}>{group.path.join(" › ")}</option>)}</select></label>
            <label>Stage name<input value={itemWorkflowDraft.name} onChange={(event) => setItemWorkflowDraft({ ...itemWorkflowDraft, name: event.target.value })} /></label>
            <label>Position<input type="number" min="1" value={itemWorkflowDraft.position ?? ""} onChange={(event) => setItemWorkflowDraft({ ...itemWorkflowDraft, position: event.target.value ? Number(event.target.value) : undefined })} /></label>
            <label>Color<input type="color" value={itemWorkflowDraft.color ?? "#6B778C"} onChange={(event) => setItemWorkflowDraft({ ...itemWorkflowDraft, color: event.target.value })} /></label>
            <label>Terminal<select value={itemWorkflowDraft.terminal ? "yes" : "no"} onChange={(event) => setItemWorkflowDraft({ ...itemWorkflowDraft, terminal: event.target.value === "yes" })}><option value="no">No</option><option value="yes">Yes</option></select></label>
          </div>
          <label>Approval permissions<input value={(itemWorkflowDraft.requiredPermissions ?? []).join(", ")} onChange={(event) => setItemWorkflowDraft({ ...itemWorkflowDraft, requiredPermissions: event.target.value.split(",") })} placeholder="PRODUCTION_EXECUTE, PRODUCT_ORDER_MANAGE" /></label>
        </div>
        <footer><button className="button button--ghost" type="button" onClick={() => setItemWorkflowDraft(null)}>Cancel</button><button className="button" type="button" disabled={busy} onClick={() => void saveItemWorkflowStage()}>Save stage</button></footer>
      </div>
    </div>}
    {creatingServiceOrder && <ServiceOrderLineDrawer
      draft={creatingServiceOrder}
      setDraft={setCreatingServiceOrder}
      planning={planning}
      products={products}
      busy={busy}
      canManage={canManageServiceOrders}
      onSave={() => void saveNewServiceOrder()}
    />}
  </article>;
}
