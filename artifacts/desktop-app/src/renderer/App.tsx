import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createTransaction,
  getProducts,
  getTransactions,
  setApiBaseUrl,
} from "./api";
import type {
  AdjustmentDirection,
  CreateTransactionInput,
  DesktopInfo,
  InventoryTransaction,
  MovementType,
  Product,
} from "./types";

interface TransactionDraft {
  refNo: string;
  movementType: MovementType;
  itemCode: string;
  quantity: string;
  unitRate: string;
  godown: string;
  batchNo: string;
  usedIn: string;
  adjustmentDirection: AdjustmentDirection;
}

function createReference(): string {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  const time = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `REF-${date}-${time}`;
}

function emptyDraft(itemCode = ""): TransactionDraft {
  return {
    refNo: createReference(),
    movementType: "Restock",
    itemCode,
    quantity: "1",
    unitRate: "0",
    godown: "Main",
    batchNo: "N/A",
    usedIn: "General",
    adjustmentDirection: "in",
  };
}

function signedQuantity(transaction: InventoryTransaction): number {
  if (transaction.movementType === "Restock") return transaction.quantity;
  if (transaction.movementType === "Use") return -transaction.quantity;
  return transaction.adjustmentDirection === "out"
    ? -transaction.quantity
    : transaction.quantity;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function movementClass(transaction: InventoryTransaction): string {
  if (signedQuantity(transaction) >= 0) return "movement movement--in";
  return "movement movement--out";
}

export default function App() {
  const [desktopInfo, setDesktopInfo] = useState<DesktopInfo | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [draft, setDraft] = useState<TransactionDraft>(() => emptyDraft());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refreshTransactions = useCallback(async () => {
    const nextTransactions = await getTransactions();
    setTransactions(nextTransactions);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let interval: number | undefined;

    async function initialize() {
      try {
        const info = await window.desktop.getInfo();
        setApiBaseUrl(info.apiBaseUrl);
        const [nextProducts, nextTransactions] = await Promise.all([
          getProducts(),
          getTransactions(),
        ]);

        if (cancelled) return;
        setDesktopInfo(info);
        setProducts(nextProducts);
        setTransactions(nextTransactions);
        setDraft(emptyDraft(nextProducts[0]?.id ?? ""));
        interval = window.setInterval(() => {
          void refreshTransactions().catch(() => undefined);
        }, 4_000);
      } catch (initializationError) {
        if (!cancelled) {
          setError(
            initializationError instanceof Error
              ? initializationError.message
              : String(initializationError),
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void initialize();
    return () => {
      cancelled = true;
      if (interval) window.clearInterval(interval);
    };
  }, [refreshTransactions]);

  const inventory = useMemo(() => {
    const balances = new Map<string, number>();
    for (const product of products) balances.set(product.id, 0);
    for (const transaction of transactions) {
      balances.set(
        transaction.itemCode,
        (balances.get(transaction.itemCode) ?? 0) + signedQuantity(transaction),
      );
    }
    return products.map((product) => ({
      ...product,
      balance: balances.get(product.id) ?? 0,
    }));
  }, [products, transactions]);

  const totals = useMemo(() => {
    let quantityIn = 0;
    let quantityOut = 0;
    for (const transaction of transactions) {
      const signed = signedQuantity(transaction);
      if (signed >= 0) quantityIn += signed;
      else quantityOut += Math.abs(signed);
    }
    return { quantityIn, quantityOut };
  }, [transactions]);

  function updateDraft<Key extends keyof TransactionDraft>(
    key: Key,
    value: TransactionDraft[Key],
  ): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function submitTransaction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");

    const product = products.find((candidate) => candidate.id === draft.itemCode);
    const quantity = Number(draft.quantity);
    if (!product) {
      setError("Choose an inventory item.");
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError("Quantity must be greater than zero.");
      return;
    }

    const payload: CreateTransactionInput = {
      refNo: draft.refNo.trim(),
      movementType: draft.movementType,
      itemCode: product.id,
      itemName: product.name,
      quantity,
      unitRate: draft.unitRate.trim() || "0",
      godown: draft.godown.trim(),
      batchNo: draft.batchNo.trim(),
      usedIn: draft.usedIn.trim(),
      timestamp: new Date().toISOString(),
      ...(draft.movementType === "Adjustment"
        ? { adjustmentDirection: draft.adjustmentDirection }
        : {}),
    };

    if (
      !payload.refNo ||
      !payload.godown ||
      !payload.batchNo ||
      !payload.usedIn
    ) {
      setError("Reference, godown, batch, and usage fields are required.");
      return;
    }

    setSaving(true);
    try {
      await createTransaction(payload);
      await refreshTransactions();
      setDraft(emptyDraft(product.id));
      setNotice("Transaction saved to the local Excel workbook.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  async function copyScannerUrl(url: string): Promise<void> {
    await navigator.clipboard.writeText(url);
    setNotice(`Copied ${url}`);
  }

  if (loading) {
    return (
      <main className="loading-screen">
        <div className="spinner" />
        <p>Starting the local inventory server…</p>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand__mark">IS</div>
          <div>
            <strong>Inventory Scanner</strong>
            <span>Desktop</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Primary navigation">
          <a className="nav-item nav-item--active" href="#overview">
            <span>▦</span> Overview
          </a>
          <a className="nav-item" href="#transaction-form">
            <span>＋</span> New transaction
          </a>
          <a className="nav-item" href="#inventory-table">
            <span>▤</span> Inventory
          </a>
          <a className="nav-item" href="#recent-transactions">
            <span>↻</span> Activity
          </a>
        </nav>

        <div className="sidebar__footer">
          <span className="status-dot" /> Local server running
          <small>Version {desktopInfo?.appVersion ?? "1.0.0"}</small>
        </div>
      </aside>

      <main className="content">
        <header className="page-header" id="overview">
          <div>
            <p className="eyebrow">LOCAL INVENTORY</p>
            <h1>Operations dashboard</h1>
            <p>Record stock movements and connect phone scanners over Wi-Fi.</p>
          </div>
          <div className="header-actions">
            <button className="button button--secondary" onClick={() => void window.desktop.openDataFolder()}>
              Open data folder
            </button>
            <button className="button" onClick={() => void window.desktop.showExcelFile()}>
              Show Excel file
            </button>
          </div>
        </header>

        {error && <div className="alert alert--error">{error}</div>}
        {notice && <div className="alert alert--success">{notice}</div>}

        <section className="stats-grid" aria-label="Inventory statistics">
          <article className="stat-card">
            <span className="stat-card__icon">▦</span>
            <div>
              <small>Products</small>
              <strong>{products.length}</strong>
              <span>catalogued items</span>
            </div>
          </article>
          <article className="stat-card">
            <span className="stat-card__icon">↙</span>
            <div>
              <small>Quantity in</small>
              <strong>{totals.quantityIn.toLocaleString("en-IN")}</strong>
              <span>across all transactions</span>
            </div>
          </article>
          <article className="stat-card">
            <span className="stat-card__icon">↗</span>
            <div>
              <small>Quantity out</small>
              <strong>{totals.quantityOut.toLocaleString("en-IN")}</strong>
              <span>used or adjusted out</span>
            </div>
          </article>
          <article className="stat-card">
            <span className="stat-card__icon">✓</span>
            <div>
              <small>Transactions</small>
              <strong>{transactions.length}</strong>
              <span>this app session</span>
            </div>
          </article>
        </section>

        <section className="workspace-grid">
          <article className="panel" id="transaction-form">
            <div className="panel__header">
              <div>
                <p className="eyebrow">MANUAL ENTRY</p>
                <h2>Record a movement</h2>
              </div>
            </div>

            <form className="transaction-form" onSubmit={submitTransaction}>
              <label>
                Movement type
                <select
                  value={draft.movementType}
                  onChange={(event) =>
                    updateDraft("movementType", event.target.value as MovementType)
                  }
                >
                  <option value="Restock">Restock</option>
                  <option value="Use">Use</option>
                  <option value="Adjustment">Adjustment</option>
                </select>
              </label>

              {draft.movementType === "Adjustment" && (
                <label>
                  Adjustment direction
                  <select
                    value={draft.adjustmentDirection}
                    onChange={(event) =>
                      updateDraft(
                        "adjustmentDirection",
                        event.target.value as AdjustmentDirection,
                      )
                    }
                  >
                    <option value="in">In</option>
                    <option value="out">Out</option>
                  </select>
                </label>
              )}

              <label className="field--wide">
                Item
                <select
                  value={draft.itemCode}
                  onChange={(event) => updateDraft("itemCode", event.target.value)}
                  required
                >
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.id} — {product.name} ({product.unit})
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Quantity
                <input
                  type="number"
                  min="0.0001"
                  step="any"
                  value={draft.quantity}
                  onChange={(event) => updateDraft("quantity", event.target.value)}
                  required
                />
              </label>

              <label>
                Unit rate
                <input
                  inputMode="decimal"
                  value={draft.unitRate}
                  onChange={(event) => updateDraft("unitRate", event.target.value)}
                  required
                />
              </label>

              <label>
                Reference number
                <input
                  value={draft.refNo}
                  onChange={(event) => updateDraft("refNo", event.target.value)}
                  required
                />
              </label>

              <label>
                Godown
                <input
                  value={draft.godown}
                  onChange={(event) => updateDraft("godown", event.target.value)}
                  required
                />
              </label>

              <label>
                Batch number
                <input
                  value={draft.batchNo}
                  onChange={(event) => updateDraft("batchNo", event.target.value)}
                  required
                />
              </label>

              <label>
                Used in
                <input
                  value={draft.usedIn}
                  onChange={(event) => updateDraft("usedIn", event.target.value)}
                  required
                />
              </label>

              <button className="button field--wide" type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save transaction"}
              </button>
            </form>
          </article>

          <article className="panel connection-panel">
            <div className="panel__header">
              <div>
                <p className="eyebrow">PHONE SCANNER</p>
                <h2>Local network connection</h2>
              </div>
              <span className="live-badge">LIVE</span>
            </div>

            <p className="muted">
              Connect the phone to the same Wi-Fi network, then use one of these
              addresses as the scanner API base URL.
            </p>

            <div className="url-list">
              {(desktopInfo?.scannerUrls.length ?? 0) > 0 ? (
                desktopInfo?.scannerUrls.map((url) => (
                  <button
                    className="url-card"
                    key={url}
                    onClick={() => void copyScannerUrl(url)}
                  >
                    <span>{url}</span>
                    <small>Copy</small>
                  </button>
                ))
              ) : (
                <div className="empty-state">
                  No LAN address was detected. Check the computer's Wi-Fi or
                  Ethernet connection.
                </div>
              )}
            </div>

            <dl className="connection-details">
              <div>
                <dt>Local API</dt>
                <dd>{desktopInfo?.apiBaseUrl}</dd>
              </div>
              <div>
                <dt>Workbook</dt>
                <dd>{desktopInfo?.excelPath}</dd>
              </div>
            </dl>
          </article>
        </section>

        <section className="panel table-panel" id="inventory-table">
          <div className="panel__header">
            <div>
              <p className="eyebrow">CURRENT SESSION</p>
              <h2>Inventory balances</h2>
            </div>
            <span className="table-count">{inventory.length} items</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Item</th>
                  <th>Unit</th>
                  <th className="numeric">Balance</th>
                </tr>
              </thead>
              <tbody>
                {inventory.map((item) => (
                  <tr key={item.id}>
                    <td><code>{item.id}</code></td>
                    <td>{item.name}</td>
                    <td>{item.unit}</td>
                    <td className={`numeric balance ${item.balance < 0 ? "balance--negative" : ""}`}>
                      {item.balance.toLocaleString("en-IN")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel table-panel" id="recent-transactions">
          <div className="panel__header">
            <div>
              <p className="eyebrow">ACTIVITY</p>
              <h2>Recent transactions</h2>
            </div>
            <button className="text-button" onClick={() => void refreshTransactions()}>
              Refresh
            </button>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Reference</th>
                  <th>Item</th>
                  <th>Movement</th>
                  <th className="numeric">Quantity</th>
                  <th>Godown</th>
                </tr>
              </thead>
              <tbody>
                {[...transactions].reverse().slice(0, 50).map((transaction) => (
                  <tr key={transaction.id}>
                    <td>{formatDate(transaction.timestamp)}</td>
                    <td><code>{transaction.refNo}</code></td>
                    <td>
                      <strong>{transaction.itemName}</strong>
                      <small className="cell-subtitle">{transaction.itemCode}</small>
                    </td>
                    <td><span className={movementClass(transaction)}>{transaction.movementType}</span></td>
                    <td className="numeric">
                      {signedQuantity(transaction) > 0 ? "+" : ""}
                      {signedQuantity(transaction).toLocaleString("en-IN")}
                    </td>
                    <td>{transaction.godown}</td>
                  </tr>
                ))}
                {transactions.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty-table">
                      No transactions have been recorded during this app session.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
