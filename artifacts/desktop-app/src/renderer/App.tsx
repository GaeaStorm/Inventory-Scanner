import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";

import BackupRestorePanel from "./BackupRestorePanel";
import AdministrationDashboard from "./AdministrationDashboard";
import AuthGate from "./AuthGate";
import DeploymentSetup from "./DeploymentSetup";
import InventoryPlanningDashboard from "./InventoryPlanningDashboard";
import OperationsTab from "./OperationsTab";
import TallyTab from "./TallyTab";
import PermissionsPanel from "./PermissionsPanel";
import UserManagementPanel from "./UserManagementPanel";
import {
  getDashboard,
  setApiBaseUrl,
} from "./api";
import type {
  AppTab,
  AuthSession,
  AuthState,
  DashboardState,
  DesktopInfo,
  DeploymentState,
  OperationsState,
  Permission,
  PlanningState,
  StoresState,
  ScannerDevice,
} from "./types";

const tabs: Array<{ id: AppTab; label: string; icon: string; permission?: Permission | Permission[] }> = [
  { id: "administration", label: "Admin Dashboard", icon: "₹", permission: "TALLY_REVIEW" },
  { id: "operations", label: "Orders & Production", icon: "↻", permission: "INVENTORY_VIEW" },
  { id: "dashboard", label: "Inventory Dashboard", icon: "▦", permission: "RESTOCK_VIEW" },
  // Anyone who can manage settings OR just pair scanner phones needs to reach this tab —
  // the panels inside are gated individually so Stores only sees the pairing card.
  { id: "settings", label: "Settings", icon: "⚙", permission: ["SETTINGS_MANAGE", "SCANNER_PAIRING_MANAGE"] },
  { id: "tally", label: "Tally Syncer", icon: "⇄", permission: "TALLY_REVIEW" },
];

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function formatCode(value: string | null): string {
  if (!value) return "";
  return value
    .toLocaleLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toLocaleUpperCase());
}

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>("dashboard");
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [desktopInfo, setDesktopInfo] = useState<DesktopInfo | null>(null);
  const [deployment, setDeployment] = useState<DeploymentState | null>(null);
  const [showDeploymentSetup, setShowDeploymentSetup] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [stores, setStores] = useState<StoresState | null>(null);
  const [planning, setPlanning] = useState<PlanningState | null>(null);
  const [operations, setOperations] = useState<OperationsState | null>(null);
  const [selectedScannerUrl, setSelectedScannerUrl] = useState("");
  const [scannerLabel, setScannerLabel] = useState("Stores phone");
  const [scannerQrUrl, setScannerQrUrl] = useState("");
  const [scannerPairingExpiresAt, setScannerPairingExpiresAt] = useState("");
  const [scannerDevices, setScannerDevices] = useState<ScannerDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [requiredEmail, setRequiredEmail] = useState("");
  const [syncStatus, setSyncStatus] = useState<{ online: boolean; queuedCount: number; reviewable: Array<{ operationId: string; type: string; status: string; createdAt: string }> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      window.desktop.sync.status().then((status) => {
        if (!cancelled) setSyncStatus(status);
      }).catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const refresh = useCallback(async () => {
    setNotice("");
    setError("");
    try {
      const [nextStores, nextPlanning, nextOperations, nextDashboard, nextAuth] = await Promise.all([
        window.desktop.stores.getState(),
        window.desktop.planning.getState(),
        window.desktop.operations.getState(),
        getDashboard(100),
        window.desktop.auth.state(),
      ]);
      setStores(nextStores);
      setPlanning(nextPlanning);
      setOperations(nextOperations);
      setDashboard(nextDashboard);
      setAuth(nextAuth);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 30_000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(""), 30_000);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      try {
        const deploymentState = await window.desktop.deployment.getState();
        if (cancelled) return;
        setDeployment(deploymentState);
        if (!deploymentState.configured) {
          setShowDeploymentSetup(true);
          return;
        }
        const info = await window.desktop.getInfo();
        if (cancelled) return;
        setDesktopInfo(info);
        setApiBaseUrl(info.apiBaseUrl);
        const savedToken = localStorage.getItem("inventory-scanner-session") ?? "";
        if (savedToken) {
          try {
            const resumed = await window.desktop.auth.resume(savedToken);
            if (cancelled) return;
            setSession(resumed);
            await refresh();
            const nextDashboard = await getDashboard(100);
            if (cancelled) return;
            setSelectedScannerUrl(nextDashboard.scannerUrls[0] ?? info.scannerUrls[0] ?? "");
          } catch {
            localStorage.removeItem("inventory-scanner-session");
            if (!cancelled) setAuth(await window.desktop.auth.state());
          }
        } else {
          setAuth(await window.desktop.auth.state());
        }
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setShowDeploymentSetup(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void initialize();
    return () => { cancelled = true; };
  }, [refresh]);

  async function authenticated(nextSession: AuthSession) {
    localStorage.setItem("inventory-scanner-session", nextSession.token);
    setSession(nextSession);
    setLoading(true);
    try {
      await refresh();
      const nextDashboard = await getDashboard(100);
      setSelectedScannerUrl(nextDashboard.scannerUrls[0] ?? desktopInfo?.scannerUrls[0] ?? "");
    } finally {
      setLoading(false);
    }
  }

  async function signOut() {
    await window.desktop.auth.logout();
    localStorage.removeItem("inventory-scanner-session");
    setSession(null);
    setStores(null);
    setPlanning(null);
    setOperations(null);
    setAuth(await window.desktop.auth.state());
  }

  async function saveRequiredEmail() {
    setBusy(true);
    setError("");
    try {
      const user = await window.desktop.auth.updateEmail({ email: requiredEmail });
      setSession((current) => current ? { ...current, user } : current);
      setAuth((current) => current ? { ...current, currentUser: user } : current);
      setRequiredEmail("");
      setNotice("Recovery email saved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const handleStoresChanged = useCallback((state: StoresState) => {
    setStores(state);
    void Promise.all([window.desktop.planning.getState(), window.desktop.operations.getState()]).then(([nextPlanning, nextOperations]) => {
      setPlanning(nextPlanning);
      setOperations(nextOperations);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const scannerUrls = dashboard?.scannerUrls.length
    ? dashboard.scannerUrls
    : desktopInfo?.scannerUrls ?? [];
  useEffect(() => {
    if (activeTab !== "settings" || !session?.permissions.includes("SCANNER_PAIRING_MANAGE")) return;
    void window.desktop.scanners.list().then(setScannerDevices).catch(() => undefined);
  }, [activeTab, session]);

  async function createScannerPairing() {
    if (!selectedScannerUrl) throw new Error("No LAN address is available for scanner pairing.");
    const pairing = await window.desktop.scanners.createPairing(scannerLabel);
    const payload = JSON.stringify({
      type: "inventory-scanner/scanner-pairing",
      version: 1,
      url: selectedScannerUrl,
      pairingToken: pairing.pairingToken,
      deviceLabel: scannerLabel,
    });
    setScannerQrUrl(await QRCode.toDataURL(payload, { width: 760, margin: 2, errorCorrectionLevel: "M" }));
    setScannerPairingExpiresAt(pairing.expiresAt);
  }

  async function perform(action: () => Promise<void>, success?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (success) setNotice(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <main className="loading-screen">Opening Inventory Scanner…</main>;
  }

  if (showDeploymentSetup && deployment) {
    return <DeploymentSetup state={deployment} onCancel={deployment.configured && auth ? () => setShowDeploymentSetup(false) : undefined} />;
  }

  if (!session || !auth?.currentUser) {
    return <AuthGate authState={auth ?? { needsBootstrap: false, currentUser: null, permissions: [], users: [] }} onAuthenticated={(next) => void authenticated(next)} />;
  }

  const visibleTabs = tabs.filter((tab) => !tab.permission
    || (Array.isArray(tab.permission) ? tab.permission.some((permission) => auth.permissions.includes(permission)) : auth.permissions.includes(tab.permission)));
  const can = (permission: Permission) => auth.permissions.includes(permission);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img className="brand__logo" src="./logo.png" alt="Akademika" />
          <div><strong>Inventory Scanner</strong><span>SQLite-backed stores operations</span></div>
        </div>
        <div className="user-menu">
          <div className="server-status"><div><strong>{stores?.database.integrity === "ok" ? "Database healthy" : "Database needs attention"}</strong><small>{desktopInfo?.apiBaseUrl ?? "Local API unavailable"}</small></div><span className="status-dot" /></div>
          <div className="user-menu__identity"><strong>{auth.currentUser.displayName}</strong><small>{formatCode(auth.currentUser.role)}</small></div>
          <button className="button button--secondary button--small" type="button" onClick={() => void signOut()}>Sign out</button>
        </div>
      </header>

      <nav className="tab-bar" aria-label="Application sections">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab-button ${activeTab === tab.id ? "tab-button--active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            <span>{tab.icon}</span>{tab.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {syncStatus && !syncStatus.online && (
          <div className="alert alert--offline">
            <strong>Production is unreachable.</strong> Material In/Out, returns, counts, and condition/fault entries are
            being recorded offline and will sync automatically once Production is back.
            {syncStatus.queuedCount > 0 && <> {syncStatus.queuedCount} queued.</>}
          </div>
        )}
        {syncStatus && syncStatus.reviewable.length > 0 && (
          <div className="alert alert--error">
            <strong>{syncStatus.reviewable.length} offline {syncStatus.reviewable.length === 1 ? "entry" : "entries"} need review.</strong>{" "}
            Production rejected or flagged a conflict on these when they replayed. Check Operations for details.
          </div>
        )}
        {error && <div className="alert alert--error">{error}</div>}
        {notice && <div className="alert alert--success">{notice}</div>}
        {stores?.dataMode === "demo" && (
          <div className="alert alert--demo"><strong>Demo data is active.</strong> Sync Tally to replace it.</div>
        )}

        {activeTab === "operations" && stores && planning && operations && (
          <OperationsTab stores={stores} planning={planning} operations={operations} auth={auth} permissions={auth.permissions} onRefresh={refresh} onNotice={setNotice} onError={setError} />
        )}

        {activeTab === "dashboard" && stores && planning && (
          <InventoryPlanningDashboard
            planning={planning}
            stores={stores}
            permissions={auth.permissions}
            onPlanningChanged={setPlanning}
            onStoresChanged={handleStoresChanged}
            onRefresh={refresh}
            onNotice={setNotice}
            onError={setError}
          />
        )}

        {activeTab === "administration" && operations && planning && (
          <AdministrationDashboard operations={operations} planning={planning} onRefresh={refresh} />
        )}

        {activeTab === "settings" && stores && (
          <section className="tab-page">
            <div className="page-heading"><div><p className="eyebrow">APPLICATION SETTINGS</p><h1>Scanner, database, and exports</h1></div></div>
            <div className="settings-grid settings-grid--application">
              {can("SETTINGS_MANAGE") && <article className="panel">
                <div className="panel__header"><div><p className="eyebrow">COMPANY LAN</p><h2>{desktopInfo?.deploymentRole === "LAN_CLIENT" ? "LAN client" : "Production server"}</h2></div><span className="health-badge">{desktopInfo?.deploymentRole === "LAN_CLIENT" ? "REMOTE" : "AUTHORITATIVE"}</span></div>
                <dl className="settings-details">
                  <div><dt>This computer</dt><dd>{desktopInfo?.computerName ?? "Production"}</dd></div>
                  <div><dt>Mode</dt><dd>{desktopInfo?.deploymentRole === "LAN_CLIENT" ? "Connected to Production" : "Production server"}</dd></div>
                  <div><dt>LAN clients</dt><dd>{desktopInfo?.scannerUrls.join(", ") || "No LAN address detected"}</dd></div>
                  <div><dt>Tally computer</dt><dd>{desktopInfo?.tallyComputerHost ?? "accounts"}:9000</dd></div>
                </dl>
                <p className="table-footnote">{desktopInfo?.deploymentRole === "LAN_CLIENT" ? "This installation has no local company database. Your role and all changes are validated by Production." : "Keep this computer running during company use. Accounts exposes Tally over the LAN; all inventory records and backups remain here."}</p>
                <div className="settings-actions">
                  <button className="button button--secondary" type="button" onClick={() => setShowDeploymentSetup(true)}>Change LAN setup</button>
                </div>
              </article>}
              {can("SCANNER_PAIRING_MANAGE") && <article className="panel">
                <div className="panel__header"><div><p className="eyebrow">PHONE CONNECTION</p><h2>Pair a scanner</h2></div></div>
                <div className="scanner-settings">
                  <div className="scanner-qr-card">{scannerQrUrl ? <img src={scannerQrUrl} alt="One-time phone scanner pairing QR" /> : <span>Create a one-time pairing QR</span>}</div>
                  <div className="scanner-address-controls">
                    <label>Desktop API address<select value={selectedScannerUrl} onChange={(event) => setSelectedScannerUrl(event.target.value)}>{scannerUrls.map((url) => <option key={url}>{url}</option>)}</select></label>
                    <label>Scanner name<input value={scannerLabel} onChange={(event) => setScannerLabel(event.target.value)} placeholder="e.g. Stores phone 1" /></label>
                    <button className="button button--secondary" type="button" onClick={() => void perform(createScannerPairing)} disabled={!selectedScannerUrl || !scannerLabel.trim()}>Create pairing QR</button>
                  </div>
                </div>
                <p className="table-footnote">{scannerPairingExpiresAt ? `This one-time QR expires ${formatDate(scannerPairingExpiresAt)}.` : "Each QR can pair one scanner and expires after 10 minutes. A paired scanner receives its own revocable audit identity."}</p>
                <div className="table-scroll"><table><thead><tr><th>Scanner</th><th>Last seen</th><th>Status</th><th /></tr></thead><tbody>
                  {scannerDevices.map((device) => <tr key={device.id}><td>{device.label}</td><td>{formatDate(device.lastSeenAt)}</td><td>{device.revokedAt ? "Revoked" : "Active"}</td><td>{!device.revokedAt && <button className="button button--ghost button--small" type="button" onClick={() => void perform(async () => {
                    await window.desktop.scanners.revoke(device.id);
                    setScannerDevices(await window.desktop.scanners.list());
                  }, `${device.label} revoked.`)}>Revoke</button>}</td></tr>)}
                  {scannerDevices.length === 0 && <tr><td colSpan={4} className="empty-table">No paired scanners yet.</td></tr>}
                </tbody></table></div>
                <div className="read-only-note"><strong>LAN boundary:</strong> the API listens on the selected company LAN, but scanner inventory routes require a paired device token. Browser origins are restricted; native paired scanners do not send browser-origin headers.</div>
              </article>}
              {can("SETTINGS_MANAGE") && <article className="panel settings-database-card">
                <div className="panel__header"><div><p className="eyebrow">SQLITE</p><h2>Operational database</h2></div><span className="health-badge">{stores.database.integrity.toUpperCase()}</span></div>
                <dl className="settings-details"><div><dt>Path</dt><dd>{stores.database.path}</dd></div><div><dt>Schema</dt><dd>v{stores.database.schemaVersion}</dd></div><div><dt>Size</dt><dd>{formatBytes(stores.database.sizeBytes)}</dd></div><div><dt>Latest backup</dt><dd>{stores.database.latestBackup ?? "—"}</dd></div><div><dt>Host ID</dt><dd><code>{stores.database.hostId}</code></dd></div><div><dt>Writer mode</dt><dd>Authoritative desktop host</dd></div></dl>
              </article>}
            </div>

            {can("AUTH_MANAGE_USERS") && <UserManagementPanel
              auth={auth}
              onRefresh={refresh}
              onNotice={setNotice}
              onError={setError}
            />}

            {can("AUTH_MANAGE_USERS") && <PermissionsPanel onNotice={setNotice} onError={setError} />}

            {desktopInfo?.deploymentRole !== "LAN_CLIENT" && <BackupRestorePanel
              stores={stores}
              onChanged={handleStoresChanged}
              onNotice={setNotice}
              onError={setError}
            />}
          </section>
        )}

        {activeTab === "tally" && stores && (
          <TallyTab stores={stores} operations={operations} localFiles={desktopInfo?.deploymentRole !== "LAN_CLIENT"} onChanged={handleStoresChanged} onOperationsChanged={refresh} />
        )}
      </main>
      {session.user.needsEmail && <div className="production-modal-backdrop">
        <section className="panel auth-email-prompt" role="dialog" aria-modal="true" aria-label="Add recovery email">
          <div><p className="eyebrow">ACCOUNT UPDATE REQUIRED</p><h2>Add your recovery email</h2><p>This existing account does not have an email address. Add one now so forgotten-password recovery can verify your identity.</p></div>
          {error && <div className="alert alert--error">{error}</div>}
          <label>Email address<input autoFocus type="email" value={requiredEmail} onChange={(event) => setRequiredEmail(event.target.value)} required /></label>
          <button className="button" type="button" disabled={busy || !requiredEmail} onClick={() => void saveRequiredEmail()}>{busy ? "Saving…" : "Save email and continue"}</button>
        </section>
      </div>}
    </div>
  );
}
