import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";

import GroupFilterDropdown, {
  appendFieldLeaves,
  buildGroupTree,
  groupFilterValueFromNode,
  itemMatchesFilter,
  type GroupFilterValue,
} from "./GroupFilterDropdown";
import { operationalStockItems } from "./stock-item-visibility";
import type { ScannerDevice, StoresBox, StoresState } from "./types";
import "./BoxQrCodeCreatorTab.css";

interface Props {
  stores: StoresState;
  onChanged: (state: StoresState) => void;
  scannerUrls: string[];
  canManageScannerPairing: boolean;
}

interface QueueEntry {
  key: string;
  box: StoresBox;
  qrDataUrl: string;
  copies: number;
}

function newBoxId(): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  return `BOX-${stamp}`;
}

function payloadFor(box: StoresBox) {
  return {
    type: "inventory-scanner/box",
    version: 3,
    companyId: box.companyId,
    boxId: box.boxId,
    revision: box.revision,
    items: box.items.map((item) => ({
      tallyItemGuid: item.tallyItemGuid,
      itemName: item.itemName,
    })),
  } as const;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "box-label";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function chunksOf<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default function BoxQrCodeCreatorTab({ stores, onChanged, scannerUrls, canManageScannerPairing }: Props) {
  const [boxId, setBoxId] = useState(() => newBoxId());
  const [expectedRevision, setExpectedRevision] = useState<number | undefined>();
  const [selectedGuids, setSelectedGuids] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<GroupFilterValue>({ path: [], groupDepth: 0 });
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [stockFilter, setStockFilter] = useState<"ALL" | "AVAILABLE" | "EMPTY">("ALL");
  const [bomFilter, setBomFilter] = useState<"ALL" | "BOM" | "NO_BOM">("ALL");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [savedBox, setSavedBox] = useState<StoresBox | null>(null);
  const [copies, setCopies] = useState("1");
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [scannerBusy, setScannerBusy] = useState(false);
  const [selectedScannerUrl, setSelectedScannerUrl] = useState(scannerUrls[0] ?? "");
  const [scannerLabel, setScannerLabel] = useState("Stores phone");
  const [scannerQrUrl, setScannerQrUrl] = useState("");
  const [scannerPairingExpiresAt, setScannerPairingExpiresAt] = useState("");
  const [scannerDevices, setScannerDevices] = useState<ScannerDevice[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const selectableItems = useMemo(
    () => operationalStockItems(stores.stockItems),
    [stores.stockItems],
  );

  const selectedItems = useMemo(
    () => selectedGuids.map((guid) => stores.stockItems.find((item) => item.tallyGuid === guid)).filter(Boolean),
    [selectedGuids, stores.stockItems],
  );
  const groupTree = useMemo(() => appendFieldLeaves(
    buildGroupTree(selectableItems.map((item) => item.groupPath).filter((path) => path.length > 0)),
    selectableItems.map((item) => ({ groupPath: item.groupPath, fieldValues: item.fieldValues, displayName: item.name, itemGuid: item.tallyGuid })),
    stores.itemFieldDefinitions,
  ), [selectableItems, stores.itemFieldDefinitions]);
  const categoryOptions = useMemo(
    () => [...new Set(selectableItems.map((item) => item.categoryName).filter(Boolean))].sort((left, right) => left.localeCompare(right)),
    [selectableItems],
  );
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return selectableItems.filter((item) => {
      if (selectedGuids.includes(item.tallyGuid)) return false;
      if (groupFilter.path.length > 0 && !itemMatchesFilter(
        groupFilter,
        { groupPath: item.groupPath, fieldValues: item.fieldValues, displayName: item.name },
        stores.itemFieldDefinitions,
      )) return false;
      if (categoryFilter !== "ALL" && item.categoryName !== categoryFilter) return false;
      if (stockFilter === "AVAILABLE" && item.localAvailableQuantity <= 0) return false;
      if (stockFilter === "EMPTY" && item.localAvailableQuantity > 0) return false;
      if (bomFilter === "BOM" && !item.hasBom) return false;
      if (bomFilter === "NO_BOM" && item.hasBom) return false;
      return !query || [item.name, ...item.groupPath, item.tallyGuid].some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [bomFilter, groupFilter, categoryFilter, search, selectedGuids, stockFilter, selectableItems, stores.itemFieldDefinitions]);

  useEffect(() => {
    setQrDataUrl("");
    setSavedBox(null);
  }, [boxId, selectedGuids]);

  useEffect(() => {
    const visible = new Set(selectableItems.map((item) => item.tallyGuid));
    setSelectedGuids((current) => {
      const next = current.filter((guid) => visible.has(guid));
      return next.length === current.length ? current : next;
    });
  }, [selectableItems]);

  useEffect(() => {
    if (scannerUrls.length === 0) return;
    setSelectedScannerUrl((current) => scannerUrls.includes(current) ? current : scannerUrls[0]);
  }, [scannerUrls]);

  useEffect(() => {
    if (!canManageScannerPairing) return;
    void window.desktop.scanners.list().then(setScannerDevices).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [canManageScannerPairing]);

  async function createScannerPairing(): Promise<void> {
    if (!selectedScannerUrl) {
      setError("No LAN address is available for scanner pairing.");
      return;
    }
    setScannerBusy(true);
    setError("");
    setNotice("");
    try {
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
      setNotice("Pairing QR created.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setScannerBusy(false);
    }
  }

  async function revokeScanner(device: ScannerDevice): Promise<void> {
    setScannerBusy(true);
    setError("");
    setNotice("");
    try {
      await window.desktop.scanners.revoke(device.id);
      setScannerDevices(await window.desktop.scanners.list());
      setNotice(`${device.label} revoked.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setScannerBusy(false);
    }
  }

  function loadBox(box: StoresBox): void {
    setBoxId(box.boxId);
    setExpectedRevision(box.revision);
    setSelectedGuids(box.items.map((item) => item.tallyItemGuid));
    setSavedBox(box);
    setNotice(`Loaded revision ${box.revision}. Saving changes will create revision ${box.revision + 1}.`);
    setError("");
    void QRCode.toDataURL(JSON.stringify(payloadFor(box)), { width: 760, margin: 2, errorCorrectionLevel: "M" }).then(setQrDataUrl);
  }

  function startNew(): void {
    setBoxId(newBoxId());
    setExpectedRevision(undefined);
    setSelectedGuids([]);
    setSavedBox(null);
    setQrDataUrl("");
    setNotice("Started a new box record.");
    setError("");
  }

  function clearItems(): void {
    setSelectedGuids([]);
    setExpectedRevision(savedBox?.revision);
    setNotice("Cleared all items from the box draft.");
    setError("");
  }

  async function saveBox(): Promise<void> {
    if (!boxId.trim()) {
      setError("Box ID is required.");
      return;
    }
    if (selectedGuids.length < 1 || selectedGuids.length > 5) {
      setError("Choose between one and five distinct Tally Stock Items.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const box = await window.desktop.stores.saveBox({
        boxId: boxId.trim(),
        companyId: stores.companyGuid,
        expectedRevision,
        tallyItemGuids: selectedGuids,
      });
      const dataUrl = await QRCode.toDataURL(JSON.stringify(payloadFor(box)), {
        width: 760,
        margin: 2,
        errorCorrectionLevel: "M",
      });
      setExpectedRevision(box.revision);
      setSavedBox(box);
      setQrDataUrl(dataUrl);
      const next = await window.desktop.stores.getState();
      onChanged(next);
      setNotice(`Saved ${box.boxId} revision ${box.revision}. The server record is authoritative for future scans.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function deleteBox(box: StoresBox): Promise<void> {
    if (!window.confirm(`Delete ${box.boxId}? Existing printed labels will stop resolving from the desktop.`)) return;
    setBusy(true);
    setError("");
    try {
      const next = await window.desktop.stores.deleteBox(box.boxId, box.revision);
      onChanged(next);
      setQueue((current) => current.filter((entry) => entry.box.boxId !== box.boxId));
      if (boxId === box.boxId) startNew();
      setNotice(`${box.boxId} was deleted.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function downloadPng(): void {
    if (!savedBox || !qrDataUrl) return;
    const link = document.createElement("a");
    link.href = qrDataUrl;
    link.download = `${safeFileName(savedBox.boxId)}-r${savedBox.revision}.png`;
    link.click();
  }

  function addToQueue(): void {
    if (!savedBox || !qrDataUrl) {
      setError("Save the box before adding its label to the print queue.");
      return;
    }
    const count = Number(copies);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      setError("Copies must be a whole number between 1 and 100.");
      return;
    }
    const key = `${savedBox.boxId}:${savedBox.revision}`;
    setQueue((current) => {
      const existing = current.find((entry) => entry.key === key);
      return existing
        ? current.map((entry) => entry.key === key ? { ...entry, copies: entry.copies + count } : entry)
        : [...current, { key, box: savedBox, qrDataUrl, copies: count }];
    });
    setNotice(`Added ${count} label${count === 1 ? "" : "s"} to the print queue.`);
  }

  async function printQueue(): Promise<void> {
    if (queue.length === 0 || printing) return;

    const labels = queue.flatMap((entry) =>
      Array.from({ length: entry.copies }, () => entry),
    );
    const pages = chunksOf(labels, 4);
    const labelMarkup = ({ box, qrDataUrl: image }: QueueEntry) => `<article class="label">
      <img src="${image}" alt="QR for ${escapeHtml(box.boxId)}" />
      <div class="items">${box.items.map((item) => `<div>${escapeHtml(item.itemName)}</div>`).join("")}</div>
    </article>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Inventory box labels</title><style>
      @page{size:auto;margin:.2in}*{box-sizing:border-box}html,body{margin:0;padding:0}body{font-family:Arial,sans-serif;color:#111}.sheet{display:grid;grid-template-columns:repeat(2,2in);grid-auto-rows:2in;gap:.12in;justify-content:center;align-content:start;break-after:page;page-break-after:always}.sheet:last-child{break-after:auto;page-break-after:auto}.label{width:2in;height:2in;overflow:hidden;border:1px solid #555;padding:.06in;break-inside:avoid;page-break-inside:avoid;display:flex;flex-direction:column;align-items:center;background:#fff}.label img{display:block;width:1in;height:1in;min-width:1in;min-height:1in;margin:0 auto .04in;image-rendering:pixelated}.items{width:100%;font-size:10pt;font-weight:700;line-height:1.08;text-align:center;overflow:hidden}.items div{margin:0 0 .025in;overflow-wrap:anywhere}
    </style></head><body>${pages.map((page) => `<section class="sheet">${page.map(labelMarkup).join("")}</section>`).join("")}</body></html>`;

    setPrinting(true);
    setError("");
    try {
      const result = await window.desktop.printHtml(html);
      if (!result.success) {
        const reason = result.failureReason || "Printing did not complete.";
        if (reason.toLocaleLowerCase().includes("cancel")) {
          setNotice("Printing was cancelled.");
        } else {
          setError(reason);
        }
        return;
      }
      setNotice("The label print job completed.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPrinting(false);
    }
  }

  return (
    <section className="tab-page">
      <div className="page-heading">
        {/* <div><p className="eyebrow">BOX LABELS</p><h1>QR Code Creator</h1></div> */}
        
      </div>
      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--success">{notice}</div>}

      <div className="box-qr-grid">
        <article className="panel box-qr-catalog-panel">
          <div className="panel__header"><div><p className="eyebrow">STORES CATALOG</p><h2>Select one to five items</h2></div><span className="table-count">{selectedGuids.length}/5 selected</span></div>
          <label className="box-qr-search-field">Search Tally Stock Items<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Item name, group, or GUID" /></label>
          <div className="box-qr-catalog-filters">
            <label>Stock Group<GroupFilterDropdown ariaLabel="Filter by Stock Group" tree={groupTree} value={groupFilter.path} onChange={(path, node) => setGroupFilter(groupFilterValueFromNode(path, node))} /></label>
            <label>Stock Category<select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="ALL">All Stock Categories</option>{categoryOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
            <label>Stock<select value={stockFilter} onChange={(event) => setStockFilter(event.target.value as typeof stockFilter)}><option value="ALL">All stock</option><option value="AVAILABLE">Available only</option><option value="EMPTY">Zero stock</option></select></label>
            <label>Product type<select value={bomFilter} onChange={(event) => setBomFilter(event.target.value as typeof bomFilter)}><option value="ALL">All items</option><option value="BOM">Has BOM</option><option value="NO_BOM">No BOM</option></select></label>
            <button type="button" className="text-button" onClick={() => { setSearch(""); setGroupFilter({ path: [], groupDepth: 0 }); setCategoryFilter("ALL"); setStockFilter("ALL"); setBomFilter("ALL"); }}>Clear filters</button>
          </div>
          <div className="box-qr-catalog-result-count">Showing {filtered.length} of {selectableItems.length} catalog items</div>
          <div className="box-qr-catalog-scroll" tabIndex={0}>
            {filtered.map((item) => (
              <button key={item.tallyGuid} type="button" className="box-qr-catalog-action" disabled={selectedGuids.length >= 5} onClick={() => setSelectedGuids((current) => [...current, item.tallyGuid])}>
                <span><strong>{item.name}</strong><small>{item.groupPath.join(" › ") || "Ungrouped"} · Available {item.localAvailableQuantity}</small></span><b>＋</b>
              </button>
            ))}
            {filtered.length === 0 && <p className="empty-table">No matching synchronized Stock Items.</p>}
          </div>

          <div className="existing-boxes">
            <p className="eyebrow">EDIT AN EXISTING BOX</p>
            <div className="existing-box-list">{stores.boxes.slice(0, 50).map((box) => <div className="existing-box-row" key={box.boxId}><button className="existing-box-load" type="button" onClick={() => loadBox(box)}><strong>{box.boxId}</strong><span>r{box.revision} · {box.items.length} item{box.items.length === 1 ? "" : "s"}</span></button><button className="existing-box-delete" type="button" disabled={busy} onClick={() => void deleteBox(box)} aria-label={`Delete ${box.boxId}`}>Delete</button></div>)}</div>
          </div>
        </article>

        <article className="panel box-qr-builder-panel">
          <div className="panel__header"><div><p className="eyebrow">QR CODE GENERATOR</p><h2>Authoritative box record</h2></div>{savedBox && <span className="health-badge">REVISION {savedBox.revision}</span>}</div>
          <label className="path-field">Box ID<input value={boxId} onChange={(event) => setBoxId(event.target.value)} /></label>
          <div className="box-qr-selected-list">
            {selectedItems.map((item, index) => item && (
              <div key={item.tallyGuid} className="box-qr-selected-item"><span className="box-qr-index">{index + 1}</span><div><strong>{item.name}</strong><small>{item.tallyGuid}</small></div><button type="button" aria-label={`Remove ${item.name}`} onClick={() => setSelectedGuids((current) => current.filter((guid) => guid !== item.tallyGuid))}>×</button></div>
            ))}
            {selectedItems.length === 0 && <p className="muted">Choose at least one Tally Stock Item.</p>}
          </div>
          <button className="button box-qr-save" type="button" onClick={() => void saveBox()} disabled={busy}>{busy ? "Saving…" : "Save box and generate QR"}</button>
          <button className="button box-qr-save" type="button" onClick={startNew}>New box</button>
          <div className="box-qr-preview">{qrDataUrl && savedBox ? <div className="box-label-preview"><img src={qrDataUrl} alt={`QR for ${savedBox.boxId}`} /><div className="box-label-preview__items">{savedBox.items.map((item) => <strong key={item.tallyItemGuid}>{item.itemName}</strong>)}</div></div> : <div className="qr-placeholder">Save the box to generate its version-3 QR.</div>}</div>
          <div className="box-qr-actions"><button className="button button--secondary" type="button" onClick={downloadPng} disabled={!qrDataUrl}>Download PNG</button>
          <button className="button button--ghost" type="button" onClick={clearItems} disabled={selectedGuids.length === 0}>Clear</button>
          <label>Copies<input type="number" min="1" max="100" value={copies} onChange={(event) => setCopies(event.target.value)} /></label>
          <button className="button" type="button" onClick={addToQueue} disabled={!qrDataUrl}>Add to print queue</button></div>
        </article>
      </div>

      {canManageScannerPairing && <article className="panel stores-scanner-panel">
        <div className="panel__header"><div><p className="eyebrow">PHONE CONNECTION</p><h2>Pair a phone</h2></div></div>
        <div className="scanner-settings">
          <div className="scanner-qr-card">{scannerQrUrl ? <img src={scannerQrUrl} alt="One-time phone scanner pairing QR" /> : <span>Create a one-time pairing QR</span>}</div>
          <div className="scanner-address-controls">
            <label>Desktop API address<select value={selectedScannerUrl} onChange={(event) => setSelectedScannerUrl(event.target.value)}>{scannerUrls.map((url) => <option key={url}>{url}</option>)}</select></label>
            <label>Scanner name<input value={scannerLabel} onChange={(event) => setScannerLabel(event.target.value)} placeholder="e.g. Stores phone 1" /></label>
            <button className="button button--secondary" type="button" onClick={() => void createScannerPairing()} disabled={scannerBusy || !selectedScannerUrl || !scannerLabel.trim()}>Create pairing QR</button>
          </div>
        </div>
        <p className="table-footnote">{scannerPairingExpiresAt ? `This one-time QR expires ${formatDate(scannerPairingExpiresAt)}.` : "Each QR can pair one scanner and expires after 10 minutes. A paired scanner receives its own revocable audit identity."}</p>
        <div className="table-scroll"><table><thead><tr><th>Scanner</th><th>Last seen</th><th>Status</th><th /></tr></thead><tbody>
          {scannerDevices.map((device) => <tr key={device.id}><td>{device.label}</td><td>{formatDate(device.lastSeenAt)}</td><td>{device.revokedAt ? "Revoked" : "Active"}</td><td>{!device.revokedAt && <button className="button button--ghost button--small" type="button" disabled={scannerBusy} onClick={() => void revokeScanner(device)}>Revoke</button>}</td></tr>)}
          {scannerDevices.length === 0 && <tr><td colSpan={4} className="empty-table">No paired scanners yet.</td></tr>}
        </tbody></table></div>
        <div className="read-only-note"><strong>LAN boundary:</strong> the API listens on the selected company LAN, but scanner inventory routes require a paired device token.</div>
      </article>}

      <article className="panel">
        <div className="panel__header"><div><p className="eyebrow">PRINT QUEUE</p><h2>Box labels</h2></div><button className="button" type="button" onClick={() => void printQueue()} disabled={queue.length === 0 || printing}>{printing ? "Opening print dialog…" : "Print labels"}</button></div>
        <div className="queue-list">{queue.map((entry) => <div key={entry.key}><strong>{entry.box.boxId}</strong><span>r{entry.box.revision} · {entry.box.items.map((item) => item.itemName).join(", ")}</span><b>{entry.copies} copies</b><button type="button" onClick={() => setQueue((current) => current.filter((candidate) => candidate.key !== entry.key))}>Remove</button></div>)}{queue.length === 0 && <p className="muted">The queue is empty.</p>}</div>
      </article>
    </section>
  );
}
