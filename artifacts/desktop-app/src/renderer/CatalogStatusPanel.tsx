import { useMemo, useState } from "react";

import InfoTip from "./InfoTip";
import type { StoresState } from "./types";

type CatalogAction = "DUPLICATE" | "OBSOLETE";

export default function CatalogStatusPanel(props: {
  stores: StoresState;
  onChanged: (state: StoresState) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [itemGuid, setItemGuid] = useState("");
  const [action, setAction] = useState<CatalogAction>("DUPLICATE");
  const [primaryGuid, setPrimaryGuid] = useState("");
  const [renameName, setRenameName] = useState("");
  const [busy, setBusy] = useState(false);

  const selected = props.stores.stockItems.find((item) => item.tallyGuid === itemGuid) ?? null;
  const activeItems = useMemo(
    () => props.stores.stockItems.filter((item) => item.catalogStatus === "ACTIVE"),
    [props.stores.stockItems],
  );
  const primaryItems = useMemo(
    () => activeItems.filter((item) => item.tallyGuid !== itemGuid),
    [activeItems, itemGuid],
  );
  const changedItems = useMemo(
    () => props.stores.stockItems.filter((item) => item.catalogStatus !== "ACTIVE" || item.name !== item.tallyName),
    [props.stores.stockItems],
  );

  async function save(): Promise<void> {
    if (!selected) {
      props.onError("Choose a Stock Item to classify.");
      return;
    }
    if (action === "DUPLICATE" && !primaryGuid) {
      props.onError("Choose the primary Stock Item for this duplicate.");
      return;
    }
    setBusy(true);
    props.onError("");
    try {
      const next = await window.desktop.stores.setCatalogStatus({
        tallyItemGuid: selected.tallyGuid,
        status: action,
        duplicateOfTallyGuid: action === "DUPLICATE" ? primaryGuid : null,
      });
      props.onChanged(next);
      props.onNotice(
        action === "DUPLICATE"
          ? `${selected.name} is now hidden as a duplicate.`
          : `${selected.name} is marked obsolete and will remain selectable only while stock remains.`,
      );
      setItemGuid("");
      setPrimaryGuid("");
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function restore(tallyItemGuid: string, name: string): Promise<void> {
    setBusy(true);
    props.onError("");
    try {
      const next = await window.desktop.stores.setCatalogStatus({
        tallyItemGuid,
        status: "ACTIVE",
      });
      props.onChanged(next);
      props.onNotice(`${name} was restored to the active catalog.`);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function rename(): Promise<void> {
    if (!selected) {
      props.onError("Choose a Stock Item to rename.");
      return;
    }
    setBusy(true);
    props.onError("");
    try {
      const next = await window.desktop.stores.renameStockItem({
        tallyItemGuid: selected.tallyGuid,
        name: renameName,
      });
      props.onChanged(next);
      props.onNotice(
        renameName.trim().toLocaleLowerCase() === selected.tallyName.toLocaleLowerCase()
          ? `${selected.tallyName} was restored as the local display name.`
          : `${selected.tallyName} is now shown locally as ${renameName.trim()}.`,
      );
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function restoreName(tallyItemGuid: string, tallyName: string): Promise<void> {
    setBusy(true);
    props.onError("");
    try {
      const next = await window.desktop.stores.renameStockItem({
        tallyItemGuid,
        name: tallyName,
      });
      props.onChanged(next);
      if (tallyItemGuid === itemGuid) setRenameName(tallyName);
      props.onNotice(`${tallyName} was restored as the local display name.`);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function exportCleanup(): Promise<void> {
    setBusy(true);
    props.onError("");
    try {
      const result = await window.desktop.stores.exportCatalogCleanup();
      await window.desktop.stores.openPath(result.workbookPath);
      props.onNotice(
        `Created Tally cleanup workbook with ${result.renameCount} rename, ${result.duplicateCount} duplicate, and ${result.obsoleteCount} obsolete item${result.renameCount + result.duplicateCount + result.obsoleteCount === 1 ? "" : "s"}.${result.renameXmlPath ? " A companion Tally rename XML was also created." : ""}${result.warnings.length ? " Review the workbook instructions before changing Tally." : ""}`,
      );
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel catalog-status-panel">
      <div className="panel__header">
        <div className="heading-with-info">
          <div><p className="eyebrow">CATALOG CLEANUP</p><h2>Duplicates and obsolete components</h2></div>
          <InfoTip>
            Duplicate Tally entries are hidden from operational selectors. Obsolete items remain available only until their local stock reaches zero. These labels are local and do not alter Tally.
          </InfoTip>
        </div>
      </div>

      <div className="catalog-status-grid">
        <label>
          Stock Item
          <select value={itemGuid} onChange={(event) => {
            const guid = event.target.value;
            setItemGuid(guid);
            setPrimaryGuid("");
            setRenameName(props.stores.stockItems.find((item) => item.tallyGuid === guid)?.name ?? "");
          }}>
            <option value="">Select Stock Item…</option>
            {activeItems.map((item) => (
              <option key={item.tallyGuid} value={item.tallyGuid}>
                {item.name} · local {item.localAvailableQuantity}
              </option>
            ))}
          </select>
        </label>
        <label>
          Mark as
          <select value={action} onChange={(event) => { setAction(event.target.value as CatalogAction); setPrimaryGuid(""); }}>
            <option value="DUPLICATE">Duplicate of another item</option>
            <option value="OBSOLETE">Obsolete</option>
          </select>
        </label>
        {action === "DUPLICATE" && (
          <label>
            Primary Stock Item
            <select value={primaryGuid} onChange={(event) => setPrimaryGuid(event.target.value)}>
              <option value="">Choose primary item…</option>
              {primaryItems.map((item) => (
                <option key={item.tallyGuid} value={item.tallyGuid}>{item.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {selected && (
        <div className="catalog-rename-row">
          <label>
            Local display name
            <input value={renameName} onChange={(event) => setRenameName(event.target.value)} />
          </label>
          <div>
            <span>Tally currently: <strong>{selected.tallyName}</strong></span>
            <button className="button button--secondary" type="button" disabled={busy || !renameName.trim() || renameName.trim() === selected.name} onClick={() => void rename()}>
              Save local name
            </button>
            {selected.name !== selected.tallyName && (
              <button className="button button--ghost" type="button" disabled={busy} onClick={() => void restoreName(selected.tallyGuid, selected.tallyName)}>
                Undo rename
              </button>
            )}
          </div>
        </div>
      )}

      {selected && action === "DUPLICATE" && selected.localAvailableQuantity > 0 && (
        <p className="catalog-status-warning">
          This item has {selected.localAvailableQuantity} units. Bring its local count to zero before marking it as a duplicate.
        </p>
      )}

      <div className="settings-actions">
        <button
          className="button"
          type="button"
          disabled={busy || !selected || (action === "DUPLICATE" && (!primaryGuid || selected.localAvailableQuantity > 0))}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save catalog status"}
        </button>
        <button className="button button--secondary" type="button" disabled={busy} onClick={() => void exportCleanup()}>
          Export Tally cleanup files
        </button>
      </div>

      {changedItems.length > 0 && (
        <div className="table-scroll catalog-status-list">
          <table>
            <thead><tr><th>Stock Item</th><th>Tally name</th><th>Status</th><th>Primary item / stock rule</th><th /></tr></thead>
            <tbody>
              {changedItems.map((item) => (
                <tr key={item.tallyGuid}>
                  <td>{item.name}</td>
                  <td>{item.tallyName}</td>
                  <td><span className={`review-status review-status--${item.catalogStatus === "ACTIVE" ? "renamed" : item.catalogStatus.toLocaleLowerCase()}`}>{item.catalogStatus === "ACTIVE" ? "RENAMED" : item.catalogStatus}</span></td>
                  <td>
                    {item.catalogStatus === "ACTIVE"
                      ? "Local display name differs from Tally"
                      : item.catalogStatus === "DUPLICATE"
                      ? `Duplicate of ${item.duplicateOfName ?? "unknown item"}`
                      : item.localAvailableQuantity > 0
                        ? `${item.localAvailableQuantity} units remain · still selectable`
                        : "No stock · hidden from selectors"}
                  </td>
                  <td className="table-actions">
                    {item.catalogStatus !== "ACTIVE" && <button className="button button--ghost button--small" type="button" disabled={busy} onClick={() => void restore(item.tallyGuid, item.name)}>Undo status</button>}
                    {item.name !== item.tallyName && <button className="button button--ghost button--small" type="button" disabled={busy} onClick={() => void restoreName(item.tallyGuid, item.tallyName)}>Undo rename</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}
