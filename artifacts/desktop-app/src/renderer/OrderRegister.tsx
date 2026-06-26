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
import type { AuthUser, Permission, PlanningState, SalesOrder, SaveProductOrderInput, StoresState } from "./types";

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
  dueDate: string;
  customer: string;
  reference: string;
  statusLabel: string;
  statusTone: string;
  lines: number;
  owner: string;
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

function displayDate(value: string): string {
  if (!value) return "Not set";
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

const today = () => new Date().toISOString().slice(0, 10);

export default function OrderRegister({ stores, planning, permissions, onRefresh, onNotice, onError }: Props) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"" | "SALES" | "SERVICE">("");
  const [selectedRow, setSelectedRow] = useState<MergedRow | null>(null);
  const [creatingServiceOrder, setCreatingServiceOrder] = useState<SaveProductOrderInput | null>(null);
  const [busy, setBusy] = useState(false);

  const canManageServiceOrders = permissions.includes("PRODUCT_ORDER_MANAGE");
  const products = useMemo(() => serviceOrderProductOptions(stores), [stores]);

  const rows = useMemo<MergedRow[]>(() => {
    const salesRows: MergedRow[] = planning.salesOrders.map((order) => ({
      kind: "SALES",
      key: order.id,
      dueDate: order.dueDate,
      customer: order.customerName || "Customer not set",
      reference: order.poReference || order.voucherNumber || "PO not set",
      statusLabel: stageLabel(order.orderStage),
      statusTone: salesStageTone(order.orderStage),
      lines: order.fulfilmentLines.length || order.sourceLines.length,
      owner: "",
      salesOrder: order,
    }));
    const serviceRows: MergedRow[] = buildServiceOrderGroups(planning).map((group) => {
      const health = serviceOrderAttention(group);
      return {
        kind: "SERVICE",
        key: group.key,
        dueDate: group.dueDate,
        customer: group.organisation,
        reference: group.reference,
        statusLabel: health.label,
        statusTone: health.tone === "danger" ? "rejected" : health.tone === "warning" ? "needs-correction" : health.tone === "success" ? "approved" : "pending",
        lines: group.lines.length,
        owner: group.owner,
        serviceGroup: group,
      };
    });
    return [...salesRows, ...serviceRows].sort((left, right) => (left.dueDate || "9999").localeCompare(right.dueDate || "9999"));
  }, [planning]);

  const filtered = rows.filter((row) => {
    const haystack = `${row.customer} ${row.reference} ${row.owner}`.toLocaleLowerCase();
    return (!search || haystack.includes(search.trim().toLocaleLowerCase()))
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

  return <article className="panel">
    <div className="panel__header">
      <div><p className="eyebrow">CUSTOMER ORDERS</p><h2>Sales &amp; Service Orders</h2></div>
      <div className="inline-actions">
        {canManageServiceOrders && <button className="button button--secondary" type="button" onClick={() => setCreatingServiceOrder(newServiceOrderDraft(planning))}>+ Service Order</button>}
        <button className="button button--secondary" type="button" onClick={() => void onRefresh()}>Refresh</button>
      </div>
    </div>
    <p className="table-footnote">Sales Orders arrive automatically from Tally sync. Sorted together with Service Orders by promised dispatch date so neither gets forgotten.</p>
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
        <thead><tr><th>Due</th><th>Type</th><th>Customer / Order</th><th>Status</th><th className="numeric">Lines</th><th>Owner</th></tr></thead>
        <tbody>
          {filtered.map((row) => <tr key={`${row.kind}:${row.key}`} style={{ cursor: "pointer" }} onClick={() => setSelectedRow(row)}>
            <td className={row.dueDate && row.dueDate < today() ? "danger-text" : ""}>{displayDate(row.dueDate)}</td>
            <td>{row.kind === "SALES" ? "Sales Order" : "Service Order"}</td>
            <td><strong>{row.customer}</strong><small className="table-subtext">{row.reference}</small></td>
            <td><span className={`review-status review-status--${row.statusTone}`}>{row.statusLabel}</span>{row.kind === "SALES" && row.salesOrder?.sourceChanged && <span className="review-status review-status--needs-correction">Amendment pending</span>}</td>
            <td className="numeric">{row.lines}</td>
            <td>{row.owner || "—"}</td>
          </tr>)}
          {filtered.length === 0 && <tr><td colSpan={6} className="empty-table">No orders match these filters.</td></tr>}
        </tbody>
      </table>
    </div>
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
