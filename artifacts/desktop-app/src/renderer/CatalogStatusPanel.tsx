import { useMemo, useState } from "react";

import InfoTip from "./InfoTip";
import type { CatalogRole, StoresState } from "./types";

type CatalogAction = "DUPLICATE" | "OBSOLETE";
const roleLabels: Record<CatalogRole, string> = {
  FINISHED_PRODUCT: "Finished Product",
  COMPONENT: "Component",
  ACCESSORY: "Accessory",
  PACKAGING: "Packaging",
  OTHER: "Other",
};

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
  const [classificationScope, setClassificationScope] = useState<"ITEM" | "GROUP">("GROUP");
  const [classificationItemGuid, setClassificationItemGuid] = useState("");
  const [classificationGroup, setClassificationGroup] = useState("");
  const [classificationPrimaryGroup, setClassificationPrimaryGroup] = useState("");
  const [classificationRole, setClassificationRole] = useState<CatalogRole>("OTHER");
  const [classificationIgnored, setClassificationIgnored] = useState(false);

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
    () => props.stores.stockItems.filter((item) => item.catalogStatus !== "ACTIVE" || item.name !== item.tallyName || item.ignored || item.itemRoleOverride),
    [props.stores.stockItems],
  );
  const primaryGroups = useMemo(
    () => props.stores.catalogGroups.filter((group) => group.type === "PRIMARY"),
    [props.stores.catalogGroups],
  );
  const secondaryGroups = useMemo(
    () => props.stores.catalogGroups.filter((group) => group.type === "SECONDARY" && group.primaryName === classificationPrimaryGroup),
    [classificationPrimaryGroup, props.stores.catalogGroups],
  );

  function chooseClassificationGroup(name: string) {
    const group = props.stores.catalogGroups.find((entry) => entry.name === name);
    setClassificationGroup(name);
    setClassificationRole(group?.role ?? "OTHER");
    setClassificationIgnored(group?.ignored ?? false);
  }

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
      if (action === "OBSOLETE") {
        window.alert("This item is now obsolete. Open its Restock Policy and set a target quantity intended to cover roughly 3–4 years of expected usage.");
      }
      setItemGuid("");
      setPrimaryGuid("");
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveClassification(): Promise<void> {
    if (classificationScope === "GROUP" && !classificationGroup) {
      props.onError("Choose a Tally group to classify.");
      return;
    }
    if (classificationScope === "ITEM" && !classificationItemGuid) {
      props.onError("Choose a Stock Item to classify.");
      return;
    }
    setBusy(true);
    props.onError("");
    try {
      const next = await window.desktop.stores.setCatalogClassification({
        scope: classificationScope,
        groupName: classificationScope === "GROUP" ? classificationGroup : undefined,
        tallyItemGuid: classificationScope === "ITEM" ? classificationItemGuid : undefined,
        role: classificationRole,
        ignored: classificationIgnored,
      });
      props.onChanged(next);
      props.onNotice(`${classificationScope === "GROUP" ? classificationGroup : next.stockItems.find((item) => item.tallyGuid === classificationItemGuid)?.name} is classified as ${roleLabels[classificationRole]}${classificationIgnored ? " and ignored by operational screens" : ""}.`);
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
          <div><p className="eyebrow">CATALOG CLEANUP</p><h2>Visibility, roles, duplicates, and obsolete items</h2></div>
          <InfoTip>
            Group and item roles control where synchronized Tally Stock Items appear. Ignored groups and items remain synchronized for history but disappear from operational dropdowns.
          </InfoTip>
        </div>
      </div>

      <div className="catalog-status-grid">
        <label>Classify<select value={classificationScope} onChange={(event) => setClassificationScope(event.target.value as typeof classificationScope)}><option value="GROUP">A whole Tally group</option><option value="ITEM">An individual Stock Item</option></select></label>
        {classificationScope === "GROUP" ? <>
          <label>Primary group<select value={classificationPrimaryGroup} onChange={(event) => { setClassificationPrimaryGroup(event.target.value); chooseClassificationGroup(event.target.value); }}><option value="">Choose primary group…</option>{primaryGroups.map((entry) => <option key={entry.name} value={entry.name}>{entry.name} · {entry.itemCount} items</option>)}</select></label>
          <label>Secondary group<select value={classificationGroup === classificationPrimaryGroup ? "" : classificationGroup} onChange={(event) => chooseClassificationGroup(event.target.value || classificationPrimaryGroup)} disabled={!classificationPrimaryGroup || secondaryGroups.length === 0}><option value="">Apply to the primary group</option>{secondaryGroups.map((entry) => <option key={entry.name} value={entry.name}>{entry.name} · {entry.itemCount} items</option>)}</select></label>
        </>
          : <label>Stock Item<select value={classificationItemGuid} onChange={(event) => {
            const item = props.stores.stockItems.find((entry) => entry.tallyGuid === event.target.value);
            setClassificationItemGuid(event.target.value);
            setClassificationRole(item?.catalogRole ?? "OTHER");
            setClassificationIgnored(item?.itemIgnored ?? false);
          }}><option value="">Choose item…</option>{props.stores.stockItems.map((item) => <option key={item.tallyGuid} value={item.tallyGuid}>{item.name} · {[item.primaryGroupName, item.secondaryGroupName].filter(Boolean).join(" › ") || "Ungrouped"}</option>)}</select></label>}
        <label>Catalog role<select value={classificationRole} onChange={(event) => setClassificationRole(event.target.value as CatalogRole)}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="bulk-receipt-exception"><input type="checkbox" checked={classificationIgnored} onChange={(event) => setClassificationIgnored(event.target.checked)} /> Ignored</label>
      </div>
      <div className="settings-actions"><button className="button" type="button" disabled={busy} onClick={() => void saveClassification()}>Save role and visibility</button></div>

      <div className="table-scroll catalog-status-list">
        <table><thead><tr><th>Primary group</th><th>Secondary group</th><th>Role</th><th>Items</th><th>Visibility</th></tr></thead><tbody>
          {props.stores.catalogGroups.map((entry) => <tr key={entry.name}><td>{entry.primaryName}</td><td>{entry.type === "SECONDARY" ? entry.name : "—"}</td><td>{roleLabels[entry.role]}</td><td>{entry.itemCount}</td><td>{entry.ignored ? "Ignored" : "Tracked"}</td></tr>)}
        </tbody></table>
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
            <thead><tr><th>Stock Item</th><th>Tally name</th><th>Role</th><th>Status</th><th>Primary item / stock rule</th><th /></tr></thead>
            <tbody>
              {changedItems.map((item) => (
                <tr key={item.tallyGuid}>
                  <td>{item.name}</td>
                  <td>{item.tallyName}</td>
                  <td>{roleLabels[item.catalogRole]}{item.ignored ? " · Ignored" : ""}</td>
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
