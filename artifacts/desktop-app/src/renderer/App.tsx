import { useCallback, useEffect, useMemo, useState } from "react";

import BackupRestorePanel from "./BackupRestorePanel";
import BoxQrCodeCreatorTab from "./BoxQrCodeCreatorTab";
import BulkMaterialInForm from "./BulkMaterialInForm";
import OpeningQuantityPanel from "./OpeningQuantityPanel";
import TallyTab from "./TallyTab";
import {
  getDashboard,
  getScannerQrUrl,
  setApiBaseUrl,
  setWorkbookLocation,
} from "./api";
import type {
  AppTab,
  DashboardState,
  DesktopInfo,
  StoresState,
} from "./types";

const tabs: Array<{ id: AppTab; label: string; icon: string }> = [
  { id: "tracker", label: "Inventory Tracker", icon: "▤" },
  { id: "dashboard", label: "Inventory Dashboard", icon: "▦" },
  { id: "qr", label: "QR Code Creator", icon: "⌗" },
  { id: "settings", label: "Settings", icon: "⚙" },
  { id: "tally", label: "Tally Syncer", icon: "⇄" },
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
  const [activeTab, setActiveTab] = useState<AppTab>("tracker");
  const [desktopInfo, setDesktopInfo] = useState<DesktopInfo | null>(null);
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [stores, setStores] = useState<StoresState | null>(null);
  const [selectedScannerUrl, setSelectedScannerUrl] = useState("");
  const [workbookPath, setWorkbookPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [nextStores, nextDashboard] = await Promise.all([
      window.desktop.stores.getState(),
      getDashboard(100),
    ]);
    setStores(nextStores);
    setDashboard(nextDashboard);
    setWorkbookPath((current) => current || nextDashboard.workbook.path);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      try {
        const info = await window.desktop.getInfo();
        setApiBaseUrl(info.apiBaseUrl);
        const [nextStores, nextDashboard] = await Promise.all([
          window.desktop.stores.getState(),
          getDashboard(100),
        ]);
        if (cancelled) return;
        setDesktopInfo(info);
        setStores(nextStores);
        setDashboard(nextDashboard);
        setWorkbookPath(nextDashboard.workbook.path);
        setSelectedScannerUrl(nextDashboard.scannerUrls[0] ?? info.scannerUrls[0] ?? "");
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void initialize();
    return () => {
      cancelled = true;
    };
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <img className="brand__logo" src="./logo.png" alt="Akademika" />
          <div><strong>Inventory Scanner</strong><span>SQLite-backed stores operations</span></div>
        </div>
        <div className="server-status">
          <div><strong>{stores?.database.integrity === "ok" ? "Database healthy" : "Database needs attention"}</strong><small>{desktopInfo?.apiBaseUrl ?? "Local API unavailable"}</small></div>
          <span className="status-dot" />
        </div>
      </header>

      <nav className="tab-bar" aria-label="Application sections">
        {tabs.map((tab) => (
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
          <div className="alert alert--demo">
            <strong>Demo data is active.</strong> Tally has not supplied any Stock Items yet. You can test boxes, QR labels, FIFO, receipts, and issues with this catalog. A real Tally sync creates a validated backup and replaces all demo records.
          </div>
        )}

        {activeTab === "tracker" && stores && (
          <section className="tab-page">
            <div className="page-heading">
              <div><p className="eyebrow">LOCAL STORES DATABASE</p><h1>Inventory Tracker</h1><p>Every phone event is retained in SQLite. Excel and CSV are generated from this audit history rather than acting as the operational database.</p></div>
              <button className="button button--secondary" type="button" onClick={() => void refresh()}>Refresh</button>
            </div>
            <BulkMaterialInForm
              stores={stores}
              onChanged={setStores}
              onNotice={setNotice}
              onError={setError}
            />
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
          </section>
        )}

        {activeTab === "dashboard" && stores && (
          <section className="tab-page">
            <div className="page-heading"><div><p className="eyebrow">STOCK OVERVIEW</p><h1>Inventory Dashboard</h1><p>Local availability is calculated from supplier purchase lots and FIFO movements. Tally quantity is retained as a reconciliation reference.</p></div></div>
            <section className="stats-grid">
              <article className="stat-card"><span className="stat-card__icon">▦</span><div><small>Tally Stock Items</small><strong>{stores.stockItems.length}</strong><span>synchronized catalog</span></div></article>
              <article className="stat-card"><span className="stat-card__icon">▤</span><div><small>Available count</small><strong>{stores.stockItems.reduce((sum, item) => sum + item.localAvailableQuantity, 0)}</strong><span>across purchase lots</span></div></article>
              <article className="stat-card"><span className="stat-card__icon">⚠</span><div><small>Legacy-stock items</small><strong>{stores.sync.openingLegacyItems}</strong><span>supplier not reconstructed</span></div></article>
              <article className="stat-card"><span className="stat-card__icon">⧉</span><div><small>Active boxes</small><strong>{stores.boxes.length}</strong><span>SQLite box records</span></div></article>
            </section>
            <OpeningQuantityPanel
              stores={stores}
              onChanged={setStores}
              onNotice={setNotice}
              onError={setError}
            />
            <article className="panel table-panel">
              <div className="panel__header"><div><p className="eyebrow">RECONCILIATION</p><h2>Local FIFO balance versus Tally closing count</h2></div></div>
              <div className="table-scroll stores-main-table"><table>
                <thead><tr><th>Stock Item</th><th>Group</th><th className="numeric">Local available</th><th className="numeric">Tally closing</th><th className="numeric">Difference</th><th>BOM</th></tr></thead>
                <tbody>{stores.stockItems.map((item) => {
                  const difference = item.localAvailableQuantity - item.tallyClosingQuantity;
                  return <tr key={item.tallyGuid}><td><strong>{item.name}</strong><small className="table-subtext">{item.tallyGuid}</small></td><td>{item.parentName || "—"}</td><td className="numeric">{item.localAvailableQuantity}</td><td className="numeric">{item.tallyClosingQuantity}</td><td className={`numeric ${difference === 0 ? "text-success" : "text-warning"}`}>{difference}</td><td>{item.hasBom ? "Yes" : "—"}</td></tr>;
                })}</tbody>
              </table></div>
            </article>
          </section>
        )}

        {activeTab === "qr" && stores && (
          <BoxQrCodeCreatorTab stores={stores} onChanged={setStores} />
        )}

        {activeTab === "settings" && stores && (
          <section className="tab-page">
            <div className="page-heading"><div><p className="eyebrow">APPLICATION SETTINGS</p><h1>Scanner, database, and exports</h1><p>The active SQLite database must remain on this computer. Backups and generated Tally files can use folders you select through the operating-system dialog.</p></div></div>
            <div className="settings-grid">
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
                <p className="muted">All domain modules use one application-owned SQLite connection. Phones and future production clients write through this desktop API; do not place the live database on a shared or cloud-synchronized drive.</p>
              </article>
            </div>

            <BackupRestorePanel
              stores={stores}
              onChanged={setStores}
              onNotice={setNotice}
              onError={setError}
            />

            <article className="panel settings-wide-panel">
              <div className="panel__header"><div><p className="eyebrow">LEGACY EXCEL AUDIT</p><h2>Existing workbook location</h2></div></div>
              <p className="muted">This workbook remains available for compatibility and human review, but it is no longer the operational source of truth.</p>
              <label className="path-field">Workbook path<input value={workbookPath} onChange={(event) => setWorkbookPath(event.target.value)} /></label>
              <div className="settings-actions">
                <button className="button" disabled={busy} type="button" onClick={() => void perform(async () => { const result = await setWorkbookLocation(workbookPath); setDashboard((current) => current ? { ...current, workbook: result.workbook } : current); setWorkbookPath(result.workbook.path); }, "Legacy workbook location updated.")}>Save path</button>
                <button className="button button--secondary" type="button" onClick={() => void perform(async () => { const folder = await window.desktop.chooseWorkbookFolder(workbookPath); if (folder) { const result = await setWorkbookLocation(folder); setWorkbookPath(result.workbook.path); } })}>Browse…</button>
                {dashboard?.workbook.path && <button className="button button--secondary" type="button" onClick={() => void window.desktop.openWorkbookFolder(dashboard.workbook.path)}>Open folder</button>}
              </div>
            </article>
          </section>
        )}

        {activeTab === "tally" && stores && (
          <TallyTab stores={stores} onChanged={setStores} />
        )}
      </main>
    </div>
  );
}
