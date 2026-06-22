import { useMemo, useState, type ChangeEvent } from "react";

import InfoTip from "./InfoTip";

import type {
  PlanningState,
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
  const finishedProducts = useMemo(
    () => stores.stockItems.filter((item) => !item.ignored && item.catalogRole === "FINISHED_PRODUCT" && item.catalogStatus !== "DUPLICATE"),
    [stores.stockItems],
  );
  const [productGuid, setProductGuid] = useState("");
  const [health, setHealth] = useState("");
  const [primaryGroup, setPrimaryGroup] = useState("");
  const [secondaryGroup, setSecondaryGroup] = useState("");
  const [selectedGuid, setSelectedGuid] = useState(planning.items[0]?.tallyItemGuid ?? "");
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState<{ key: keyof RestockPlanningItem; direction: "asc" | "desc" }>({ key: "health", direction: "asc" });

  const selected = planning.items.find((item) => item.tallyItemGuid === selectedGuid) ?? null;
  const selectedProduct = finishedProducts.find((item) => item.tallyGuid === productGuid) ?? null;
  const selectedBom = planning.boms.find((bom) => bom.productTallyGuid === productGuid && bom.status === "ACTIVE")
    ?? planning.boms.find((bom) => bom.productTallyGuid === productGuid)
    ?? null;
  const [draft, setDraft] = useState<RestockPolicyInput | null>(selected ? toDraft(selected) : null);

  function choose(item: RestockPlanningItem) {
    setSelectedGuid(item.tallyItemGuid);
    setDraft(toDraft(item));
  }

  const suppliers = useMemo(
    () => [...stores.suppliers].filter((entry) => entry.name !== "Opening Legacy Stock").sort((a, b) => a.name.localeCompare(b.name)),
    [stores.suppliers],
  );
  const primaryGroupNames = useMemo(
    () => [...new Set(planning.items.map((item) => item.primaryGroupName).filter(Boolean))].sort(),
    [planning.items],
  );
  const secondaryGroupNames = useMemo(
    () => [...new Set(planning.items
      .filter((item) => !primaryGroup || item.primaryGroupName === primaryGroup)
      .map((item) => item.secondaryGroupName)
      .filter(Boolean))].sort(),
    [planning.items, primaryGroup],
  );
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const requiredGuids = new Set(selectedBom?.lines.map((line) => line.componentTallyGuid) ?? []);
    const rows = planning.items.filter((item) => {
      if (productGuid && !requiredGuids.has(item.tallyItemGuid)) return false;
      if (needle && !`${item.itemName} ${item.primaryGroupName} ${item.secondaryGroupName} ${item.preferredSupplierName}`.toLocaleLowerCase().includes(needle)) return false;
      if (health && item.health !== health) return false;
      if (primaryGroup && item.primaryGroupName !== primaryGroup) return false;
      if (secondaryGroup && item.secondaryGroupName !== secondaryGroup) return false;
      return true;
    });
    return rows.sort((left, right) => {
      const a = left[sort.key];
      const b = right[sort.key];
      const comparison = typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
      return sort.direction === "asc" ? comparison : -comparison;
    });
  }, [planning.items, productGuid, selectedBom, search, health, primaryGroup, secondaryGroup, sort]);

  function toggleSort(key: keyof RestockPlanningItem) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: "asc" });
  }

  function sortLabel(label: string, key: keyof RestockPlanningItem) {
    return <button className="table-sort-button" type="button" onClick={() => toggleSort(key)}>{label}{sort.key === key ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}</button>;
  }

  async function perform(action: () => Promise<PlanningState>, message: string) {
    setBusy(true);
    onError("");
    try {
      const state = await action();
      onChanged(state);
      const next = state.items.find((item) => item.tallyItemGuid === selectedGuid);
      if (next) {
        setDraft(toDraft(next));
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
    if (selected?.catalogStatus === "OBSOLETE" && draft.targetStock === 0) {
      window.alert("This item is obsolete. Set a target quantity intended to cover approximately 3–4 years before saving the policy.");
      return;
    }
    await perform(() => window.desktop.planning.saveRestockPolicy(draft), "Restock policy saved locally.");
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
        </div>
        <div className="planning-filters">
          <input aria-label="Search stock planning" placeholder="Search item, group, or supplier…" value={search} onChange={(event) => setSearch(event.target.value)} />
          <select aria-label="Choose finished product" value={productGuid} onChange={(event) => {
            const guid = event.target.value;
            setProductGuid(guid);
            const bom = planning.boms.find((entry) => entry.productTallyGuid === guid && entry.status === "ACTIVE");
            const first = planning.items.find((item) => item.tallyItemGuid === bom?.lines[0]?.componentTallyGuid);
            if (first) choose(first);
          }}><option value="">Choose a Finished Product…</option>{finishedProducts.map((item) => <option key={item.tallyGuid} value={item.tallyGuid}>{item.name} · {[item.primaryGroupName, item.secondaryGroupName].filter(Boolean).join(" › ") || "Ungrouped"}</option>)}</select>
          <select aria-label="Filter by status" value={health} onChange={(event) => setHealth(event.target.value)}><option value="">All statuses</option>{Object.entries(healthLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label="Filter by primary group" value={primaryGroup} onChange={(event) => { setPrimaryGroup(event.target.value); setSecondaryGroup(""); }}><option value="">All primary groups</option>{primaryGroupNames.map((entry) => <option key={entry}>{entry}</option>)}</select>
          <select aria-label="Filter by secondary group" value={secondaryGroup} onChange={(event) => setSecondaryGroup(event.target.value)} disabled={secondaryGroupNames.length === 0}><option value="">All secondary groups</option>{secondaryGroupNames.map((entry) => <option key={entry}>{entry}</option>)}</select>
          <button className="button button--secondary" type="button" onClick={() => { setSearch(""); setProductGuid(""); setHealth(""); setPrimaryGroup(""); setSecondaryGroup(""); }}>Clear filters</button>
        </div>
        <div className="table-scroll planning-restock-table"><table>
          <thead><tr><th>{sortLabel("Status", "health")}</th><th>{sortLabel("Stock Item", "itemName")}</th><th className="numeric">{sortLabel("On hand", "onHand")}</th><th className="numeric">{sortLabel("Reserved", "reserved")}</th><th className="numeric">{sortLabel("Service", "serviceReserve")}</th><th className="numeric">{sortLabel("Available", "available")}</th><th className="numeric">{sortLabel("Incoming", "incoming")}</th><th className="numeric">{sortLabel("Projected", "projected")}</th><th className="numeric">{sortLabel("Reorder", "reorderPoint")}</th><th className="numeric">{sortLabel("Target", "targetStock")}</th><th className="numeric">{sortLabel("Suggested order", "suggestedOrderQuantity")}</th><th>{sortLabel("Supplier", "preferredSupplierName")}</th></tr></thead>
          <tbody>
            {filtered.map((item) => <tr key={item.tallyItemGuid} className={selectedGuid === item.tallyItemGuid ? "selected-row" : ""} onClick={() => choose(item)}>
              <td><span className={`planning-health planning-health--${item.health.toLocaleLowerCase().replaceAll("_", "-")}`}>{healthLabels[item.health]}</span></td>
              <td><strong>{item.itemName}</strong><small className="table-subtext">{[item.primaryGroupName, item.secondaryGroupName].filter(Boolean).join(" › ") || "No group"}{item.catalogSource === "LOCAL" ? " · Local-only" : ""}</small></td>
              <td className="numeric">{item.onHand}</td><td className="numeric">{item.reserved}</td><td className="numeric">{item.serviceReserve}</td><td className="numeric">{item.available}</td><td className="numeric">{item.incoming}</td><td className="numeric">{item.projected}</td><td className="numeric">{item.reorderPoint}</td><td className="numeric">{item.targetStock}</td><td className="numeric"><strong>{item.suggestedOrderQuantity}</strong></td><td>{item.preferredSupplierName || "—"}</td>
            </tr>)}
            {filtered.length === 0 && <tr><td colSpan={12} className="empty-table">No Stock Items match these filters.</td></tr>}
          </tbody>
        </table></div>
      </article>

      {selectedProduct && (
        <article className="panel">
          <div className="panel__header">
            <div><p className="eyebrow">PRODUCT BOM</p><h2>{selectedProduct.name}</h2></div>
            <button className="button button--secondary button--small" type="button" onClick={() => onNavigate("boms")}>Manage BOMs</button>
          </div>
          {selectedBom ? <>
            <div className="import-summary"><strong>{selectedBom.label} · v{selectedBom.versionNumber}</strong><span>{selectedBom.status}</span><span>{selectedBom.source.replaceAll("_", " ")}</span></div>
            <div className="bom-components-grid">{selectedBom.lines.map((line) => <div key={line.id}><strong>{line.componentName}</strong><span>{line.quantityPerProduct} each{line.lossBufferPercent ? ` + ${line.lossBufferPercent}% loss` : ""}</span></div>)}</div>
          </> : <p>No BOM version is available for this manufactured product.</p>}
        </article>
      )}

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
            {selected.catalogStatus === "OBSOLETE" && <div className="recommendation-actions"><span>{selected.yearsOfStock == null ? "No usage history available for a years-of-stock estimate." : `Current stock covers about ${selected.yearsOfStock.toFixed(1)} years.`}</span><button className="button button--secondary" type="button" onClick={() => setDraft({ ...draft, targetStock: selected.suggestedObsoleteTarget })}>Use 3.5-year target ({selected.suggestedObsoleteTarget})</button></div>}
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
