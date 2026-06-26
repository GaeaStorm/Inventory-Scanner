import { useMemo, useState } from "react";

import GroupFilterDropdown, {
  appendFieldLeaves,
  buildGroupTree,
  groupFilterValueFromNode,
  itemMatchesFilter,
  type GroupFilterValue,
} from "./GroupFilterDropdown";
import InfoTip from "./InfoTip";
import { operationalStockItems } from "./stock-item-visibility";
import type { StoresState } from "./types";

function transactionId(): string {
  return `DESKTOP-OPENING-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function OpeningQuantityPanel(props: {
  stores: StoresState;
  onChanged: (state: StoresState) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [itemGuid, setItemGuid] = useState("");
  const selected = useMemo(
    () => props.stores.stockItems.find((item) => item.tallyGuid === itemGuid) ?? null,
    [itemGuid, props.stores.stockItems],
  );
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [adjustedBy, setAdjustedBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<GroupFilterValue>({ path: [], groupDepth: 0 });
  const selectableItems = useMemo(
    () => operationalStockItems(props.stores.stockItems),
    [props.stores.stockItems],
  );
  const groupTree = useMemo(() => appendFieldLeaves(
    buildGroupTree(selectableItems.map((item) => item.groupPath).filter((path) => path.length > 0)),
    selectableItems.map((item) => ({ groupPath: item.groupPath, fieldValues: item.fieldValues, displayName: item.name, itemGuid: item.tallyGuid })),
    props.stores.itemFieldDefinitions,
  ), [selectableItems, props.stores.itemFieldDefinitions]);
  const filteredItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return selectableItems.filter((item) => {
      if (groupFilter.path.length > 0 && !itemMatchesFilter(
        groupFilter,
        { groupPath: item.groupPath, fieldValues: item.fieldValues, displayName: item.name },
        props.stores.itemFieldDefinitions,
      )) return false;
      return !query || [item.name, ...item.groupPath, item.tallyGuid].some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [selectableItems, search, groupFilter, props.stores.itemFieldDefinitions]);

  async function save(): Promise<void> {
    if (!selected) return;
    const targetQuantity = Number(target);
    if (!Number.isInteger(targetQuantity) || targetQuantity < 0) {
      props.onError("Opening quantity must be a whole number of zero or more.");
      return;
    }
    if (!reason.trim()) {
      props.onError("Enter a reason for the opening-quantity adjustment.");
      return;
    }
    setBusy(true);
    props.onError("");
    try {
      const state = await window.desktop.stores.setOpeningQuantity({
        clientTransactionId: transactionId(),
        tallyItemGuid: selected.tallyGuid,
        targetQuantity,
        reason: reason.trim(),
        adjustedBy: adjustedBy.trim(),
      });
      props.onChanged(state);
      props.onNotice(
        `${selected.name} local opening quantity is now ${targetQuantity}. Tally-linked receipt quantities were not altered.`,
      );
      setTarget("");
      setReason("");
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel opening-panel">
      <div className="panel__header">
        <div className="heading-with-info">
          <div><p className="eyebrow">OPENING STOCK/EMERGENCY STOCK SET</p><h2>Set local opening count</h2></div>
          <InfoTip>Use this for stock not represented by historical Tally GRNs. Positive differences become Opening Legacy Stock; GRN-linked quantities are not rewritten.</InfoTip>
        </div>
      </div>
      <div className="opening-form-grid">
        <label>
          Stock Group
          <GroupFilterDropdown
            ariaLabel="Filter by Stock Group"
            tree={groupTree}
            value={groupFilter.path}
            onChange={(path, node) => setGroupFilter(groupFilterValueFromNode(path, node))}
          />
        </label>
        <label>
          Search
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Item name, group, or GUID" />
        </label>
        <label>
          Stock Item
          <select
            value={itemGuid}
            onChange={(event) => {
              const nextGuid = event.target.value;
              setItemGuid(nextGuid);
              const item = props.stores.stockItems.find((entry) => entry.tallyGuid === nextGuid);
              setTarget(item ? String(item.localAvailableQuantity) : "");
            }}
          >
            <option value="">Select Stock Item…</option>
            {filteredItems.map((item) => (
              <option key={item.tallyGuid} value={item.tallyGuid}>
                {item.qualifiedName} · local {item.localAvailableQuantity} · Tally {item.tallyClosingQuantity}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target local count
          <input
            inputMode="numeric"
            min="0"
            step="1"
            value={target}
            onChange={(event) => /^\d*$/.test(event.target.value) && setTarget(event.target.value)}
          />
        </label>
        <label>
          Adjusted by
          <input value={adjustedBy} onChange={(event) => setAdjustedBy(event.target.value)} placeholder="Name (optional for v1)" />
        </label>
        <label className="opening-reason">
          Reason
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Physical opening count, staged rollout, legacy stock…"
          />
        </label>
      </div>
      {selected && (
        <p className="muted">
          Current local count: <strong>{selected.localAvailableQuantity}</strong>. Tally reference:
          {" "}<strong>{selected.tallyClosingQuantity}</strong>.
        </p>
      )}
      <div className="settings-actions">
        <button className="button" type="button" disabled={busy || !selected} onClick={() => void save()}>
          {busy ? "Saving…" : "Set opening quantity"}
        </button>
      </div>
      {props.stores.openingQuantityAdjustments.length > 0 && (
        <div className="table-scroll opening-history">
          <table>
            <thead><tr><th>When</th><th>Item</th><th>Previous</th><th>Target</th><th>Change</th><th>Reason</th></tr></thead>
            <tbody>
              {props.stores.openingQuantityAdjustments.slice(0, 10).map((entry) => (
                <tr key={entry.id}>
                  <td>{new Date(entry.createdAt).toLocaleString()}</td>
                  <td>{entry.itemName}</td>
                  <td>{entry.previousAvailableQuantity}</td>
                  <td>{entry.targetAvailableQuantity}</td>
                  <td>{entry.deltaQuantity > 0 ? "+" : ""}{entry.deltaQuantity}</td>
                  <td>{entry.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}
