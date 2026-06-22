import { useEffect, useMemo, useState } from "react";

import type {
  OperationsState,
  GeneratedExportFile,
  StoresState,
  TallyCompany,
  TallyConnectionSettings,
} from "./types";

interface Props {
  stores: StoresState;
  operations?: OperationsState | null;
  localFiles?: boolean;
  onChanged: (state: StoresState) => void;
  onOperationsChanged?: () => Promise<void>;
}

const DEFAULT_SETTINGS: TallyConnectionSettings = {
  host: "accounts",
  port: 9000,
  company: "",
  timeoutMs: 15_000,
  historyFrom: "2000-01-01",
  fullVoucherHistory: true,
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

export default function TallyTab({ stores, operations, localFiles = true, onChanged, onOperationsChanged }: Props) {
  const [settings, setSettings] = useState<TallyConnectionSettings>(DEFAULT_SETTINGS);
  const [companies, setCompanies] = useState<TallyCompany[]>([]);
  const [reviewer, setReviewer] = useState("");
  const [includeCsv, setIncludeCsv] = useState(true);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<"test" | "sync" | "export" | "masters" | "review" | "">("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [generatedFiles, setGeneratedFiles] = useState<GeneratedExportFile[]>([]);

  async function refreshGeneratedFiles(): Promise<void> {
    setGeneratedFiles(await window.desktop.stores.listGeneratedFiles());
  }

  useEffect(() => {
    void window.desktop.tally.getState().then((state) => {
      setSettings(state.settings);
      setCompanies(state.cache?.companies ?? []);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    void refreshGeneratedFiles().catch(() => undefined);
  }, []);

  const filteredLots = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return stores.purchaseLots.filter((lot) => !query || [lot.itemName, lot.supplierName, lot.grnNumber, lot.poNumber].some((value) => value.toLocaleLowerCase().includes(query)));
  }, [search, stores.purchaseLots]);

  function update<Key extends keyof TallyConnectionSettings>(key: Key, value: TallyConnectionSettings[Key]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function testConnection(): Promise<void> {
    setBusy("test"); setError(""); setNotice("");
    try {
      const result = await window.desktop.tally.testConnection(settings);
      setSettings(result.settings);
      setCompanies(result.companies);
      setNotice(result.warning ?? `Connected to ${result.endpoint} in ${result.latencyMs} ms.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  }

  async function sync(): Promise<void> {
    setBusy("sync"); setError(""); setNotice("");
    try {
      const result = await window.desktop.tally.syncStores(settings);
      onChanged(result.state);
      setCompanies(result.snapshot.companies);
      setSettings((current) => ({ ...current, company: result.snapshot.company }));
      setNotice(result.state.dataMode === "demo"
        ? "Tally returned no Stock Items. The built-in demo catalog remains active."
        : `Imported ${result.summary.stockItemsImported} Stock Items, ${result.summary.suppliersImported} suppliers, ${result.summary.openPurchaseOrdersImported} open POs, and ${result.summary.historicalGrnsImported} new historical GRNs after scanning ${result.summary.historicalVouchersScanned} vouchers.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  }

  async function decide(entryId: string, status: "APPROVED" | "REJECTED" | "NEEDS_CORRECTION"): Promise<void> {
    if (!reviewer.trim()) { setError("Enter the Chief of Staff / reviewer name before reviewing entries."); return; }
    setBusy("review"); setError(""); setNotice("");
    try {
      const next = await window.desktop.stores.review({ entryId, status, reviewedBy: reviewer.trim() });
      onChanged(next);
      setNotice(`Entry marked ${status.replaceAll("_", " ").toLowerCase()}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  }

  async function confirmImported(entryId: string, currentReference: string): Promise<void> {
    if (!reviewer.trim()) {
      setError("Enter the Chief of Staff / recorder name before confirming a Tally import.");
      return;
    }
    const tallyVoucherNumber = window.prompt(
      "Enter the Tally voucher number or import reference:",
      currentReference,
    );
    if (tallyVoucherNumber === null) return;
    if (!tallyVoucherNumber.trim()) {
      setError("A Tally voucher number or import reference is required.");
      return;
    }
    setBusy("review"); setError(""); setNotice("");
    try {
      const next = await window.desktop.stores.confirmImport({
        entryId,
        tallyVoucherNumber: tallyVoucherNumber.trim(),
        recordedBy: reviewer.trim(),
      });
      onChanged(next);
      setNotice(`Import confirmed as ${tallyVoucherNumber.trim()}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }


  async function completeManualReview(reviewId: string, currentReference: string): Promise<void> {
    const tallyVoucherReference = window.prompt(
      "Enter the Tally voucher number or manual-processing reference:",
      currentReference,
    );
    if (tallyVoucherReference === null) return;
    if (!tallyVoucherReference.trim()) {
      setError("A Tally voucher number or manual-processing reference is required.");
      return;
    }
    setBusy("review"); setError(""); setNotice("");
    try {
      await window.desktop.operations.reviewManualTally({
        reviewId,
        status: "PROCESSED",
        tallyVoucherReference: tallyVoucherReference.trim(),
      });
      await onOperationsChanged?.();
      setNotice(`Manual Tally review recorded as ${tallyVoucherReference.trim()}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy("");
    }
  }

  async function generateAllExports(): Promise<void> {
    setBusy("export"); setError(""); setNotice("");
    try {
      const result = await window.desktop.stores.exportBatch({ reviewedBy: reviewer.trim(), includeCsv });
      const masters = await window.desktop.stores.exportCatalogCleanup();
      const next = await window.desktop.stores.getState();
      onChanged(next);
      await refreshGeneratedFiles();
      setNotice(`Generated the complete Tally file set: Material In, Material Out, voucher review, master/catalog, products, active BOMs, reorder levels, suppliers, open Purchase Orders${result.csvPath ? ", CSV" : ""}, and XML.${[...result.warnings, ...masters.warnings].length ? ` ${[...result.warnings, ...masters.warnings].join(" ")}` : ""}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(""); }
  }

  async function downloadFile(file: GeneratedExportFile): Promise<void> {
    setError(""); setNotice("");
    try {
      const saved = await window.desktop.stores.downloadGeneratedFile(file.path);
      if (saved) setNotice(`Downloaded ${file.name}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  const counts = stores.reviewEntries.reduce<Record<string, number>>((result, entry) => {
    result[entry.status] = (result[entry.status] ?? 0) + 1;
    return result;
  }, {});

  return (
    <section className="tab-page">
      <div className="page-heading">
        <div><p className="eyebrow">READ FROM TALLY · EXPORT EVERYTHING TALLY-READY</p><h1>Tally Syncer</h1><p>Catalog reads, voucher review, Material In/Out, Stock Items, name changes, duplicate review, products, and active BOM definitions are managed here. Files are generated for review and import; the app does not post directly into Tally.</p></div>
        {localFiles && <button className="button button--secondary" type="button" onClick={() => void window.desktop.stores.openPath(stores.database.exportFolder)}>Open export folder</button>}
      </div>
      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--success">{notice}</div>}

      <div className="tally-grid">
        <article className="panel tally-connection-panel">
          <div className="panel__header"><div><p className="eyebrow">TALLYPRIME GOLD 7.0 · ACCOUNTS COMPUTER</p><h2>LAN read-only connection</h2></div><span className="health-badge">EXPORT REQUESTS ONLY</span></div>
          <div className="settings-form-grid">
            <label>Accounts computer<input value={settings.host} onChange={(event) => update("host", event.target.value)} placeholder="accounts or 192.168.1.25" /></label>
            <label>Port<input type="number" min="1" max="65535" value={settings.port} onChange={(event) => update("port", Number(event.target.value))} /></label>
            <label>History from<input type="date" value={settings.historyFrom} onChange={(event) => update("historyFrom", event.target.value)} /></label>
            <label>Timeout<select value={settings.timeoutMs} onChange={(event) => update("timeoutMs", Number(event.target.value))}><option value={5000}>5 seconds</option><option value={15000}>15 seconds</option><option value={30000}>30 seconds</option><option value={60000}>60 seconds</option></select></label>
            <label className="field--wide">Company{companies.length ? <select value={settings.company} onChange={(event) => update("company", event.target.value)}><option value="">Choose a loaded company</option>{companies.map((company) => <option key={company.guid || company.name} value={company.name}>{company.name}</option>)}</select> : <input value={settings.company} onChange={(event) => update("company", event.target.value)} placeholder="Test connection to load companies" />}</label>
            <label className="field--wide tally-history-toggle"><input type="checkbox" checked={settings.fullVoucherHistory} onChange={(event) => update("fullVoucherHistory", event.target.checked)} /><span><strong>Complete voucher-history scan</strong><small>Read vouchers in one-year chunks, detect custom Receipt Note/GRN voucher types through their Tally voucher-type hierarchy, and retain only stores-relevant records.</small></span></label>
          </div>
          <div className="settings-actions"><button className="button button--secondary" disabled={Boolean(busy)} type="button" onClick={() => void testConnection()}>{busy === "test" ? "Testing…" : "Test connection"}</button><button className="button" disabled={Boolean(busy) || !settings.company} type="button" onClick={() => void sync()}>{busy === "sync" ? "Reading complete history…" : "Sync Stores Catalog and history"}</button></div>
          <div className="read-only-note"><strong>Company deployment:</strong> this app and its database run on the Production computer. Tally remains open on the Accounts computer and exposes its XML server on this address and port.</div>
          <div className="read-only-note"><strong>Cutover behavior:</strong> the first successful historical sync reconstructs current supplier lots from GRNs and assigns any unmatched current quantity to Opening Legacy Stock. The complete scan reads historical vouchers transiently, but only Stock Items, suppliers, POs, Receipt Notes/GRNs, BOMs, and rate-supporting Purchase records are persisted.</div>
        </article>

        <article className="panel tally-status-panel">
          <div className="panel__header"><div><p className="eyebrow">SYNC SUMMARY</p><h2>{stores.companyName || "No company synchronized"}</h2></div></div>
          <dl className="settings-details tally-details">
            <div><dt>Last sync</dt><dd>{formatDate(stores.sync.syncedAt)}</dd></div><div><dt>Stock Items</dt><dd>{stores.sync.stockItemsImported}</dd></div><div><dt>Suppliers</dt><dd>{stores.sync.suppliersImported}</dd></div><div><dt>Open POs</dt><dd>{stores.sync.openPurchaseOrdersImported}</dd></div><div><dt>Vouchers scanned</dt><dd>{stores.sync.historicalVouchersScanned}</dd></div><div><dt>Inventory vouchers</dt><dd>{stores.sync.inventoryVouchersScanned}</dd></div><div><dt>Receipt Notes detected</dt><dd>{stores.sync.receiptNotesDetected}</dd></div><div><dt>New historical GRNs</dt><dd>{stores.sync.historicalGrnsImported}</dd></div><div><dt>Purchase lots</dt><dd>{stores.sync.purchaseLotsReconstructed}</dd></div><div><dt>Opening Legacy items</dt><dd>{stores.sync.openingLegacyItems}</dd></div>
            <div><dt>GRN voucher types</dt><dd>{stores.sync.receiptNoteTypeNames.join(", ") || "None detected"}</dd></div>
          </dl>
          {stores.sync.warnings.length > 0 && <ul className="warning-list">{stores.sync.warnings.slice(0, 12).map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        </article>
      </div>

      <section className="stats-grid tally-stats">
        <article className="stat-card"><span className="stat-card__icon">▦</span><div><small>Pending GRNs</small><strong>{stores.reviewEntries.filter((entry) => entry.entityType === "GRN" && entry.status === "PENDING").length}</strong><span>awaiting review</span></div></article>
        <article className="stat-card"><span className="stat-card__icon">⇢</span><div><small>Pending Material Out</small><strong>{stores.reviewEntries.filter((entry) => entry.entityType === "MATERIAL_OUT" && entry.status === "PENDING").length}</strong><span>daily item + destination groups</span></div></article>
        <article className="stat-card"><span className="stat-card__icon">⚠</span><div><small>Exceptions</small><strong>{counts.EXCEPTION ?? 0}</strong><span>requires decision</span></div></article>
        <article className="stat-card"><span className="stat-card__icon">✓</span><div><small>Approved</small><strong>{counts.APPROVED ?? 0}</strong><span>ready for generation</span></div></article>
      </section>

      <article className="panel">
        <div className="panel__header">
          <div><p className="eyebrow">TALLY IMPORT FILES</p><h2>Generated file library</h2></div>
          <button className="button" type="button" disabled={Boolean(busy)} onClick={() => void generateAllExports()}>{busy === "export" ? "Generating…" : "Generate"}</button>
        </div>
        <p className="table-footnote">Generate creates every available Tally-oriented workbook and XML file. Use the download icon to choose where to save a copy.</p>
        <div className="table-scroll"><table><thead><tr><th>File</th><th>Type</th><th>Generated</th><th>Size</th><th /></tr></thead><tbody>
          {generatedFiles.map((file) => <tr key={file.path}><td><strong>{file.name}</strong></td><td>{file.extension.toUpperCase()}</td><td>{formatDate(file.modifiedAt)}</td><td>{formatBytes(file.sizeBytes)}</td><td className="table-actions">{localFiles ? <button className="button button--ghost button--small" type="button" title={`Download ${file.name}`} aria-label={`Download ${file.name}`} onClick={() => void downloadFile(file)}>⇩</button> : <small>On Production</small>}</td></tr>)}
          {generatedFiles.length === 0 && <tr><td colSpan={5} className="empty-table">No generated files yet. Select Generate to create the complete Tally file set.</td></tr>}
        </tbody></table></div>
      </article>

      <article className="panel table-panel">
        <div className="panel__header export-review-heading"><div><p className="eyebrow">END-OF-DAY REVIEW</p><h2>Tally Export Queue</h2></div><div className="review-controls"><input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="Reviewer name for decisions" /><label><input type="checkbox" checked={includeCsv} onChange={(event) => setIncludeCsv(event.target.checked)} /> Include CSV when generated</label></div></div>
        <div className="table-scroll stores-review-table"><table><thead><tr><th>Type</th><th>Date</th><th>Proposed voucher</th><th>Qty</th><th>FIFO / validation</th><th>Status</th><th>Review</th></tr></thead><tbody>
          {stores.reviewEntries.map((entry) => <tr key={entry.id}><td>{entry.entityType.replaceAll("_", " ")}</td><td>{entry.eventDate}</td><td><strong>{entry.title}</strong>{entry.supplierName && <small className="table-subtext">{entry.supplierName} · PO {entry.poNumber || "exception"} · Challan {entry.challanNumber || "—"}</small>}</td><td>{entry.quantity}</td><td>{entry.fifoSummary || entry.validationMessages.join("; ") || "Ready for review"}</td><td><span className={`review-status review-status--${entry.status.toLowerCase().replaceAll("_", "-")}`}>{entry.status}</span>{entry.tallyVoucherNumber && <small className="table-subtext">Tally {entry.tallyVoucherNumber}</small>}</td><td><div className="row-actions">{entry.status === "EXPORTED" ? <button type="button" onClick={() => void confirmImported(entry.id, entry.tallyVoucherNumber)} disabled={Boolean(busy)}>Confirm import</button> : <><button type="button" onClick={() => void decide(entry.id, "APPROVED")} disabled={Boolean(busy) || ["CONFIRMED"].includes(entry.status)}>Approve</button><button type="button" onClick={() => void decide(entry.id, "NEEDS_CORRECTION")} disabled={Boolean(busy) || ["CONFIRMED"].includes(entry.status)}>Correct</button><button type="button" onClick={() => void decide(entry.id, "REJECTED")} disabled={Boolean(busy) || ["CONFIRMED"].includes(entry.status)}>Reject</button></>}</div></td></tr>)}
          {stores.reviewEntries.length === 0 && <tr><td colSpan={7} className="empty-table">No proposed vouchers yet.</td></tr>}
        </tbody></table></div>
        <p className="table-footnote"><strong>Material Out:</strong> the export now includes both the import-ready Excel format and a generic Outward Material XML format. Supplier rejections entered during Material In are emitted as separate Material Out rejection vouchers.</p>
      </article>


      {operations && <article className="panel table-panel">
        <div className="panel__header"><div><p className="eyebrow">NEW INVENTORY MOVEMENTS</p><h2>Manual Tally Review</h2></div><span className="table-count">{operations.manualTallyReviews.filter((entry) => entry.status !== "PROCESSED").length} open</span></div>
        <div className="table-scroll"><table><thead><tr><th>Date</th><th>Movement</th><th>Item</th><th>Qty</th><th>Reason</th><th>Status</th><th>Tally reference</th><th>Action</th></tr></thead><tbody>
          {operations.manualTallyReviews.map((entry) => <tr key={entry.id}><td>{entry.eventDate}</td><td>{entry.movementType.replaceAll("_", " ")}</td><td>{entry.itemName}</td><td>{entry.quantity}</td><td>{entry.reviewReason}</td><td><span className={`review-status review-status--${entry.status.toLocaleLowerCase()}`}>{entry.status}</span></td><td>{entry.tallyVoucherReference || "—"}</td><td>{entry.status !== "PROCESSED" ? <button type="button" disabled={Boolean(busy)} onClick={() => void completeManualReview(entry.id, entry.tallyVoucherReference)}>Record manual processing</button> : "Complete"}</td></tr>)}
          {operations.manualTallyReviews.length === 0 && <tr><td colSpan={8} className="empty-table">No condition, adjustment, return, scrap, production, or reversal movements require manual Tally review.</td></tr>}
        </tbody></table></div>
        <p className="table-footnote">These movements retain their source details and remain separate until Accounts records the correct Tally voucher or manual-processing reference.</p>
      </article>}

      <article className="panel table-panel">
        <div className="panel__header"><div><p className="eyebrow">PURCHASE LOT / FIFO VIEWER</p><h2>Current supplier-attributed stock</h2></div><input className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search item, supplier, PO, or GRN" /></div>
        <div className="table-scroll tally-secondary-scroll"><table><thead><tr><th>Item</th><th>Supplier</th><th>Source</th><th>Receipt date</th><th>PO / GRN</th><th className="numeric">Received</th><th className="numeric">Remaining</th></tr></thead><tbody>{filteredLots.slice(0, 1000).map((lot) => <tr key={lot.id}><td>{lot.itemName}</td><td>{lot.supplierName}</td><td>{lot.sourceType}{lot.legacyWarning ? " ⚠" : ""}</td><td>{lot.receiptDate}</td><td>{[lot.poNumber, lot.grnNumber].filter(Boolean).join(" / ") || "—"}</td><td className="numeric">{lot.quantityReceived}</td><td className="numeric">{lot.quantityRemaining}</td></tr>)}{filteredLots.length === 0 && <tr><td colSpan={7} className="empty-table">No available purchase lots.</td></tr>}</tbody></table></div>
      </article>
    </section>
  );
}
