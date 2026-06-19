import { useMemo, useState, type ChangeEvent } from "react";

import InfoTip from "./InfoTip";

import type {
  PlanningState,
  RecommendationDecisionInput,
  RestockPlanningItem,
  RestockPolicyInput,
  StoresState,
} from "./types";

interface Props {
  planning: PlanningState;
  stores: StoresState;
  onChanged: (state: PlanningState) => void;
  onNavigate: (section: "boms" | "orders") => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

const healthLabels: Record<RestockPlanningItem["health"], string> = {
  CRITICAL: "Critical",
  REORDER_NOW: "Reorder now",
  REORDER_SOON: "Reorder soon",
  HEALTHY: "Healthy",
  EXCESS: "Excess",
  UNCONFIGURED: "Unconfigured",
};

function numberInput(value: number, setter: (value: number) => void, min = 0) {
  return {
    type: "number" as const,
    min,
    step: 1,
    value,
    onChange: (event: ChangeEvent<HTMLInputElement>) => setter(Number(event.target.value)),
  };
}

export default function RestockActionCenter({
  planning,
  stores,
  onChanged,
  onNavigate,
  onNotice,
  onError,
}: Props) {
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("");
  const [health, setHealth] = useState("");
  const [supplier, setSupplier] = useState("");
  const [selectedGuid, setSelectedGuid] = useState(planning.items[0]?.tallyItemGuid ?? "");
  const [busy, setBusy] = useState(false);
  const [includeCsv, setIncludeCsv] = useState(true);

  const selected = planning.items.find((item) => item.tallyItemGuid === selectedGuid) ?? null;
  const [draft, setDraft] = useState<RestockPolicyInput | null>(selected ? toDraft(selected) : null);
  const [approvedQty, setApprovedQty] = useState(selected?.approvedOrderQuantity ?? selected?.suggestedOrderQuantity ?? 0);

  function choose(item: RestockPlanningItem) {
    setSelectedGuid(item.tallyItemGuid);
    setDraft(toDraft(item));
    setApprovedQty(item.approvedOrderQuantity ?? item.suggestedOrderQuantity);
  }

  const suppliers = useMemo(
    () => [...stores.suppliers].filter((entry) => entry.name !== "Opening Legacy Stock").sort((a, b) => a.name.localeCompare(b.name)),
    [stores.suppliers],
  );
  const supplierNames = useMemo(
    () => [...new Set(planning.items.map((item) => item.preferredSupplierName).filter(Boolean))].sort(),
    [planning.items],
  );
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return planning.items.filter((item) => {
      if (needle && !`${item.itemName} ${item.groupName} ${item.preferredSupplierName}`.toLocaleLowerCase().includes(needle)) return false;
      if (group && item.groupName !== group) return false;
      if (health && item.health !== health) return false;
      if (supplier && item.preferredSupplierName !== supplier) return false;
      return true;
    });
  }, [planning.items, search, group, health, supplier]);

  async function perform(action: () => Promise<PlanningState>, message: string) {
    setBusy(true);
    onError("");
    try {
      const state = await action();
      onChanged(state);
      const next = state.items.find((item) => item.tallyItemGuid === selectedGuid);
      if (next) {
        setDraft(toDraft(next));
        setApprovedQty(next.approvedOrderQuantity ?? next.suggestedOrderQuantity);
      }
      onNotice(message);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function savePolicy() {
    if (!draft) return;
    await perform(() => window.desktop.planning.saveRestockPolicy(draft), "Restock policy saved locally.");
  }

  async function decide(status: RecommendationDecisionInput["status"]) {
    if (!selected) return;
    await perform(
      () => window.desktop.planning.recommendationDecision({
        tallyItemGuid: selected.tallyItemGuid,
        status,
        approvedOrderQuantity: status === "APPROVED" ? Math.max(0, Math.round(approvedQty)) : null,
      }),
      status === "APPROVED" ? "Restock recommendation approved." : "Recommendation status updated.",
    );
  }

  async function exportRecommendations() {
    setBusy(true);
    onError("");
    try {
      const result = await window.desktop.planning.exportRestock({ includeCsv });
      onNotice(`Exported ${result.itemCount} approved restock recommendation${result.itemCount === 1 ? "" : "s"}.`);
      const next = await window.desktop.planning.getState();
      onChanged(next);
      await window.desktop.stores.openPath(result.excelPath);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const dataAttention = planning.summary.unconfigured + planning.summary.missingBom;
  return (
    <div className="planning-section-stack">
      <div className={`freshness-banner ${planning.freshness.tallyStale ? "freshness-banner--warning" : ""}`}>
        <strong>{planning.freshness.tallyStale ? "Cached Tally data" : "Planning data current"}</strong>
        <span>{planning.freshness.message}</span>
      </div>

      <section className="action-card-grid">
        <button className="action-card action-card--critical" type="button" onClick={() => setHealth("CRITICAL")}><span>Critical shortages</span><strong>{planning.summary.critical}</strong></button>
        <button className="action-card action-card--warning" type="button" onClick={() => setHealth("REORDER_NOW")}><span>Reorder now</span><strong>{planning.summary.reorderNow}</strong></button>
        <button className="action-card" type="button" onClick={() => onNavigate("orders")}><span>Orders at risk</span><strong>{planning.summary.ordersAtRisk}</strong></button>
        <button className="action-card" type="button" onClick={() => planning.summary.unconfigured > 0 ? setHealth("UNCONFIGURED") : onNavigate("boms")}><span>Data needs attention</span><strong>{dataAttention}</strong></button>
      </section>

      <article className="panel planning-table-panel">
        <div className="panel__header planning-header-wrap">
          <div className="heading-with-info"><div><p className="eyebrow">RESTOCK</p><h2>Action Center</h2></div><InfoTip>Projected stock equals available local stock plus open Purchase Order quantities. Reservations and service reserve reduce availability.</InfoTip></div>
          <div className="inline-actions">
            <label className="checkbox-row"><input type="checkbox" checked={includeCsv} onChange={(event) => setIncludeCsv(event.target.checked)} />Include CSV</label>
            <button className="button" disabled={busy} type="button" onClick={() => void exportRecommendations()}>Export approved</button>
          </div>
        </div>
        <div className="planning-filters">
          <input aria-label="Search stock planning" placeholder="Search item, group, or supplier…" value={search} onChange={(event) => setSearch(event.target.value)} />
          <select aria-label="Filter by group" value={group} onChange={(event) => setGroup(event.target.value)}><option value="">All groups</option>{planning.groups.map((entry) => <option key={entry}>{entry}</option>)}</select>
          <select aria-label="Filter by status" value={health} onChange={(event) => setHealth(event.target.value)}><option value="">All statuses</option>{Object.entries(healthLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label="Filter by supplier" value={supplier} onChange={(event) => setSupplier(event.target.value)}><option value="">All suppliers</option>{supplierNames.map((entry) => <option key={entry}>{entry}</option>)}</select>
          <button className="button button--secondary" type="button" onClick={() => { setSearch(""); setGroup(""); setHealth(""); setSupplier(""); }}>Clear filters</button>
        </div>
        <div className="table-scroll planning-restock-table"><table>
          <thead><tr><th>Status</th><th>Stock Item</th><th className="numeric">On hand</th><th className="numeric">Reserved</th><th className="numeric">Service</th><th className="numeric">Available</th><th className="numeric">Incoming</th><th className="numeric">Projected</th><th className="numeric">Reorder</th><th className="numeric">Target</th><th className="numeric">Suggested order</th><th>Supplier</th></tr></thead>
          <tbody>
            {filtered.map((item) => <tr key={item.tallyItemGuid} className={selectedGuid === item.tallyItemGuid ? "selected-row" : ""} onClick={() => choose(item)}>
              <td><span className={`planning-health planning-health--${item.health.toLocaleLowerCase().replaceAll("_", "-")}`}>{healthLabels[item.health]}</span></td>
              <td><strong>{item.itemName}</strong><small className="table-subtext">{item.groupName || "No group"}{item.catalogSource === "LOCAL" ? " · Local-only" : ""}</small></td>
              <td className="numeric">{item.onHand}</td><td className="numeric">{item.reserved}</td><td className="numeric">{item.serviceReserve}</td><td className="numeric">{item.available}</td><td className="numeric">{item.incoming}</td><td className="numeric">{item.projected}</td><td className="numeric">{item.reorderPoint}</td><td className="numeric">{item.targetStock}</td><td className="numeric"><strong>{item.suggestedOrderQuantity}</strong></td><td>{item.preferredSupplierName || "—"}</td>
            </tr>)}
            {filtered.length === 0 && <tr><td colSpan={12} className="empty-table">No Stock Items match these filters.</td></tr>}
          </tbody>
        </table></div>
      </article>

      {selected && draft && (
        <article className="panel policy-editor">
          <div className="panel__header"><div className="heading-with-info"><div><p className="eyebrow">RESTOCK POLICY</p><h2>{selected.itemName}</h2></div><InfoTip>Approved values remain unchanged until edited. Usage-based values are recommendations only.</InfoTip></div><span className={`planning-health planning-health--${selected.health.toLocaleLowerCase().replaceAll("_", "-")}`}>{healthLabels[selected.health]}</span></div>
          <div className="policy-layout">
            <div className="form-grid form-grid--four">
              <label>Planning method<select value={draft.planningMethod} onChange={(event) => setDraft({ ...draft, planningMethod: event.target.value as RestockPolicyInput["planningMethod"] })}><option value="MANUAL">Manual</option><option value="USAGE_SUGGESTED">Usage suggested</option></select></label>
              <label>Reorder point<input {...numberInput(draft.reorderPoint, (value) => setDraft({ ...draft, reorderPoint: value }))} /></label>
              <label>Target stock<input {...numberInput(draft.targetStock, (value) => setDraft({ ...draft, targetStock: value }))} /></label>
              <label>Service reserve<input {...numberInput(draft.serviceReserve, (value) => setDraft({ ...draft, serviceReserve: value }))} /></label>
              <label>Preferred supplier<select value={draft.preferredSupplierId ?? ""} onChange={(event) => setDraft({ ...draft, preferredSupplierId: event.target.value ? Number(event.target.value) : null })}><option value="">Not set</option>{suppliers.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
              <label>Lead time days<input {...numberInput(draft.leadTimeDays, (value) => setDraft({ ...draft, leadTimeDays: value }))} /></label>
              <label>Safety days<input {...numberInput(draft.safetyDays, (value) => setDraft({ ...draft, safetyDays: value }))} /></label>
              <label>Minimum order qty<input {...numberInput(draft.minimumOrderQuantity, (value) => setDraft({ ...draft, minimumOrderQuantity: value }))} /></label>
              <label>Usage lookback days<input {...numberInput(draft.usageLookbackDays, (value) => setDraft({ ...draft, usageLookbackDays: value }), 7)} /></label>
              <label className="form-grid__wide">Notes<textarea rows={2} value={draft.notes ?? ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
            </div>
            <aside className="recommendation-card">
              <span>Usage recommendation</span>
              <strong>{selected.suggestedReorderPoint}</strong>
              <InfoTip>{selected.averageDailyUsage.toFixed(2)} average units per day × {selected.effectiveLeadTimeDays + selected.safetyDays} days + {selected.serviceReserve} service reserve.</InfoTip>
              <dl><div><dt>Configured lead time</dt><dd>{selected.leadTimeDays} days</dd></div><div><dt>Observed median</dt><dd>{selected.observedLeadTimeMedianDays == null ? "Not enough data" : `${selected.observedLeadTimeMedianDays} days`}</dd></div></dl>
              <button className="button button--secondary button--small" type="button" onClick={() => setDraft({ ...draft, reorderPoint: selected.suggestedReorderPoint, targetStock: Math.max(draft.targetStock, selected.suggestedReorderPoint) })}>Use suggested reorder point</button>
            </aside>
          </div>
          <div className="policy-footer">
            <button className="button" disabled={busy} type="button" onClick={() => void savePolicy()}>Save policy</button>
            <div className="recommendation-actions"><label>Approved order qty<input {...numberInput(approvedQty, setApprovedQty)} /></label><button className="button button--secondary" disabled={busy} type="button" onClick={() => void decide("REVIEWED")}>Mark reviewed</button><button className="button" disabled={busy} type="button" onClick={() => void decide("APPROVED")}>Approve order</button><button className="button button--ghost" disabled={busy} type="button" onClick={() => void decide("SUGGESTED")}>Reset</button></div>
          </div>
        </article>
      )}
    </div>
  );
}

function toDraft(item: RestockPlanningItem): RestockPolicyInput {
  return {
    tallyItemGuid: item.tallyItemGuid,
    planningMethod: item.planningMethod,
    reorderPoint: item.reorderPoint,
    targetStock: item.targetStock,
    serviceReserve: item.serviceReserve,
    preferredSupplierId: item.preferredSupplierId,
    leadTimeDays: item.leadTimeDays,
    safetyDays: item.safetyDays,
    minimumOrderQuantity: item.minimumOrderQuantity,
    usageLookbackDays: item.usageLookbackDays,
    notes: item.notes,
  };
}
