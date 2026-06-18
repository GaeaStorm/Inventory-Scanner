import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";

import type { StoresBox, StoresState } from "./types";
import "./BoxQrCodeCreatorTab.css";

interface Props {
  stores: StoresState;
  onChanged: (state: StoresState) => void;
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

export default function BoxQrCodeCreatorTab({ stores, onChanged }: Props) {
  const [boxId, setBoxId] = useState(() => newBoxId());
  const [expectedRevision, setExpectedRevision] = useState<number | undefined>();
  const [selectedGuids, setSelectedGuids] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("ALL");
  const [stockFilter, setStockFilter] = useState<"ALL" | "AVAILABLE" | "EMPTY">("ALL");
  const [bomFilter, setBomFilter] = useState<"ALL" | "BOM" | "NO_BOM">("ALL");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [savedBox, setSavedBox] = useState<StoresBox | null>(null);
  const [copies, setCopies] = useState("1");
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const selectedItems = useMemo(
    () => selectedGuids.map((guid) => stores.stockItems.find((item) => item.tallyGuid === guid)).filter(Boolean),
    [selectedGuids, stores.stockItems],
  );
  const groupOptions = useMemo(
    () => [...new Set(stores.stockItems.map((item) => item.parentName || "Ungrouped"))].sort((left, right) => left.localeCompare(right)),
    [stores.stockItems],
  );
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return stores.stockItems.filter((item) => {
      if (selectedGuids.includes(item.tallyGuid)) return false;
      if (groupFilter !== "ALL" && (item.parentName || "Ungrouped") !== groupFilter) return false;
      if (stockFilter === "AVAILABLE" && item.localAvailableQuantity <= 0) return false;
      if (stockFilter === "EMPTY" && item.localAvailableQuantity > 0) return false;
      if (bomFilter === "BOM" && !item.hasBom) return false;
      if (bomFilter === "NO_BOM" && item.hasBom) return false;
      return !query || [item.name, item.parentName, item.tallyGuid].some((value) => value.toLocaleLowerCase().includes(query));
    });
  }, [bomFilter, groupFilter, search, selectedGuids, stockFilter, stores.stockItems]);

  useEffect(() => {
    setQrDataUrl("");
    setSavedBox(null);
  }, [boxId, selectedGuids]);

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

  function printQueue(): void {
    if (queue.length === 0) return;
    const printWindow = window.open("", "_blank", "width=1100,height=800");
    if (!printWindow) {
      setError("The print window was blocked.");
      return;
    }
    const labels = queue.flatMap((entry) => Array.from({ length: entry.copies }, () => entry));
    const pages = chunksOf(labels, 4);
    const labelMarkup = ({ box, qrDataUrl: image }: QueueEntry) => `<article class="label">
      <div class="label-header"><strong>${escapeHtml(box.boxId)}</strong><span>r${box.revision}</span></div>
      <img src="${image}" alt="QR for ${escapeHtml(box.boxId)}" />
      <div class="company">${escapeHtml(stores.companyName || "Tally company")}</div>
      <ol class="items">${box.items.map((item) => `<li>${escapeHtml(item.itemName)}</li>`).join("")}</ol>
    </article>`;
    printWindow.document.write(`<!doctype html><html><head><title>Inventory box labels</title><style>
      @page{size:auto;margin:.25in}*{box-sizing:border-box}html,body{margin:0;padding:0}body{font-family:Arial,sans-serif;color:#111}.sheet{display:grid;grid-template-columns:repeat(2,3.75in);grid-auto-rows:4in;gap:.15in;justify-content:center;align-content:start;break-after:page;page-break-after:always}.sheet:last-child{break-after:auto;page-break-after:auto}.label{width:3.75in;height:4in;overflow:hidden;border:1px solid #777;border-radius:.08in;padding:.1in .14in;break-inside:avoid;page-break-inside:avoid;display:flex;flex-direction:column;align-items:center;background:#fff}.label-header{width:100%;display:flex;justify-content:space-between;gap:.1in;align-items:center;font-size:10pt;line-height:1.1}.label-header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.label-header span{font-size:8pt;color:#444;flex:0 0 auto}.label img{display:block;width:2in;height:2in;min-width:2in;min-height:2in;margin:.04in auto .03in;image-rendering:pixelated}.company{width:100%;font-size:7.5pt;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#444}.items{width:100%;margin:.04in 0 0;padding-left:.22in;font-size:8.5pt;line-height:1.12;overflow:hidden}.items li{margin:0 0 .025in;overflow-wrap:anywhere}.items li::marker{font-size:7pt}@media screen{body{padding:.25in;background:#eee}.sheet{margin:0 auto .25in;background:#fff;box-shadow:0 2px 14px #999}}
    </style></head><body>${pages.map((page) => `<section class="sheet">${page.map(labelMarkup).join("")}</section>`).join("")}<script>window.onload=()=>window.print()</script></body></html>`);
    printWindow.document.close();
  }

  return (
    <section className="tab-page">
      <div className="page-heading">
        <div><p className="eyebrow">SQLITE BOX RECORDS</p><h1>QR Code Creator</h1><p>Create or revise a box containing up to five Tally Stock Items. Supplier, PO, GRN, godown, batch, rate, and FIFO data are never encoded in the label.</p></div>
        <button className="button button--secondary" type="button" onClick={startNew}>New box</button>
      </div>
      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--success">{notice}</div>}

      <div className="box-qr-grid">
        <article className="panel box-qr-catalog-panel">
          <div className="panel__header"><div><p className="eyebrow">STORES CATALOG</p><h2>Select one to five items</h2></div><span className="table-count">{selectedGuids.length}/5 selected</span></div>
          <label className="box-qr-search-field">Search Tally Stock Items<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Item name, group, or GUID" /></label>
          <div className="box-qr-catalog-filters">
            <label>Group<select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}><option value="ALL">All groups</option>{groupOptions.map((group) => <option key={group} value={group}>{group}</option>)}</select></label>
            <label>Stock<select value={stockFilter} onChange={(event) => setStockFilter(event.target.value as typeof stockFilter)}><option value="ALL">All stock</option><option value="AVAILABLE">Available only</option><option value="EMPTY">Zero stock</option></select></label>
            <label>Product type<select value={bomFilter} onChange={(event) => setBomFilter(event.target.value as typeof bomFilter)}><option value="ALL">All items</option><option value="BOM">Has BOM</option><option value="NO_BOM">No BOM</option></select></label>
            <button type="button" className="text-button" onClick={() => { setSearch(""); setGroupFilter("ALL"); setStockFilter("ALL"); setBomFilter("ALL"); }}>Clear filters</button>
          </div>
          <div className="box-qr-catalog-result-count">Showing {filtered.length} of {stores.stockItems.length} catalog items</div>
          <div className="box-qr-catalog-scroll" tabIndex={0}>
            {filtered.map((item) => (
              <button key={item.tallyGuid} type="button" className="box-qr-catalog-action" disabled={selectedGuids.length >= 5} onClick={() => setSelectedGuids((current) => [...current, item.tallyGuid])}>
                <span><strong>{item.name}</strong><small>{item.parentName || "Ungrouped"} · Available {item.localAvailableQuantity}</small></span><b>＋</b>
              </button>
            ))}
            {filtered.length === 0 && <p className="empty-table">No matching synchronized Stock Items.</p>}
          </div>

          <div className="existing-boxes">
            <p className="eyebrow">EDIT AN EXISTING BOX</p>
            <div className="existing-box-list">{stores.boxes.slice(0, 20).map((box) => <button key={box.boxId} type="button" onClick={() => loadBox(box)}><strong>{box.boxId}</strong><span>r{box.revision} · {box.items.length} item{box.items.length === 1 ? "" : "s"}</span></button>)}</div>
          </div>
        </article>

        <article className="panel box-qr-builder-panel">
          <div className="panel__header"><div><p className="eyebrow">BOX LABEL</p><h2>Authoritative box record</h2></div>{savedBox && <span className="health-badge">REVISION {savedBox.revision}</span>}</div>
          <label className="path-field">Box ID<input value={boxId} onChange={(event) => setBoxId(event.target.value)} /></label>
          <div className="box-qr-selected-list">
            {selectedItems.map((item, index) => item && (
              <div key={item.tallyGuid} className="box-qr-selected-item"><span className="box-qr-index">{index + 1}</span><div><strong>{item.name}</strong><small>{item.tallyGuid}</small></div><button type="button" aria-label={`Remove ${item.name}`} onClick={() => setSelectedGuids((current) => current.filter((guid) => guid !== item.tallyGuid))}>×</button></div>
            ))}
            {selectedItems.length === 0 && <p className="muted">Choose at least one Tally Stock Item.</p>}
          </div>
          <button className="button box-qr-save" type="button" onClick={() => void saveBox()} disabled={busy}>{busy ? "Saving…" : "Save box and generate QR"}</button>
          <div className="box-qr-preview">{qrDataUrl && savedBox ? <div className="box-label-preview"><div className="box-label-preview__header"><strong>{savedBox.boxId}</strong><span>r{savedBox.revision}</span></div><img src={qrDataUrl} alt={`QR for ${savedBox.boxId}`} /><small>{stores.companyName || "Tally company"}</small><ol>{savedBox.items.map((item) => <li key={item.tallyItemGuid}>{item.itemName}</li>)}</ol></div> : <div className="qr-placeholder">Save the box to generate its version-3 QR.</div>}</div>
          <div className="box-qr-actions"><button className="button button--secondary" type="button" onClick={downloadPng} disabled={!qrDataUrl}>Download PNG</button><label>Copies<input type="number" min="1" max="100" value={copies} onChange={(event) => setCopies(event.target.value)} /></label><button className="button" type="button" onClick={addToQueue} disabled={!qrDataUrl}>Add to print queue</button></div>
        </article>
      </div>

      <article className="panel">
        <div className="panel__header"><div><p className="eyebrow">PRINT QUEUE</p><h2>Box labels</h2></div><button className="button" type="button" onClick={printQueue} disabled={queue.length === 0}>Print labels</button></div>
        <div className="queue-list">{queue.map((entry) => <div key={entry.key}><strong>{entry.box.boxId}</strong><span>r{entry.box.revision} · {entry.box.items.map((item) => item.itemName).join(", ")}</span><b>{entry.copies} copies</b><button type="button" onClick={() => setQueue((current) => current.filter((candidate) => candidate.key !== entry.key))}>Remove</button></div>)}{queue.length === 0 && <p className="muted">The queue is empty.</p>}</div>
      </article>
    </section>
  );
}
