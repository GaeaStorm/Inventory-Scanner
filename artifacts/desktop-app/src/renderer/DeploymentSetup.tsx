import { useEffect, useState } from "react";

import type { DeploymentState, SaveDeploymentInput } from "./types";

interface Props {
  state: DeploymentState;
  onCancel?: () => void;
}

export default function DeploymentSetup({ state, onCancel }: Props) {
  const [role, setRole] = useState<SaveDeploymentInput["role"]>(
    state.role === "LAN_CLIENT" ? "LAN_CLIENT" : "PRODUCTION_SERVER",
  );
  const [productionHost, setProductionHost] = useState(state.productionHost || "production");
  const [inventoryPort, setInventoryPort] = useState(state.inventoryPort || 5000);
  const [tallyHost, setTallyHost] = useState(state.tallyHost || "accounts");
  const [tallyPort, setTallyPort] = useState(state.tallyPort || 9000);
  const [accountsComputer, setAccountsComputer] = useState(state.accountsComputer);
  const [configureFirewall, setConfigureFirewall] = useState(state.platform === "win32");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (role === "PRODUCTION_SERVER") setAccountsComputer(false);
  }, [role]);

  const input: SaveDeploymentInput = {
    role,
    productionHost,
    inventoryPort,
    tallyHost,
    tallyPort,
    accountsComputer,
    configureWindowsFirewall: configureFirewall,
  };

  async function testConnection() {
    setTesting(true);
    setError("");
    setNotice("");
    try {
      const result = await window.desktop.deployment.testProduction({ productionHost, inventoryPort });
      setNotice(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (role === "LAN_CLIENT") await window.desktop.deployment.testProduction({ productionHost, inventoryPort });
      setNotice("Saving setup and restarting Inventory Scanner…");
      await window.desktop.deployment.save(input);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  }

  return (
    <main className="deployment-screen">
      <section className="panel deployment-card">
        <div className="auth-brand">
          <img className="brand__logo" src="./logo.png" alt="Akademika" />
          <div>
            <p className="eyebrow">COMPANY LAN SETUP</p>
            <h1>{state.configured ? "Change this computer’s setup" : "Set up Inventory Scanner"}</h1>
            <p>Choose this computer’s role. The application will remember the setup—no scripts or GitHub files are needed.</p>
          </div>
        </div>

        {error && <div className="alert alert--error">{error}</div>}
        {notice && <div className="alert alert--success">{notice}</div>}

        <div className="deployment-role-grid">
          <button className={`deployment-role ${role === "PRODUCTION_SERVER" ? "deployment-role--selected" : ""}`} type="button" onClick={() => setRole("PRODUCTION_SERVER")}>
            <strong>Production server</strong>
            <span>Keeps the company database, backups, users, and central API.</span>
          </button>
          <button className={`deployment-role ${role === "LAN_CLIENT" ? "deployment-role--selected" : ""}`} type="button" onClick={() => setRole("LAN_CLIENT")}>
            <strong>Company LAN client</strong>
            <span>Connects to Production and does not create a separate company database.</span>
          </button>
        </div>

        <div className="settings-form-grid deployment-form">
          {role === "LAN_CLIENT" && <label>Production computer name or IP
            <input value={productionHost} onChange={(event) => setProductionHost(event.target.value)} placeholder="production" />
          </label>}
          <label>Inventory Scanner port
            <input type="number" min={1} max={65535} value={inventoryPort} onChange={(event) => setInventoryPort(Number(event.target.value))} />
          </label>
          {role === "PRODUCTION_SERVER" && <label>Tally computer name or IP
            <input value={tallyHost} onChange={(event) => setTallyHost(event.target.value)} placeholder="accounts" />
          </label>}
          {role === "PRODUCTION_SERVER" && <label>Tally port
            <input type="number" min={1} max={65535} value={tallyPort} onChange={(event) => setTallyPort(Number(event.target.value))} />
          </label>}
        </div>

        {role === "LAN_CLIENT" && <label className="check-row deployment-check">
          <input type="checkbox" checked={accountsComputer} onChange={(event) => setAccountsComputer(event.target.checked)} />
          This is the Accounts computer running TallyPrime
        </label>}
        {role === "LAN_CLIENT" && accountsComputer && <div className="settings-form-grid deployment-form">
          <label>Tally port
            <input type="number" min={1} max={65535} value={tallyPort} onChange={(event) => setTallyPort(Number(event.target.value))} />
          </label>
        </div>}
        {state.platform === "win32" && (role === "PRODUCTION_SERVER" || accountsComputer) && <label className="check-row deployment-check">
          <input type="checkbox" checked={configureFirewall} onChange={(event) => setConfigureFirewall(event.target.checked)} />
          Configure the recommended Windows firewall rule (Windows will ask for Administrator approval)
        </label>}

        <div className="deployment-actions">
          {role === "LAN_CLIENT" && <button className="button button--secondary" type="button" disabled={busy || testing} onClick={() => void testConnection()}>{testing ? "Testing…" : "Test Production connection"}</button>}
          {onCancel && <button className="button button--secondary" type="button" disabled={busy} onClick={onCancel}>Cancel</button>}
          <button className="button" type="button" disabled={busy || testing} onClick={() => void save()}>{busy ? "Applying setup…" : "Save setup and restart"}</button>
        </div>
        <p className="table-footnote">Use a stable computer name or reserved IP. Keep the Production computer awake while the company is using Inventory Scanner. The server is reachable on the selected company LAN; phone inventory access requires a separately paired and revocable scanner identity.</p>
      </section>
    </main>
  );
}
