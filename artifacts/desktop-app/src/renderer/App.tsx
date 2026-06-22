import { useCallback, useEffect, useMemo, useState } from "react";

import BackupRestorePanel from "./BackupRestorePanel";
import AuthGate from "./AuthGate";
import BoxQrCodeCreatorTab from "./BoxQrCodeCreatorTab";
import BulkMaterialInForm from "./BulkMaterialInForm";
import CatalogStatusPanel from "./CatalogStatusPanel";
import InventoryPlanningDashboard from "./InventoryPlanningDashboard";
import OpeningQuantityPanel from "./OpeningQuantityPanel";
import OperationsTab from "./OperationsTab";
import TallyTab from "./TallyTab";
import {
  getDashboard,
  getScannerQrUrl,
  setApiBaseUrl,
  setWorkbookLocation,
} from "./api";
import type {
  AppTab,
  AuthSession,
  AuthState,
  DashboardState,
  DesktopInfo,
  OperationsState,
  Permission,
  PlanningState,
  StoresState,
} from "./types";

const tabs: Array<{ id: AppTab; label: string; icon: string; permission?: Permission }> = [
  { id: "dashboard", label: "Inventory Dashboard", icon: "▦", permission: "RESTOCK_VIEW" },
  { id: "tracker", label: "Inventory Tracker", icon: "▤", permission: "INVENTORY_VIEW" },
  { id: "operations", label: "Orders & Production", icon: "↻", permission: "INVENTORY_VIEW" },
  { id: "qr", label: "QR Code Creator", icon: "⌗", permission: "QR_MANAGE" },
  { id: "settings", label: "Settings", icon: "⚙", permission: "SETTINGS_MANAGE" },
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
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [stores, setStores] = useState<StoresState | null>(null);
  const [planning, setPlanning] = useState<PlanningState | null>(null);
  const [operations, setOperations] = useState<OperationsState | null>(null);
  const [selectedScannerUrl, setSelectedScannerUrl] = useState("");
  const [workbookPath, setWorkbookPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
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
    setWorkbookPath((current) => current || nextDashboard.workbook.path);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      try {
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
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
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
  const scannerQrUrl = useMemo(
    () => (selectedScannerUrl ? getScannerQrUrl(selectedScannerUrl) : ""),
    [selectedScannerUrl],
  );

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
    return <main className="loading-screen">Opening the Local Stores Database…</main>;
  }

  if (!session || !auth?.currentUser) {
    return <AuthGate authState={auth ?? { needsBootstrap: false, currentUser: null, permissions: [], users: [] }} onAuthenticated={(next) => void authenticated(next)} />;
  }

  const visibleTabs = tabs.filter((tab) => !tab.permission || auth.permissions.includes(tab.permission));
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
        {error && <div className="alert alert--error">{error}</div>}
        {notice && <div className="alert alert--success">{notice}</div>}
        {stores?.dataMode === "demo" && (
          <div className="alert alert--demo"><strong>Demo data is active.</strong> Sync Tally to replace it.</div>
        )}

        {activeTab === "tracker" && stores && (
          <section className="tab-page">
            <div className="page-heading">
              <div><p className="eyebrow">LOCAL STORES DATABASE</p><h1>Inventory Tracker</h1></div>
              <button className="button button--secondary" type="button" onClick={() => void refresh()}>Refresh</button>
            </div>
            {can("RECEIVE_MATERIAL") && <BulkMaterialInForm
              stores={stores}
              onChanged={handleStoresChanged}
              onNotice={setNotice}
              onError={setError}
            />}
            <article className="panel table-panel">
              <div className="panel__header"><div><p className="eyebrow">RECENT EVENTS</p><h2>Vendor receipts, issues, and adjustments</h2></div><span className="table-count">{stores.recentMovements.length} shown</span></div>
              <div className="table-scroll stores-main-table"><table>
                <thead><tr><th>Date</th><th>Workflow</th><th>Box</th><th>Item</th><th>Qty</th><th>Destination / details</th><th>PO / challan</th><th>Status</th></tr></thead>
                <tbody>
                  {stores.recentMovements.map((movement) => (
                    <tr key={movement.id}>
                      <td>{movement.eventDate}</td><td>{movement.workflow.replaceAll("_", " ")}</td><td><code>{movement.boxId || "—"}</code></td><td>{movement.itemName}</td><td>{movement.quantity}</td>
                      <td>
                        <span>{movement.destinationName || movement.supplierName || "—"}</span>
                        {movement.workflow === "ADJUSTMENT" && <small className="table-subtext">{movement.adjustmentDirection === "RETURN_TO_STOCK" ? "Return to stock" : "Additional issue"} · {formatCode(movement.adjustmentReason)}{movement.adjustmentNote ? ` · ${movement.adjustmentNote}` : ""}</small>}
                      </td><td>{[movement.poNumber, movement.challanNumber].filter(Boolean).join(" / ") || "—"}</td><td><span className={`review-status review-status--${movement.status.toLowerCase().replaceAll("_", "-")}`}>{movement.status}</span></td>
                    </tr>
                  ))}
                  {stores.recentMovements.length === 0 && <tr><td colSpan={8} className="empty-table">No local inventory movements have been recorded yet.</td></tr>}
                </tbody>
              </table></div>
            </article>
            {can("STOCK_ADJUST") && <OpeningQuantityPanel
              stores={stores}
              onChanged={handleStoresChanged}
              onNotice={setNotice}
              onError={setError}
            />}
            {can("CATALOG_MANAGE") && <CatalogStatusPanel
              stores={stores}
              onChanged={handleStoresChanged}
              onNotice={setNotice}
              onError={setError}
            />}
          </section>
        )}

        {activeTab === "operations" && stores && planning && operations && (
          <OperationsTab stores={stores} planning={planning} operations={operations} auth={auth} permissions={auth.permissions} onRefresh={refresh} onNotice={setNotice} onError={setError} />
        )}

        {activeTab === "dashboard" && stores && planning && (
          <InventoryPlanningDashboard
            planning={planning}
            stores={stores}
            onPlanningChanged={setPlanning}
            onStoresChanged={handleStoresChanged}
            onNotice={setNotice}
            onError={setError}
          />
        )}

        {activeTab === "qr" && stores && (
          <BoxQrCodeCreatorTab stores={stores} onChanged={handleStoresChanged} />
        )}

        {activeTab === "settings" && stores && (
          <section className="tab-page">
            <div className="page-heading"><div><p className="eyebrow">APPLICATION SETTINGS</p><h1>Scanner, database, and exports</h1></div></div>
            <div className="settings-grid">
              <article className="panel">
                <div className="panel__header"><div><p className="eyebrow">COMPANY LAN</p><h2>{desktopInfo?.deploymentRole === "LAN_CLIENT" ? "LAN client" : "Production server"}</h2></div><span className="health-badge">{desktopInfo?.deploymentRole === "LAN_CLIENT" ? "REMOTE" : "AUTHORITATIVE"}</span></div>
                <dl className="settings-details">
                  <div><dt>This computer</dt><dd>{desktopInfo?.computerName ?? "Production"}</dd></div>
                  <div><dt>Mode</dt><dd>{desktopInfo?.deploymentRole === "LAN_CLIENT" ? "Connected to Production" : "Production server"}</dd></div>
                  <div><dt>LAN clients</dt><dd>{desktopInfo?.scannerUrls.join(", ") || "No LAN address detected"}</dd></div>
                  <div><dt>Tally computer</dt><dd>{desktopInfo?.tallyComputerHost ?? "accounts"}:9000</dd></div>
                </dl>
                <p className="table-footnote">{desktopInfo?.deploymentRole === "LAN_CLIENT" ? "This installation has no local company database. Your role and all changes are validated by Production." : "Keep this computer running during company use. Accounts exposes Tally over the LAN; all inventory records and backups remain here."}</p>
              </article>
              <article className="panel">
                <div className="panel__header"><div><p className="eyebrow">PHONE CONNECTION</p><h2>Connect the Expo scanner</h2></div></div>
                <div className="scanner-settings">
                  <div className="scanner-qr-card">{scannerQrUrl ? <img src={scannerQrUrl} alt="Phone scanner connection QR" /> : <span>No LAN address detected</span>}</div>
                  <div className="scanner-address-controls">
                    <label>Desktop API address<select value={selectedScannerUrl} onChange={(event) => setSelectedScannerUrl(event.target.value)}>{scannerUrls.map((url) => <option key={url}>{url}</option>)}</select></label>
                    <button className="button button--secondary" type="button" onClick={() => void navigator.clipboard.writeText(selectedScannerUrl)} disabled={!selectedScannerUrl}>Copy address</button>
                  </div>
                </div>
              </article>
              <article className="panel">
                <div className="panel__header"><div><p className="eyebrow">SQLITE</p><h2>Operational database</h2></div><span className="health-badge">{stores.database.integrity.toUpperCase()}</span></div>
                <dl className="settings-details"><div><dt>Path</dt><dd>{stores.database.path}</dd></div><div><dt>Schema</dt><dd>v{stores.database.schemaVersion}</dd></div><div><dt>Size</dt><dd>{formatBytes(stores.database.sizeBytes)}</dd></div><div><dt>Latest backup</dt><dd>{stores.database.latestBackup ?? "—"}</dd></div><div><dt>Host ID</dt><dd><code>{stores.database.hostId}</code></dd></div><div><dt>Writer mode</dt><dd>Authoritative desktop host</dd></div></dl>
              </article>
            </div>

            {desktopInfo?.deploymentRole !== "LAN_CLIENT" && <BackupRestorePanel
              stores={stores}
              onChanged={handleStoresChanged}
              onNotice={setNotice}
              onError={setError}
            />}

            {desktopInfo?.deploymentRole !== "LAN_CLIENT" && <article className="panel settings-wide-panel">
              <div className="panel__header"><div><p className="eyebrow">LEGACY EXCEL AUDIT</p><h2>Existing workbook location</h2></div></div>
              <label className="path-field">Workbook path<input value={workbookPath} onChange={(event) => setWorkbookPath(event.target.value)} /></label>
              <div className="settings-actions">
                <button className="button" disabled={busy} type="button" onClick={() => void perform(async () => { const result = await setWorkbookLocation(workbookPath); setDashboard((current) => current ? { ...current, workbook: result.workbook } : current); setWorkbookPath(result.workbook.path); }, "Legacy workbook location updated.")}>Save path</button>
                <button className="button button--secondary" type="button" onClick={() => void perform(async () => { const folder = await window.desktop.chooseWorkbookFolder(workbookPath); if (folder) { const result = await setWorkbookLocation(folder); setWorkbookPath(result.workbook.path); } })}>Browse…</button>
                {dashboard?.workbook.path && <button className="button button--secondary" type="button" onClick={() => void window.desktop.openWorkbookFolder(dashboard.workbook.path)}>Open folder</button>}
              </div>
            </article>}
          </section>
        )}

        {activeTab === "tally" && stores && (
          <TallyTab stores={stores} operations={operations} localFiles={desktopInfo?.deploymentRole !== "LAN_CLIENT"} onChanged={handleStoresChanged} onOperationsChanged={refresh} />
        )}
      </main>
    </div>
  );
}
