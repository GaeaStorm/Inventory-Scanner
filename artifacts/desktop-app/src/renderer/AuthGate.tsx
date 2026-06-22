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
  const [recovering, setRecovering] = useState(false);
  const [recoveryCredential, setRecoveryCredential] = useState("");
  const [recoveryType, setRecoveryType] = useState<"PASSWORD" | "PIN">("PASSWORD");
  const [notice, setNotice] = useState("");

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

  async function recover(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await window.desktop.auth.forgotPassword({
        username,
        credential: recoveryCredential,
        credentialType: recoveryType,
      });
      setCredential(recoveryCredential);
      setCredentialType(recoveryType);
      setRecoveryCredential("");
      setRecovering(false);
      setNotice("Credential reset. You can sign in with the new credential now.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <form className="panel auth-card" onSubmit={(event) => void (recovering ? recover(event) : submit(event))}>
        <div className="auth-brand">
          <img className="brand__logo" src="./logo.png" alt="Akademika" />
          <div><p className="eyebrow">INVENTORY SCANNER</p><h1>{authState.needsBootstrap ? "Create the first administrator" : recovering ? "Reset forgotten password" : "Sign in"}</h1></div>
        </div>
        {error && <div className="alert alert--error">{error}</div>}
        {notice && <div className="alert alert--success">{notice}</div>}
        {authState.needsBootstrap && <label>Display name<input autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label>}
        <label>Username<input autoComplete="username" autoFocus={!authState.needsBootstrap} value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
        {(authState.needsBootstrap || recovering) && <label>Credential type<select value={recovering ? recoveryType : credentialType} onChange={(event) => recovering ? setRecoveryType(event.target.value as "PASSWORD" | "PIN") : setCredentialType(event.target.value as "PASSWORD" | "PIN")}><option value="PASSWORD">Password</option><option value="PIN">PIN</option></select></label>}
        <label>{(recovering ? recoveryType : credentialType) === "PIN" ? "PIN" : recovering ? "New password" : "Password"}<input type="password" inputMode={(recovering ? recoveryType : credentialType) === "PIN" ? "numeric" : undefined} autoComplete={authState.needsBootstrap || recovering ? "new-password" : "current-password"} value={recovering ? recoveryCredential : credential} onChange={(event) => recovering ? setRecoveryCredential(event.target.value) : setCredential(event.target.value)} required /></label>
        <button className="button" disabled={busy} type="submit">{busy ? recovering ? "Resetting…" : "Signing in…" : authState.needsBootstrap ? "Create administrator" : recovering ? "Reset credential" : "Sign in"}</button>
        {!authState.needsBootstrap && <button className="text-button" type="button" disabled={busy} onClick={() => { setRecovering((value) => !value); setError(""); setNotice(""); }}>{recovering ? "Back to sign in" : "Forgot password?"}</button>}
      </form>
    </main>
  );
}
