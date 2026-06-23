import { useMemo, useState } from "react";

import InfoTip from "./InfoTip";
import type { StoresState } from "./types";

type MasterKind = "GROUP" | "CATEGORY" | "ITEM";

export default function CatalogStatusPanel(props: {
  stores: StoresState;
  onChanged: (state: StoresState) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [masterKind, setMasterKind] = useState<MasterKind>("GROUP");
  const [masterName, setMasterName] = useState("");
  const [masterParent, setMasterParent] = useState("");
  const [itemCategory, setItemCategory] = useState("");
  const [itemGuid, setItemGuid] = useState("");
  const [renameName, setRenameName] = useState("");
  const [duplicateGuid, setDuplicateGuid] = useState("");

  const selected = props.stores.stockItems.find((item) => item.tallyGuid === itemGuid) ?? null;
  const editableItems = useMemo(
    () => props.stores.stockItems.filter((item) => item.catalogStatus === "ACTIVE"),
    [props.stores.stockItems],
  );
  const duplicateTargets = editableItems.filter((item) => item.tallyGuid !== itemGuid);
  const changedItems = props.stores.stockItems.filter((item) =>
    item.catalogStatus === "DUPLICATE" || item.name !== item.tallyName
  );

  async function run(change: () => Promise<StoresState>, message: string): Promise<void> {
    setBusy(true);
    props.onError("");
    try {
      props.onChanged(await change());
      props.onNotice(message);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function addMaster(): Promise<void> {
    const name = masterName.trim();
    if (!name) return;
    if (masterKind === "GROUP") {
      await run(
        () => window.desktop.stores.createCatalogGroup({ name, parentName: masterParent || undefined }),
        `Stock Group ${name} created.`,
      );
    } else if (masterKind === "CATEGORY") {
      await run(
        () => window.desktop.stores.createStockCategory({ name, parentName: masterParent || undefined }),
        `Stock Category ${name} created.`,
      );
    } else {
      if (!masterParent) {
        props.onError("Choose a Stock Group for the new item.");
        return;
      }
      await run(
        () => window.desktop.stores.createLocalStockItem({
          name,
          parentName: masterParent,
          categoryName: itemCategory || undefined,
          baseUnits: "Nos",
        }),
        `Stock Item ${name} created.`,
      );
    }
    setMasterName("");
    setItemCategory("");
  }

  async function rename(): Promise<void> {
    if (!selected || !renameName.trim()) return;
    await run(
      () => window.desktop.stores.renameStockItem({
        tallyItemGuid: selected.tallyGuid,
        name: renameName.trim(),
      }),
      `${selected.name} renamed to ${renameName.trim()}.`,
    );
  }

  async function markDuplicate(): Promise<void> {
    if (!selected || !duplicateGuid) return;
    await run(
      () => window.desktop.stores.setCatalogStatus({
        tallyItemGuid: selected.tallyGuid,
        status: "DUPLICATE",
        duplicateOfTallyGuid: duplicateGuid,
      }),
      `${selected.name} is now hidden as a duplicate.`,
    );
    setItemGuid("");
    setRenameName("");
    setDuplicateGuid("");
  }

  async function restoreDuplicate(tallyItemGuid: string, name: string): Promise<void> {
    await run(
      () => window.desktop.stores.setCatalogStatus({ tallyItemGuid, status: "ACTIVE" }),
      `${name} restored to the active catalog.`,
    );
  }

  async function exportMasters(): Promise<void> {
    setBusy(true);
    props.onError("");
    try {
      const result = await window.desktop.stores.exportCatalogCleanup();
      await window.desktop.stores.openPath(result.workbookPath);
      props.onNotice("Created the Tally master workbook and companion XML.");
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const parentChoices = masterKind === "CATEGORY"
    ? props.stores.stockCategories
    : props.stores.catalogGroups;

  return (
    <article className="panel catalog-status-panel">
      <div className="panel__header">
        <div className="heading-with-info">
          <div><p className="eyebrow">CATALOG EDITS</p><h2>Structure, visibility, names, and duplicates</h2></div>
          <InfoTip>
            Add local masters before importing them into Tally. Ignored Stock Groups remain synchronized for history but are hidden from operational screens.
          </InfoTip>
        </div>
        <button className="button button--secondary" type="button" disabled={busy} onClick={() => void exportMasters()}>Export Tally masters</button>
      </div>

      <section className="catalog-edit-section">
        <h3>Add to the catalog</h3>
        <div className="catalog-edit-row">
          <label>Type<select value={masterKind} onChange={(event) => { setMasterKind(event.target.value as MasterKind); setMasterParent(""); setItemCategory(""); }}><option value="GROUP">Stock Group</option><option value="CATEGORY">Stock Category</option><option value="ITEM">Stock Item</option></select></label>
          <label>Name<input value={masterName} onChange={(event) => setMasterName(event.target.value)} placeholder={masterKind === "ITEM" ? "Stock Item name" : "New master name"} /></label>
          <label>{masterKind === "ITEM" ? "Stock Group" : "Parent"}<select value={masterParent} onChange={(event) => setMasterParent(event.target.value)}><option value="">{masterKind === "ITEM" ? "Choose group…" : "Primary (top level)"}</option>{parentChoices.map((entry) => <option key={entry.name} value={entry.name}>{entry.path.join(" › ")}</option>)}</select></label>
          {masterKind === "ITEM" && <label>Category<select value={itemCategory} onChange={(event) => setItemCategory(event.target.value)}><option value="">No category</option>{props.stores.stockCategories.map((entry) => <option key={entry.name} value={entry.name}>{entry.path.join(" › ")}</option>)}</select></label>}
          <button className="button" type="button" disabled={busy || !masterName.trim() || (masterKind === "ITEM" && !masterParent)} onClick={() => void addMaster()}>Add</button>
        </div>
      </section>

      <section className="catalog-edit-section">
        <h3>Stock Group visibility</h3>
        <div className="catalog-group-chips">
          {props.stores.catalogGroups.map((group) => (
            <button
              key={group.name}
              className={`catalog-group-chip ${group.ignored ? "catalog-group-chip--ignored" : ""}`}
              type="button"
              disabled={busy}
              onClick={() => void run(
                () => window.desktop.stores.setCatalogVisibility({ groupName: group.name, ignored: !group.ignored }),
                `${group.name} is now ${group.ignored ? "visible" : "ignored"}.`,
              )}
            >
              <span>{group.path.join(" › ")}</span>
              <strong>{group.ignored ? "Ignored" : "Visible"}</strong>
            </button>
          ))}
        </div>
      </section>

      <section className="catalog-edit-section">
        <h3>Rename or merge a duplicate</h3>
        <div className="catalog-edit-row">
          <label>Stock Item<select value={itemGuid} onChange={(event) => {
            const guid = event.target.value;
            const item = props.stores.stockItems.find((entry) => entry.tallyGuid === guid);
            setItemGuid(guid);
            setRenameName(item?.name ?? "");
            setDuplicateGuid("");
          }}><option value="">Choose item…</option>{editableItems.map((item) => <option key={item.tallyGuid} value={item.tallyGuid}>{item.name}</option>)}</select></label>
          <label>New display name<input value={renameName} onChange={(event) => setRenameName(event.target.value)} disabled={!selected} /></label>
          <button className="button button--secondary" type="button" disabled={busy || !selected || !renameName.trim() || renameName.trim() === selected.name} onClick={() => void rename()}>Rename</button>
          <label>Duplicate of<select value={duplicateGuid} onChange={(event) => setDuplicateGuid(event.target.value)} disabled={!selected}><option value="">Choose primary item…</option>{duplicateTargets.map((item) => <option key={item.tallyGuid} value={item.tallyGuid}>{item.name}</option>)}</select></label>
          <button className="button" type="button" disabled={busy || !selected || !duplicateGuid || selected.localAvailableQuantity > 0} onClick={() => void markDuplicate()}>Mark duplicate</button>
        </div>
        {selected && selected.localAvailableQuantity > 0 && duplicateGuid && <p className="catalog-status-warning">This item still has {selected.localAvailableQuantity} units and cannot be hidden as a duplicate.</p>}
      </section>

      {changedItems.length > 0 && <div className="table-scroll catalog-status-list">
        <table><thead><tr><th>Edited item</th><th>Change</th><th /></tr></thead><tbody>
          {changedItems.map((item) => <tr key={item.tallyGuid}><td><strong>{item.name}</strong><small className="table-subtext">{item.tallyName}</small></td><td>{item.catalogStatus === "DUPLICATE" ? `Duplicate of ${item.duplicateOfName ?? "unknown item"}` : "Local rename"}</td><td className="table-actions">
            {item.catalogStatus === "DUPLICATE" && <button className="button button--ghost button--small" type="button" disabled={busy} onClick={() => void restoreDuplicate(item.tallyGuid, item.name)}>Restore</button>}
            {item.name !== item.tallyName && <button className="button button--ghost button--small" type="button" disabled={busy} onClick={() => void run(() => window.desktop.stores.renameStockItem({ tallyItemGuid: item.tallyGuid, name: item.tallyName }), `${item.tallyName} restored.`)}>Undo rename</button>}
          </td></tr>)}
        </tbody></table>
      </div>}

      {(props.stores.catalogGroups.some((entry) => entry.source === "LOCAL") || props.stores.stockCategories.some((entry) => entry.source === "LOCAL")) && <details className="catalog-local-masters">
        <summary>Manage locally created groups and categories</summary>
        <div className="table-scroll"><table><thead><tr><th>Master</th><th>Path</th><th /></tr></thead><tbody>
          {props.stores.catalogGroups.filter((entry) => entry.source === "LOCAL").map((entry) => <tr key={`group:${entry.name}`}><td>Stock Group</td><td>{entry.path.join(" › ")}</td><td><button className="button button--ghost button--small" type="button" disabled={busy} onClick={() => void run(() => window.desktop.stores.deleteCatalogGroup(entry.name), `${entry.name} deleted.`)}>Delete</button></td></tr>)}
          {props.stores.stockCategories.filter((entry) => entry.source === "LOCAL").map((entry) => <tr key={`category:${entry.name}`}><td>Stock Category</td><td>{entry.path.join(" › ")}</td><td><button className="button button--ghost button--small" type="button" disabled={busy} onClick={() => void run(() => window.desktop.stores.deleteStockCategory(entry.name), `${entry.name} deleted.`)}>Delete</button></td></tr>)}
        </tbody></table></div>
      </details>}
    </article>
  );
}
