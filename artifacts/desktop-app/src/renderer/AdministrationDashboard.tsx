import { useMemo, useState } from "react";

import type { OperationsState, PlanningState } from "./types";

interface Props {
  operations: OperationsState;
  planning: PlanningState;
  onRefresh: () => Promise<void>;
}

function money(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

function BreakdownTable({ title, rows }: {
  title: string;
  rows: OperationsState["wastage"]["byProduct"];
}) {
  const maximum = Math.max(1, ...rows.map((row) => row.value));
  return <article className="panel administration-breakdown">
    <div className="panel__header"><div><p className="eyebrow">WASTAGE BREAKDOWN</p><h2>{title}</h2></div><span className="table-count">{rows.length} shown</span></div>
    <div className="administration-breakdown__rows">
      {rows.map((row) => <div className="administration-breakdown__row" key={row.name}>
        <div><strong>{row.name}</strong><span>{row.quantity} unit{row.quantity === 1 ? "" : "s"} scrapped</span></div>
        <i><b style={{ width: `${Math.max(3, (row.value / maximum) * 100)}%` }} /></i>
        <strong>{money(row.value)}</strong>
      </div>)}
      {rows.length === 0 && <p className="empty-state">No wastage has been recorded.</p>}
    </div>
  </article>;
}

function duration(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)} hr`;
  return `${(hours / 24).toFixed(hours < 240 ? 1 : 0)} days`;
}

export default function AdministrationDashboard({ operations, planning, onRefresh }: Props) {
  const wastage = operations.wastage;
  const [selectedStage, setSelectedStage] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const stageMetrics = useMemo(() => planning.productOrderWorkflowStates.map((stage) => {
    const visits = planning.productOrders.flatMap((order) => order.stageHistory
      .filter((entry) => entry.stateId === stage.id)
      .map((entry) => ({ order, entry })));
    const completed = visits.filter(({ entry }) => entry.exitedAt);
    const active = visits.filter(({ entry }) => !entry.exitedAt);
    return {
      ...stage,
      completedAverage: completed.length
        ? completed.reduce((sum, value) => sum + value.entry.durationHours, 0) / completed.length
        : 0,
      currentAverage: active.length
        ? active.reduce((sum, value) => sum + value.entry.durationHours, 0) / active.length
        : 0,
      completedCount: completed.length,
      activeCount: active.length,
      visits,
    };
  }), [planning.productOrders, planning.productOrderWorkflowStates]);
  const selected = stageMetrics.find((stage) => stage.id === selectedStage) ?? null;
  const selectedOrder = planning.productOrders.find((order) => order.id === selectedOrderId) ?? null;
  return <section className="tab-page administration-dashboard">
    <div className="page-heading">
      <div><p className="eyebrow">ACCOUNTS &amp; ADMINISTRATION</p><h1>Admin Dashboard</h1><p>Order-cycle timing and the financial impact of scrapped inventory.</p></div>
      <button className="button button--secondary" type="button" onClick={() => void onRefresh()}>Refresh</button>
    </div>
    <div className="administration-summary">
      <article><span>Total wastage value</span><strong>{money(wastage.totalValue)}</strong><small>FIFO purchase value of recorded scrap</small></article>
      <article><span>Units scrapped</span><strong>{wastage.totalQuantity}</strong><small>Across all materials and products</small></article>
      <article><span>Products affected</span><strong>{wastage.byProduct.filter((row) => row.name !== "Unassigned / general").length}</strong><small>Production-linked wastage</small></article>
      <article className={wastage.unvaluedQuantity ? "administration-summary--warning" : ""}><span>Awaiting valuation</span><strong>{wastage.unvaluedQuantity}</strong><small>Units without a purchase rate</small></article>
    </div>
    {wastage.unvaluedQuantity > 0 && <div className="alert alert--warning">Some scrapped stock has no purchase rate in its source lot. The displayed rupee total excludes those units.</div>}
    <article className="panel administration-stages">
      <div className="panel__header"><div><p className="eyebrow">ORDER CYCLE</p><h2>Time spent in each stage</h2></div><span className="table-count">Click a stage for order details</span></div>
      <div className="administration-stage-list">
        {stageMetrics.map((stage) => <button className={selectedStage === stage.id ? "active" : ""} type="button" key={stage.id} onClick={() => setSelectedStage((current) => current === stage.id ? "" : stage.id)}>
          <span style={{ background: stage.color }} />
          <strong>{stage.name}</strong>
          <small>{stage.completedCount ? `Typical ${duration(stage.completedAverage)}` : "No completed history"}</small>
          <b>{stage.activeCount ? `${stage.activeCount} active · ${duration(stage.currentAverage)} so far` : "No active orders"}</b>
        </button>)}
      </div>
      {selected && <div className="administration-stage-detail">
        <h3>{selected.name} · order-level history</h3>
        <div className="table-scroll"><table><thead><tr><th>Customer / PO</th><th>Product</th><th>Entered</th><th>Exited</th><th>Time in stage</th><th>Journey</th></tr></thead><tbody>
          {selected.visits.slice().sort((left, right) => right.entry.enteredAt.localeCompare(left.entry.enteredAt)).map(({ order, entry }) => <tr key={entry.id}><td><strong>{order.organisation || "Customer not set"}</strong><small className="table-subtext">{order.externalReference || order.fileNumber || "PO not set"}</small></td><td>{order.productName}</td><td>{new Date(entry.enteredAt).toLocaleString("en-IN")}</td><td>{entry.exitedAt ? new Date(entry.exitedAt).toLocaleString("en-IN") : "Current"}</td><td>{duration(entry.durationHours)}</td><td><button className="text-button" type="button" onClick={() => setSelectedOrderId(order.id)}>View all stages</button></td></tr>)}
          {selected.visits.length === 0 && <tr><td colSpan={6} className="empty-table">No orders have entered this stage yet.</td></tr>}
        </tbody></table></div>
      </div>}
      {selectedOrder && <div className="administration-order-journey">
        <div><p className="eyebrow">ORDER JOURNEY</p><h3>{selectedOrder.organisation || "Customer not set"} · {selectedOrder.externalReference || selectedOrder.fileNumber || "PO not set"}</h3><p>{selectedOrder.productName}</p></div>
        <button className="icon-button" type="button" aria-label="Close order journey" onClick={() => setSelectedOrderId("")}>×</button>
        <div className="administration-order-journey__stages">{selectedOrder.stageHistory.map((entry) => <div key={entry.id}><span>{entry.stateName}</span><strong>{duration(entry.durationHours)}</strong><small>{entry.exitedAt ? `${new Date(entry.enteredAt).toLocaleDateString("en-IN")} – ${new Date(entry.exitedAt).toLocaleDateString("en-IN")}` : `Since ${new Date(entry.enteredAt).toLocaleString("en-IN")}`}</small></div>)}</div>
      </div>}
    </article>
    <div className="administration-dashboard__grid">
      <BreakdownTable title="By destination product" rows={wastage.byProduct} />
      <BreakdownTable title="By material" rows={wastage.byMaterial} />
    </div>
  </section>;
}
