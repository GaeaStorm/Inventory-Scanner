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

function stageLabel(value: string): string {
  return value.replace(/^Service · /, "").replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function AdministrationDashboard({ operations, planning, onRefresh }: Props) {
  const wastage = operations.wastage;
  const [selectedStage, setSelectedStage] = useState("");
  const [selectedJourneyKey, setSelectedJourneyKey] = useState("");
  const [hiddenStageKeys, setHiddenStageKeys] = useState<string[]>([]);
  const stageMetrics = useMemo(() => {
    const metricFor = (
      key: string,
      category: string,
      name: string,
      color: string,
      visits: Array<{
        journeyKey: string;
        title: string;
        subtitle: string;
        entry: { id: string; enteredAt: string; exitedAt: string | null; durationHours: number };
        stages: Array<{ id: string; name: string; enteredAt: string; exitedAt: string | null; durationHours: number }>;
      }>,
    ) => {
      const completed = visits.filter(({ entry }) => entry.exitedAt);
      const active = visits.filter(({ entry }) => !entry.exitedAt);
      return {
        key,
        category,
        name,
        color,
        completedAverage: completed.length ? completed.reduce((sum, value) => sum + value.entry.durationHours, 0) / completed.length : 0,
        currentAverage: active.length ? active.reduce((sum, value) => sum + value.entry.durationHours, 0) / active.length : 0,
        completedCount: completed.length,
        activeCount: active.length,
        visits,
      };
    };
    const productMetrics = planning.productOrderWorkflowStates.map((stage) => metricFor(
      `product:${stage.id}`,
      stage.orderType === "SERVICE" ? "Service item stages" : "Production item stages",
      stage.name,
      stage.color,
      planning.productOrders.flatMap((order) => order.stageHistory
        .filter((entry) => entry.stateId === stage.id)
        .map((entry) => ({
          journeyKey: `product:${order.id}`,
          title: order.organisation || "Customer not set",
          subtitle: `${order.externalReference || order.fileNumber || "Order not set"} · ${order.productName}${order.serialNumber ? ` · ${order.serialNumber}` : ""}`,
          entry,
          stages: order.stageHistory.map((history) => ({ id: history.id, name: history.stateName, enteredAt: history.enteredAt, exitedAt: history.exitedAt, durationHours: history.durationHours })),
        }))),
    ));
    const orderMetrics = planning.salesOrderWorkflowStages.map((stage) => metricFor(
      `sales-order:${stage.orderKind}:${stage.id}`,
      stage.orderKind === "SERVICE" ? "Service order cycle" : "Sales order cycle",
      stage.name,
      stage.color,
      planning.salesOrders.filter((order) => order.orderKind === stage.orderKind).flatMap((order) => order.stageHistory
        .filter((entry) => entry.stageId === stage.id)
        .map((entry) => ({
          journeyKey: `sales-order:${order.id}`,
          title: order.customerName || "Customer not set",
          subtitle: `${order.poReference || order.voucherNumber || "Order not set"} · ${order.orderKind === "SERVICE" ? "Service Order Master" : "Sales Order Master"}`,
          entry,
          stages: order.stageHistory.map((history) => ({ id: history.id, name: history.stageName, enteredAt: history.enteredAt, exitedAt: history.exitedAt, durationHours: history.durationHours })),
        }))),
    ));
    const fulfilmentStageIds = [...new Set(planning.salesOrders.flatMap((order) => order.fulfilmentLines.flatMap((line) => line.stageHistory.map((entry) => entry.stageId))))];
    const fulfilmentMetrics = fulfilmentStageIds.map((stageId) => metricFor(
      `fulfilment:${stageId}`,
      "Sales order item stages",
      planning.productOrderWorkflowStates.find((stage) => stage.id === stageId)?.name ?? stageLabel(stageId),
      planning.productOrderWorkflowStates.find((stage) => stage.id === stageId)?.color ?? "#6B778C",
      planning.salesOrders.flatMap((order) => order.fulfilmentLines.flatMap((line) => line.stageHistory
        .filter((entry) => entry.stageId === stageId)
        .map((entry) => ({
          journeyKey: `fulfilment:${line.id}`,
          title: order.customerName || "Customer not set",
          subtitle: `${order.poReference || order.voucherNumber || "Order not set"} · ${line.itemName}`,
          entry,
          stages: line.stageHistory.map((history) => ({ id: history.id, name: history.stageName, enteredAt: history.enteredAt, exitedAt: history.exitedAt, durationHours: history.durationHours })),
        })))),
    ));
    return [...orderMetrics, ...fulfilmentMetrics, ...productMetrics];
  }, [planning.productOrders, planning.productOrderWorkflowStates, planning.salesOrderWorkflowStages, planning.salesOrders]);
  const visibleStageMetrics = stageMetrics.filter((stage) => !hiddenStageKeys.includes(stage.key));
  const hiddenStageMetrics = stageMetrics.filter((stage) => hiddenStageKeys.includes(stage.key));
  const selected = stageMetrics.find((stage) => stage.key === selectedStage) ?? null;
  const selectedJourney = stageMetrics.flatMap((stage) => stage.visits).find((visit) => visit.journeyKey === selectedJourneyKey) ?? null;
  return <section className="tab-page administration-dashboard">
    <div className="page-heading">
      <div><p className="eyebrow">ACCOUNTS &amp; ADMINISTRATION</p><h1>Admin Dashboard</h1><p>Order-cycle timing and the financial impact of scrapped inventory.</p></div>
      <button className="button button--secondary" type="button" onClick={() => void onRefresh()}>Refresh</button>
    </div>
    <article className="panel administration-stages">
      <div className="panel__header"><div><p className="eyebrow">ORDER CYCLE</p><h2>Time spent in each stage</h2></div><span className="table-count">Click a stage for order details</span></div>
      {[...new Set(visibleStageMetrics.map((stage) => stage.category))].map((category) => <section className="administration-stage-section" key={category}>
        <h3>{category}</h3>
        <div className="administration-stage-list">
          {visibleStageMetrics.filter((stage) => stage.category === category).map((stage) => <button className={selectedStage === stage.key ? "active" : ""} type="button" key={stage.key} onClick={() => setSelectedStage((current) => current === stage.key ? "" : stage.key)}>
            <span style={{ background: stage.color }} />
            <strong>{stageLabel(stage.name)}</strong>
            <small>{stage.completedCount ? `Typical ${duration(stage.completedAverage)}` : "No completed history"}</small>
            <b>{stage.activeCount ? `${stage.activeCount} active · ${duration(stage.currentAverage)} so far` : "No active orders"}</b>
            <em onClick={(event) => { event.stopPropagation(); setHiddenStageKeys((current) => [...current, stage.key]); }}>Hide</em>
          </button>)}
        </div>
      </section>)}
      {hiddenStageMetrics.length > 0 && <div className="inline-actions">
        {hiddenStageMetrics.map((stage) => <button className="button button--ghost button--small" type="button" key={stage.key} onClick={() => setHiddenStageKeys((current) => current.filter((key) => key !== stage.key))}>Show {stageLabel(stage.name)}</button>)}
      </div>}
      {selected && <div className="administration-stage-detail">
        <h3>{selected.category} · {stageLabel(selected.name)}</h3>
        <div className="table-scroll"><table><thead><tr><th>Customer / Order</th><th>Product / Serial</th><th>Entered</th><th>Exited</th><th>Time in stage</th><th>Journey</th></tr></thead><tbody>
          {selected.visits.slice().sort((left, right) => right.entry.enteredAt.localeCompare(left.entry.enteredAt)).map((visit) => <tr key={visit.entry.id}><td><strong>{visit.title}</strong><small className="table-subtext">{visit.subtitle}</small></td><td>{stageLabel(selected.name)}</td><td>{new Date(visit.entry.enteredAt).toLocaleString("en-IN")}</td><td>{visit.entry.exitedAt ? new Date(visit.entry.exitedAt).toLocaleString("en-IN") : "Current"}</td><td>{duration(visit.entry.durationHours)}</td><td><button className="text-button" type="button" onClick={() => setSelectedJourneyKey(visit.journeyKey)}>View all stages</button></td></tr>)}
          {selected.visits.length === 0 && <tr><td colSpan={6} className="empty-table">No orders have entered this stage yet.</td></tr>}
        </tbody></table></div>
      </div>}
      {selectedJourney && <div className="administration-order-journey">
        <div><p className="eyebrow">STAGE JOURNEY</p><h3>{selectedJourney.title}</h3><p>{selectedJourney.subtitle}</p></div>
        <button className="icon-button" type="button" aria-label="Close order journey" onClick={() => setSelectedJourneyKey("")}>×</button>
        <div className="administration-order-journey__stages">{selectedJourney.stages.map((entry) => <div key={entry.id}><span>{stageLabel(entry.name)}</span><strong>{duration(entry.durationHours)}</strong><small>{entry.exitedAt ? `${new Date(entry.enteredAt).toLocaleDateString("en-IN")} – ${new Date(entry.exitedAt).toLocaleDateString("en-IN")}` : `Since ${new Date(entry.enteredAt).toLocaleString("en-IN")}`}</small></div>)}</div>
      </div>}
    </article>
    <div className="administration-summary">
      <article><span>Units scrapped</span><strong>{wastage.totalQuantity}</strong><small>Across all materials and products</small></article>
      <article><span>Products affected</span><strong>{wastage.byProduct.filter((row) => row.name !== "Unassigned / general").length}</strong><small>Production-linked wastage</small></article>
      <article className={wastage.unvaluedQuantity ? "administration-summary--warning" : ""}><span>Awaiting valuation</span><strong>{wastage.unvaluedQuantity}</strong><small>Units without a purchase rate</small></article>
      <article><span>Total wastage value</span><strong>{money(wastage.totalValue)}</strong><small>FIFO purchase value of recorded scrap</small></article>
    </div>
    {wastage.unvaluedQuantity > 0 && <div className="alert alert--warning">Some scrapped stock has no purchase rate in its source lot. The displayed rupee total excludes those units.</div>}
    <div className="administration-dashboard__grid">
      <BreakdownTable title="By destination product" rows={wastage.byProduct} />
      <BreakdownTable title="By material" rows={wastage.byMaterial} />
    </div>
  </section>;
}
