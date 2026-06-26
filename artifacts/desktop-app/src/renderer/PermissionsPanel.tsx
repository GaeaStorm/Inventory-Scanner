import { useEffect, useMemo, useState } from "react";

interface RolePermissionRow {
  roleName: string;
  permission: string;
  enabled: boolean;
}

function permissionLabel(value: string): string {
  return value
    .toLocaleLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toLocaleUpperCase());
}

export default function PermissionsPanel({ onNotice, onError }: {
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [rows, setRows] = useState<RolePermissionRow[] | null>(null);
  const [busyKey, setBusyKey] = useState("");
  const [restrictions, setRestrictions] = useState<Array<{ permission: string; computerNames: string[] }> | null>(null);
  const [restrictionDrafts, setRestrictionDrafts] = useState<Record<string, string>>({});
  const [savingRestriction, setSavingRestriction] = useState("");

  async function load() {
    try {
      setRows(await window.desktop.operations.getRolePermissions());
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function loadRestrictions() {
    try {
      const result = await window.desktop.operations.getComputerRestrictions();
      setRestrictions(result);
      setRestrictionDrafts(Object.fromEntries(result.map((entry) => [entry.permission, entry.computerNames.join(", ")])));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    void load();
    void loadRestrictions();
  }, []);

  async function saveRestriction(permission: string) {
    setSavingRestriction(permission);
    onError("");
    try {
      const computerNames = (restrictionDrafts[permission] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
      const result = await window.desktop.operations.setComputerRestriction({ permission, computerNames });
      setRestrictions(result);
      onNotice(computerNames.length
        ? `${permissionLabel(permission)} is now restricted to: ${computerNames.join(", ")}.`
        : `${permissionLabel(permission)} is now unrestricted.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingRestriction("");
    }
  }

  const roles = useMemo(() => [...new Set((rows ?? []).map((row) => row.roleName))], [rows]);
  const permissions = useMemo(() => [...new Set((rows ?? []).map((row) => row.permission))], [rows]);
  const enabledByKey = useMemo(
    () => new Map((rows ?? []).map((row) => [`${row.roleName}::${row.permission}`, row.enabled])),
    [rows],
  );

  async function toggle(roleName: string, permission: string, enabled: boolean) {
    const key = `${roleName}::${permission}`;
    setBusyKey(key);
    onError("");
    try {
      setRows(await window.desktop.operations.setRolePermission({ roleName, permission, enabled }));
      onNotice(`${permissionLabel(permission)} ${enabled ? "granted to" : "revoked from"} ${roleName}.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey("");
    }
  }

  return (
    <article className="panel settings-wide-panel">
      <div className="panel__header">
        <div><p className="eyebrow">ACCESS CONTROL</p><h2>Role permissions</h2></div>
        <button className="button button--secondary button--small" type="button" onClick={() => void load()}>Refresh</button>
      </div>
      <p>Turn individual permissions on or off per role &mdash; for example, give Stores the ability to pair scanner phones without granting the rest of Settings.</p>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Permission</th>{roles.map((roleName) => <th key={roleName}>{roleName}</th>)}</tr></thead>
          <tbody>
            {permissions.map((permission) => <tr key={permission}>
              <td>{permissionLabel(permission)}</td>
              {roles.map((roleName) => {
                const key = `${roleName}::${permission}`;
                const enabled = enabledByKey.get(key) ?? false;
                return <td key={roleName} className="numeric">
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={busyKey === key || (roleName === "ADMIN")}
                    onChange={(event) => void toggle(roleName, permission, event.target.checked)}
                    aria-label={`${permissionLabel(permission)} for ${roleName}`}
                  />
                </td>;
              })}
            </tr>)}
            {permissions.length === 0 && <tr><td colSpan={roles.length + 1} className="empty-table">Loading permissions…</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="table-footnote">ADMIN always has every permission and cannot be restricted from this screen.</p>
      <div className="panel__header">
        <div><p className="eyebrow">ACCESS CONTROL</p><h2>Computer restrictions</h2></div>
        <button className="button button--secondary button--small" type="button" onClick={() => void loadRestrictions()}>Refresh</button>
      </div>
      <p>Limit a permission to specific named computers &mdash; for example, only the Accounts computer can approve CRFs, even if other computers have an Accounts user signed in. Leave blank for no restriction.</p>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Permission</th><th>Allowed computers (comma-separated, blank = unrestricted)</th><th /></tr></thead>
          <tbody>
            {permissions.map((permission) => <tr key={permission}>
              <td>{permissionLabel(permission)}</td>
              <td>
                <input
                  value={restrictionDrafts[permission] ?? ""}
                  onChange={(event) => setRestrictionDrafts((current) => ({ ...current, [permission]: event.target.value }))}
                  placeholder="e.g. ACCOUNTS-PC"
                />
              </td>
              <td>
                <button
                  className="button button--secondary button--small"
                  type="button"
                  disabled={savingRestriction === permission}
                  onClick={() => void saveRestriction(permission)}
                >
                  Save
                </button>
              </td>
            </tr>)}
            {permissions.length === 0 && <tr><td colSpan={3} className="empty-table">Loading permissions…</td></tr>}
          </tbody>
        </table>
      </div>
      {restrictions === null && <p className="table-footnote">Loading current restrictions…</p>}
    </article>
  );
}
