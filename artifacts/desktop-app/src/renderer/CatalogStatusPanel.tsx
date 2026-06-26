import { useMemo, useState } from "react";

import GroupFilterDropdown, { appendFieldLeaves, buildGroupTree, type GroupTreeNode } from "./GroupFilterDropdown";
import InfoTip from "./InfoTip";
import type { CatalogRole, StoresState } from "./types";

const CATALOG_ROLES: CatalogRole[] = ["PRODUCT", "SERVICE", "NEITHER", "IGNORED"];

type MasterKind = "GROUP" | "CATEGORY" | "ITEM";

/** Mirrors stores/database.ts's normalizeFieldValueForName — strips whitespace only, keeps everything else as typed. */
function normalizeFieldValueForName(value: string): string {
  return value.trim().replace(/\s+/g, "");
}

function roleLabel(value: string): string {
  return value
    .toLocaleLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toLocaleUpperCase());
}

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
  const [itemFieldValues, setItemFieldValues] = useState<Record<string, string>>({});
  const [itemGuid, setItemGuid] = useState("");
  const [renameName, setRenameName] = useState("");
  const [duplicateGuid, setDuplicateGuid] = useState("");
  const [newFieldLabel, setNewFieldLabel] = useState("");
  const [newFieldRequired, setNewFieldRequired] = useState(false);
  const [savingField, setSavingField] = useState(false);
  const [designationNode, setDesignationNode] = useState<GroupTreeNode | null>(null);
  const [designationRole, setDesignationRole] = useState<CatalogRole>("NEITHER");
  const [savingDesignation, setSavingDesignation] = useState(false);

  const fieldDefinitions = props.stores.itemFieldDefinitions;
  const missingRequiredField = masterKind === "ITEM"
    && fieldDefinitions.find((field) => field.required && !itemFieldValues[field.key]?.trim());
  const generatedNamePreview = masterKind === "ITEM" && masterName.trim()
    ? (fieldDefinitions.length === 0
      ? masterName.trim()
      : [
          masterParent || "…",
          ...fieldDefinitions.map((field) => normalizeFieldValueForName(itemFieldValues[field.key] ?? "") || "X"),
          masterName.trim(),
        ].join("_"))
    : "";

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
      if (missingRequiredField) {
        props.onError(`Enter a value for the required field "${missingRequiredField.label}".`);
        return;
      }
      await run(
        () => window.desktop.stores.createLocalStockItem({
          name,
          parentName: masterParent,
          categoryName: itemCategory || undefined,
          baseUnits: "Nos",
          fieldValues: itemFieldValues,
        }),
        `Stock Item ${name} created.`,
      );
      setItemFieldValues({});
    }
    setMasterName("");
    setItemCategory("");
  }

  async function addItemField(): Promise<void> {
    const label = newFieldLabel.trim();
    if (!label) return;
    setSavingField(true);
    props.onError("");
    try {
      props.onChanged(await window.desktop.stores.saveItemFieldDefinition({ label, required: newFieldRequired }));
      props.onNotice(`Specification field "${label}" added.`);
      setNewFieldLabel("");
      setNewFieldRequired(false);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingField(false);
    }
  }

  async function deleteItemField(fieldId: string, label: string): Promise<void> {
    await run(
      () => window.desktop.stores.deleteItemFieldDefinition(fieldId),
      `Specification field "${label}" deleted.`,
    );
  }

  async function moveItemField(fieldId: string, direction: -1 | 1): Promise<void> {
    const ids = fieldDefinitions.map((field) => field.id);
    const index = ids.indexOf(fieldId);
    const swapWith = index + direction;
    if (swapWith < 0 || swapWith >= ids.length) return;
    [ids[index], ids[swapWith]] = [ids[swapWith], ids[index]];
    await run(
      () => window.desktop.stores.reorderItemFieldDefinitions(ids),
      "Specification field order updated.",
    );
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

  async function saveDesignation(): Promise<void> {
    if (!designationNode || designationNode.kind === "field") return;
    setSavingDesignation(true);
    props.onError("");
    try {
      if (designationNode.kind === "item") {
        props.onChanged(await window.desktop.stores.setCatalogRole({ tallyItemGuid: designationNode.itemGuid!, role: designationRole }));
      } else {
        props.onChanged(await window.desktop.stores.setGroupCatalogRole({ groupName: designationNode.name, role: designationRole }));
      }
      props.onNotice(`${designationNode.name} is now designated as ${roleLabel(designationRole)}.`);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingDesignation(false);
    }
  }

  async function clearItemDesignationOverride(): Promise<void> {
    if (!designationNode || designationNode.kind !== "item") return;
    await run(
      () => window.desktop.stores.setCatalogRole({ tallyItemGuid: designationNode.itemGuid!, role: null }),
      `${designationNode.name} now inherits its designation from its Stock Group.`,
    );
    setDesignationRole("NEITHER");
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
  const parentTree = useMemo(() => {
    const tree = buildGroupTree(parentChoices.map((entry) => entry.path));
    if (masterKind !== "ITEM" || fieldDefinitions.length === 0) return tree;
    return appendFieldLeaves(
      tree,
      props.stores.stockItems.map((item) => ({ groupPath: item.groupPath, fieldValues: item.fieldValues, displayName: item.name, itemGuid: item.tallyGuid })),
      fieldDefinitions,
    );
  }, [parentChoices, masterKind, fieldDefinitions, props.stores.stockItems]);
  const designationTree = useMemo(() => appendFieldLeaves(
    buildGroupTree(props.stores.catalogGroups.map((entry) => entry.path)),
    props.stores.stockItems.map((item) => ({ groupPath: item.groupPath, fieldValues: item.fieldValues, displayName: item.name, itemGuid: item.tallyGuid })),
    fieldDefinitions,
  ), [props.stores.catalogGroups, props.stores.stockItems, fieldDefinitions]);
  const parentPath = useMemo(() => parentChoices.find((entry) => entry.name === masterParent)?.path ?? [], [parentChoices, masterParent]);
  const categoryTree = useMemo(() => buildGroupTree(props.stores.stockCategories.map((entry) => entry.path)), [props.stores.stockCategories]);
  const categoryPath = useMemo(
    () => props.stores.stockCategories.find((entry) => entry.name === itemCategory)?.path ?? [],
    [props.stores.stockCategories, itemCategory],
  );

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
          <label>Type<select value={masterKind} onChange={(event) => { setMasterKind(event.target.value as MasterKind); setMasterParent(""); setItemCategory(""); setItemFieldValues({}); }}><option value="GROUP">Stock Group</option><option value="CATEGORY">Stock Category</option><option value="ITEM">Stock Item</option></select></label>
          <label>Name<input value={masterName} onChange={(event) => setMasterName(event.target.value)} placeholder={masterKind === "ITEM" ? "Stock Item name" : "New master name"} /></label>
          <div className="catalog-edit-field">
            <span>{masterKind === "ITEM" ? "Stock Group" : "Parent"}</span>
            <GroupFilterDropdown
              ariaLabel={masterKind === "ITEM" ? "Stock Group" : "Parent"}
              tree={parentTree}
              value={parentPath}
              onChange={(path) => setMasterParent(path[path.length - 1] ?? "")}
              allLabel={masterKind === "ITEM" ? "Choose group…" : "Primary (top level)"}
            />
          </div>
          {masterKind === "ITEM" && <div className="catalog-edit-field">
            <span>Category</span>
            <GroupFilterDropdown
              ariaLabel="Category"
              tree={categoryTree}
              value={categoryPath}
              onChange={(path) => setItemCategory(path[path.length - 1] ?? "")}
              allLabel="No category"
            />
          </div>}
          {/* <button className="button" type="button" disabled={busy || !masterName.trim() || (masterKind === "ITEM" && !masterParent) || Boolean(missingRequiredField)} onClick={() => void addMaster()}>Add</button> */}
        </div>
        {masterKind === "ITEM" && fieldDefinitions.length > 0 && <div className="catalog-edit-row catalog-edit-row--fields">
          {fieldDefinitions.map((field) => <label key={field.id}>
            {field.label}{field.required ? " *" : " (optional)"}
            <input
              value={itemFieldValues[field.key] ?? ""}
              onChange={(event) => setItemFieldValues((current) => ({ ...current, [field.key]: event.target.value }))}
              placeholder={field.required ? "Required" : "Leave blank for X"}
            />
          </label>)}
        </div>}
        {generatedNamePreview && <p className="table-footnote">Generated Tally name: <code>{generatedNamePreview}</code></p>}
        <button className="button" type="button" disabled={busy || !masterName.trim() || (masterKind === "ITEM" && !masterParent) || Boolean(missingRequiredField)} onClick={() => void addMaster()}>Add</button>
      </section>

      <section className="catalog-edit-section">
        <div className="heading-with-info">
          <h3>Specification fields</h3>
          <InfoTip>
            These fields are appended in order to every new Stock Item's generated Tally name, so duplicate display names (e.g. many different "Item010"s) still get a unique underlying name. A blank optional field contributes "X".
          </InfoTip>
        </div>
        {fieldDefinitions.length > 0 && <div className="table-scroll">
          <table><thead><tr><th>Field</th><th>Required</th><th /></tr></thead><tbody>
            {fieldDefinitions.map((field, index) => <tr key={field.id}>
              <td>{field.label}</td>
              <td>{field.required ? "Required" : "Optional"}</td>
              <td className="table-actions">
                <button className="button button--ghost button--small" type="button" disabled={busy || index === 0} onClick={() => void moveItemField(field.id, -1)} aria-label={`Move ${field.label} up`}>▲</button>
                <button className="button button--ghost button--small" type="button" disabled={busy || index === fieldDefinitions.length - 1} onClick={() => void moveItemField(field.id, 1)} aria-label={`Move ${field.label} down`}>▼</button>
                <button className="button button--ghost button--small" type="button" disabled={busy} onClick={() => void deleteItemField(field.id, field.label)}>Delete</button>
              </td>
            </tr>)}
          </tbody></table>
        </div>}
        <div className="catalog-edit-row">
          <label>New field label<input value={newFieldLabel} onChange={(event) => setNewFieldLabel(event.target.value)} placeholder="e.g. Pin count, Color" /></label>
          <label className="check-row"><input type="checkbox" checked={newFieldRequired} onChange={(event) => setNewFieldRequired(event.target.checked)} />Required</label>
          <button className="button button--secondary" type="button" disabled={savingField || !newFieldLabel.trim()} onClick={() => void addItemField()}>+ Add field</button>
        </div>
      </section>

      <section className="catalog-edit-section">
        <div className="heading-with-info">
          <h3>Group &amp; item designation</h3>
          <InfoTip>
            Designate a whole Stock Group as Products, Services, or Neither (the default) — far faster than tagging every item. Pick a specific Stock Item instead only when it needs to differ from its group (e.g. a brand-new product before it has a BOM, or one exception within an otherwise-Neither group). Ignored hides it everywhere operational screens look.
          </InfoTip>
        </div>
        <div className="catalog-edit-row">
          <div className="catalog-edit-field">
            <span>Stock Group or Stock Item</span>
            <GroupFilterDropdown
              ariaLabel="Stock Group or Stock Item"
              tree={designationTree}
              value={designationNode?.path ?? []}
              onChange={(_path, node) => {
                setDesignationNode(node ?? null);
                if (!node) return;
                if (node.kind === "item") {
                  const item = props.stores.stockItems.find((entry) => entry.tallyGuid === node.itemGuid);
                  setDesignationRole(item?.effectiveCatalogRole ?? "NEITHER");
                } else if (node.kind !== "field") {
                  const group = props.stores.catalogGroups.find((entry) => entry.name === node.name);
                  setDesignationRole(group?.catalogRole ?? "NEITHER");
                }
              }}
              allLabel="Choose…"
            />
          </div>
          <label>Designation<select
            value={designationRole}
            disabled={!designationNode || designationNode.kind === "field"}
            onChange={(event) => setDesignationRole(event.target.value as CatalogRole)}
          >
            {CATALOG_ROLES.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>)}
          </select></label>
          <button className="button" type="button" disabled={savingDesignation || !designationNode || designationNode.kind === "field"} onClick={() => void saveDesignation()}>Save designation</button>
          {designationNode?.kind === "item" && <button className="button button--ghost" type="button" disabled={busy} onClick={() => void clearItemDesignationOverride()}>Inherit from group</button>}
        </div>
        {designationNode?.kind === "field" && <p className="table-footnote">{designationNode.name} is a specification field value, not a Stock Group or Stock Item — choose its parent group or drill down to the specific item instead.</p>}
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
          }}><option value="">Choose item…</option>{editableItems.map((item) => <option key={item.tallyGuid} value={item.tallyGuid}>{item.qualifiedName}</option>)}</select></label>
          <label>New display name<input value={renameName} onChange={(event) => setRenameName(event.target.value)} disabled={!selected} /></label>
          <button className="button button--secondary" type="button" disabled={busy || !selected || !renameName.trim() || renameName.trim() === selected.name} onClick={() => void rename()}>Rename</button>
          <label>Duplicate of<select value={duplicateGuid} onChange={(event) => setDuplicateGuid(event.target.value)} disabled={!selected}><option value="">Choose primary item…</option>{duplicateTargets.map((item) => <option key={item.tallyGuid} value={item.tallyGuid}>{item.qualifiedName}</option>)}</select></label>
          <button className="button" type="button" disabled={busy || !selected || !duplicateGuid || selected.localAvailableQuantity > 0} onClick={() => void markDuplicate()}>Mark duplicate</button>
        </div>
        {selected && selected.localAvailableQuantity > 0 && duplicateGuid && <p className="catalog-status-warning">This item still has {selected.localAvailableQuantity} units and cannot be hidden as a duplicate.</p>}
      </section>

      {props.stores.qualifiedNameCollisions.length > 0 && <section className="catalog-edit-section">
        <p className="catalog-status-warning">
          {props.stores.qualifiedNameCollisions.length} catalog entr{props.stores.qualifiedNameCollisions.length === 1 ? "y" : "ies"} share the exact same Group &gt; Item path. Review and regroup or rename so each item stays distinguishable:
        </p>
        <ul>
          {props.stores.qualifiedNameCollisions.map((collision) => <li key={collision.qualifiedName}>{collision.qualifiedName} ({collision.itemIds.length} items)</li>)}
        </ul>
      </section>}

      {changedItems.length > 0 && <div className="table-scroll catalog-status-list">
        <table><thead><tr><th>Edited item</th><th>Change</th><th /></tr></thead><tbody>
          {changedItems.map((item) => <tr key={item.tallyGuid}><td><strong>{item.qualifiedName}</strong><small className="table-subtext">{item.tallyName}</small></td><td>{item.catalogStatus === "DUPLICATE" ? `Duplicate of ${item.duplicateOfName ?? "unknown item"}` : "Local rename"}</td><td className="table-actions">
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

      {props.stores.stockItems.some((entry) => entry.source === "LOCAL") && <details className="catalog-local-masters">
        <summary>Manage locally created Stock Items</summary>
        <div className="table-scroll"><table><thead><tr><th>Item</th><th>Available</th><th /></tr></thead><tbody>
          {props.stores.stockItems.filter((entry) => entry.source === "LOCAL").map((entry) => <tr key={`item:${entry.tallyGuid}`}>
            <td>{entry.qualifiedName}</td>
            <td>{entry.localAvailableQuantity}</td>
            <td><button className="button button--ghost button--small" type="button" disabled={busy} onClick={() => void run(() => window.desktop.stores.deleteLocalStockItem(entry.tallyGuid), `${entry.name} deleted.`)}>Delete</button></td>
          </tr>)}
        </tbody></table></div>
      </details>}
    </article>
  );
}
