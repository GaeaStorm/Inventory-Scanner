import { useState, type FormEvent } from "react";

import PasswordInput from "./PasswordInput";
import type { AuthState, UserRole } from "./types";

interface Props {
  auth: AuthState;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

const recommendedRoles: UserRole[] = ["PRODUCTION", "ACCOUNTS", "STORE", "SALES"];

export default function UserManagementPanel({ auth, onRefresh, onNotice, onError }: Props) {
  const [selected, setSelected] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("STORE");
  const [credential, setCredential] = useState("");
  const [credentialType, setCredentialType] = useState<"PASSWORD" | "PIN">("PASSWORD");
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);

  function clear(nextRole: UserRole = "STORE") {
    setSelected("");
    setDisplayName("");
    setUsername("");
    setEmail("");
    setRole(nextRole);
    setCredential("");
    setCredentialType("PASSWORD");
    setActive(true);
  }

  function choose(userId: string) {
    const user = auth.users.find((entry) => entry.userId === userId);
    if (!user) return;
    setSelected(user.userId);
    setDisplayName(user.displayName);
    setUsername(user.username);
    setEmail(user.email);
    setRole(user.role);
    setCredential("");
    setCredentialType(user.credentialType);
    setActive(user.active);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    onError("");
    try {
      await window.desktop.operations.saveUser({
        id: selected || undefined,
        displayName,
        username,
        email,
        role,
        credential: credential || undefined,
        credentialType,
        active,
      });
      await onRefresh();
      onNotice(selected ? "Company account updated." : `${role} account created.`);
      clear(role);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel settings-wide-panel account-setup-panel">
      <div className="panel__header">
        <div><p className="eyebrow">COMPANY ACCESS</p><h2>Accounts and roles</h2></div>
        <span className="health-badge">{auth.users.filter((user) => user.active).length} ACTIVE</span>
      </div>
      <p>Create an individual login for each person. Their role controls both the screens they see and the actions the Production server accepts.</p>
      <div className="role-checklist">
        {recommendedRoles.map((recommendedRole) => {
          const count = auth.users.filter((user) => user.active && user.role === recommendedRole).length;
          return <button key={recommendedRole} type="button" className={`role-check ${count ? "role-check--ready" : ""}`} onClick={() => clear(recommendedRole)}>
            <strong>{recommendedRole}</strong><span>{count ? `${count} active` : "Add account"}</span>
          </button>;
        })}
      </div>
      <div className="account-setup-grid">
        <div className="table-scroll">
          <table>
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>
              {auth.users.map((user) => <tr key={user.userId} className={selected === user.userId ? "selected-row" : ""} onClick={() => choose(user.userId)}>
                <td>{user.displayName}<small className="table-subtext">{user.email}</small></td>
                <td>{user.username}</td><td>{user.role}</td><td>{user.active ? "Active" : "Inactive"}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <form className="settings-form-grid account-form" onSubmit={(event) => void save(event)}>
          <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label>
          <label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
          <label>Recovery email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          <label>Role<select value={role} onChange={(event) => setRole(event.target.value as UserRole)}>{["STORE", "ACCOUNTS", "PRODUCTION", "SALES", "ADMIN"].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Credential type<select value={credentialType} onChange={(event) => setCredentialType(event.target.value as "PASSWORD" | "PIN")}><option value="PASSWORD">Password</option><option value="PIN">PIN</option></select></label>
          <label>{selected ? "New credential (optional)" : credentialType === "PIN" ? "PIN" : "Password"}<PasswordInput inputMode={credentialType === "PIN" ? "numeric" : undefined} value={credential} onChange={(event) => setCredential(event.target.value)} required={!selected} /></label>
          <label className="check-row"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />Active account</label>
          <div className="account-form-actions">
            {selected && <button className="button button--secondary" type="button" disabled={busy} onClick={() => clear()}>New account</button>}
            <button className="button" type="submit" disabled={busy}>{busy ? "Saving…" : selected ? "Update account" : "Create account"}</button>
          </div>
        </form>
      </div>
    </article>
  );
}
