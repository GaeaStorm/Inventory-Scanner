import { useMemo, useState } from "react";

import InfoTip from "./InfoTip";
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
          <div><p className="eyebrow">OPENING STOCK</p><h2>Set local opening count</h2></div>
          <InfoTip>Use this for stock not represented by historical Tally GRNs. Positive differences become Opening Legacy Stock; GRN-linked quantities are not rewritten.</InfoTip>
        </div>
      </div>
      <div className="opening-form-grid">
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
            {props.stores.stockItems.map((item) => (
              <option key={item.tallyGuid} value={item.tallyGuid}>
                {item.name} · local {item.localAvailableQuantity} · Tally {item.tallyClosingQuantity}
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
