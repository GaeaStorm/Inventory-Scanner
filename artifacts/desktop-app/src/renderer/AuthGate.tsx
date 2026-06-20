import { useState, type FormEvent } from "react";

import type { AuthSession, AuthState } from "./types";

interface Props {
  authState: AuthState;
  onAuthenticated: (session: AuthSession) => void;
}

export default function AuthGate({ authState, onAuthenticated }: Props) {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [credential, setCredential] = useState("");
  const [credentialType, setCredentialType] = useState<"PASSWORD" | "PIN">("PASSWORD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = authState.needsBootstrap
        ? await window.desktop.auth.bootstrap({ displayName, username, credential, credentialType })
        : await window.desktop.auth.login({ username, credential, deviceLabel: "Electron desktop" });
      onAuthenticated(session);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <form className="panel auth-card" onSubmit={(event) => void submit(event)}>
        <div className="auth-brand">
          <img className="brand__logo" src="./logo.png" alt="Akademika" />
          <div><p className="eyebrow">INVENTORY SCANNER</p><h1>{authState.needsBootstrap ? "Create the first administrator" : "Sign in"}</h1></div>
        </div>
        {error && <div className="alert alert--error">{error}</div>}
        {authState.needsBootstrap && <label>Display name<input autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label>}
        <label>Username<input autoComplete="username" autoFocus={!authState.needsBootstrap} value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
        {authState.needsBootstrap && <label>Credential type<select value={credentialType} onChange={(event) => setCredentialType(event.target.value as "PASSWORD" | "PIN")}><option value="PASSWORD">Password</option><option value="PIN">PIN</option></select></label>}
        <label>{credentialType === "PIN" ? "PIN" : "Password"}<input type="password" inputMode={credentialType === "PIN" ? "numeric" : undefined} autoComplete={authState.needsBootstrap ? "new-password" : "current-password"} value={credential} onChange={(event) => setCredential(event.target.value)} required /></label>
        <button className="button" disabled={busy} type="submit">{busy ? "Signing in…" : authState.needsBootstrap ? "Create administrator" : "Sign in"}</button>
      </form>
    </main>
  );
}
