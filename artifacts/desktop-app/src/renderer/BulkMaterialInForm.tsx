import { useMemo, useState } from "react";

import type { StoresState } from "./types";

interface Props {
  stores: StoresState;
  onChanged: (state: StoresState) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

interface ReceiptRow {
  tallyItemGuid: string;
  quantity: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyRow(): ReceiptRow {
  return { tallyItemGuid: "", quantity: "" };
}

export default function BulkMaterialInForm({ stores, onChanged, onNotice, onError }: Props) {
  const [supplierId, setSupplierId] = useState("");
  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [challanNumber, setChallanNumber] = useState("");
  const [challanDate, setChallanDate] = useState(today());
  const [receiptDate, setReceiptDate] = useState(today());
  const [nonPoException, setNonPoException] = useState(false);
  const [rows, setRows] = useState<ReceiptRow[]>([emptyRow()]);
  const [busy, setBusy] = useState(false);

  const selectedSupplierId = Number(supplierId) || null;
  const selectedPo = useMemo(
    () => stores.purchaseOrders.find((order) => order.id === Number(purchaseOrderId)) ?? null,
    [purchaseOrderId, stores.purchaseOrders],
  );
  const supplierOrders = useMemo(
    () => stores.purchaseOrders.filter((order) => selectedSupplierId === null || order.supplierId === selectedSupplierId),
    [selectedSupplierId, stores.purchaseOrders],
  );
  const allowedItems = selectedPo
    ? selectedPo.lines.filter((line) => line.outstandingQuantity > 0)
    : stores.stockItems.map((item) => ({
        tallyItemGuid: item.tallyGuid,
        itemName: item.name,
        orderedQuantity: 0,
        receivedQuantity: 0,
        outstandingQuantity: 0,
        rate: null,
      }));
  const totalQuantity = rows.reduce((sum, row) => {
    const quantity = Number(row.quantity);
    return sum + (Number.isInteger(quantity) && quantity > 0 ? quantity : 0);
  }, 0);

  function clearForm(): void {
    setSupplierId("");
    setPurchaseOrderId("");
    setChallanNumber("");
    setChallanDate(today());
    setReceiptDate(today());
    setNonPoException(false);
    setRows([emptyRow()]);
    onError("");
    onNotice("");
  }

  function chooseSupplier(value: string): void {
    setSupplierId(value);
    setPurchaseOrderId("");
    setRows([emptyRow()]);
  }

  function choosePurchaseOrder(value: string): void {
    setPurchaseOrderId(value);
    const order = stores.purchaseOrders.find((candidate) => candidate.id === Number(value));
    if (!order) {
      setRows([emptyRow()]);
      return;
    }
    if (order.supplierId) setSupplierId(String(order.supplierId));
    setNonPoException(false);
    setRows(
      order.lines
        .filter((line) => line.outstandingQuantity > 0)
        .map((line) => ({ tallyItemGuid: line.tallyItemGuid, quantity: "" })),
    );
  }

  function updateRow(index: number, patch: Partial<ReceiptRow>): void {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  async function submit(): Promise<void> {
    onError("");
    onNotice("");
    if (!selectedSupplierId) {
      onError("Select the supplier that delivered the material.");
      return;
    }
    if (!challanNumber.trim()) {
      onError("Enter the supplier challan number.");
      return;
    }
    const lines = rows
      .filter((row) => row.tallyItemGuid && row.quantity.trim())
      .map((row) => ({ tallyItemGuid: row.tallyItemGuid, quantity: Number(row.quantity) }));
    if (lines.length === 0) {
      onError("Enter a received quantity for at least one Stock Item.");
      return;
    }
    if (lines.some((line) => !Number.isInteger(line.quantity) || line.quantity <= 0)) {
      onError("Every received quantity must be a positive whole number.");
      return;
    }
    if (!selectedPo && !nonPoException) {
      onError("Choose an open Purchase Order, or mark the receipt as a non-PO exception.");
      return;
    }

    setBusy(true);
    try {
      const result = await window.desktop.stores.bulkVendorReceipt({
        clientTransactionId: `DESKTOP-GRN-${globalThis.crypto.randomUUID()}`,
        supplierId: selectedSupplierId,
        purchaseOrderId: selectedPo?.id ?? null,
        challanNumber: challanNumber.trim(),
        challanDate,
        receiptDate,
        nonPoException,
        lines,
      });
      const next = await window.desktop.stores.getState();
      onChanged(next);
      setChallanNumber("");
      const nextOrder = selectedPo ? next.purchaseOrders.find((order) => order.id === selectedPo.id) : null;
      if (selectedPo && !nextOrder) setPurchaseOrderId("");
      setRows(nextOrder
        ? nextOrder.lines.filter((line) => line.outstandingQuantity > 0).map((line) => ({ tallyItemGuid: line.tallyItemGuid, quantity: "" }))
        : [emptyRow()]);
      onNotice(`Recorded ${result.grnNumber} with ${result.movements.length} received item line${result.movements.length === 1 ? "" : "s"}. It is now pending Tally review.`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="panel bulk-receipt-panel">
      <div className="panel__header bulk-receipt-heading">
        <div><p className="eyebrow">MATERIAL IN · RECEIPT NOTE / GRN</p><h2>Record a large vendor restock</h2><p>Use one header for the supplier delivery, then enter all Stock Item quantities received on that challan.</p></div>
        <div className="bulk-receipt-heading-actions">
          <button className="button button--secondary" type="button" onClick={clearForm} disabled={busy}>Clear form</button>
          <span className="health-badge">WHOLE COUNTS</span>
        </div>
      </div>

      <div className="bulk-receipt-header-grid">
        <label>Supplier<select value={supplierId} onChange={(event) => chooseSupplier(event.target.value)}><option value="">Choose supplier</option>{stores.suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
        <label>Purchase Order<select value={purchaseOrderId} onChange={(event) => choosePurchaseOrder(event.target.value)} disabled={!supplierId && supplierOrders.length === 0}><option value="">Choose open PO</option>{supplierOrders.map((order) => <option key={order.id} value={order.id}>{order.voucherNumber} · {order.voucherDate}</option>)}</select></label>
        <label>Supplier Challan No.<input value={challanNumber} onChange={(event) => setChallanNumber(event.target.value)} placeholder="Required" /></label>
        <label>Challan Date<input type="date" value={challanDate} onChange={(event) => setChallanDate(event.target.value)} /></label>
        <label>Receipt Date<input type="date" value={receiptDate} onChange={(event) => setReceiptDate(event.target.value)} /></label>
        <label className="bulk-receipt-exception"><input type="checkbox" checked={nonPoException} onChange={(event) => { setNonPoException(event.target.checked); if (event.target.checked) setPurchaseOrderId(""); }} /> Non-PO exception</label>
      </div>

      <div className="bulk-receipt-lines">
        <div className="bulk-receipt-line bulk-receipt-line--header"><span>Stock Item</span><span>Ordered</span><span>Previously received</span><span>Outstanding</span><span>Received now</span><span /></div>
        {rows.map((row, index) => {
          const poLine = selectedPo?.lines.find((line) => line.tallyItemGuid === row.tallyItemGuid);
          return (
            <div className="bulk-receipt-line" key={`${index}-${row.tallyItemGuid}`}>
              <select value={row.tallyItemGuid} onChange={(event) => updateRow(index, { tallyItemGuid: event.target.value })} disabled={Boolean(selectedPo)}>
                <option value="">Choose Stock Item</option>
                {allowedItems.map((item) => <option key={item.tallyItemGuid} value={item.tallyItemGuid} disabled={rows.some((candidate, candidateIndex) => candidateIndex !== index && candidate.tallyItemGuid === item.tallyItemGuid)}>{item.itemName}</option>)}
              </select>
              <span>{poLine?.orderedQuantity ?? "—"}</span>
              <span>{poLine?.receivedQuantity ?? "—"}</span>
              <span>{poLine?.outstandingQuantity ?? "—"}</span>
              <input type="number" min="1" step="1" max={poLine?.outstandingQuantity} value={row.quantity} onChange={(event) => updateRow(index, { quantity: event.target.value })} placeholder="0" />
              <button type="button" className="text-button" onClick={() => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index))} disabled={rows.length === 1 || Boolean(selectedPo)}>Remove</button>
            </div>
          );
        })}
      </div>

      <div className="bulk-receipt-footer">
        <button className="button button--secondary" type="button" onClick={() => setRows((current) => [...current, emptyRow()])} disabled={Boolean(selectedPo)}>Add item line</button>
        <div><span>{rows.filter((row) => row.tallyItemGuid && row.quantity).length} lines</span><strong>{totalQuantity} total units</strong><button className="button" type="button" disabled={busy} onClick={() => void submit()}>{busy ? "Recording…" : "Record Material In"}</button></div>
      </div>
    </article>
  );
}
