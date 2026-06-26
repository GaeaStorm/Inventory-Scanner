import type { CrfPayload } from "./types";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatStage(stage: string): string {
  return stage.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function fulfilmentRows(payload: CrfPayload): string {
  const byParent = new Map<string | null, typeof payload.fulfilmentLines>();
  for (const line of payload.fulfilmentLines) {
    const key = line.parentFulfilmentLineId;
    byParent.set(key, [...(byParent.get(key) ?? []), line]);
  }
  const renderLine = (line: typeof payload.fulfilmentLines[number], depth: number): string => {
    const indent = "&nbsp;".repeat(depth * 4);
    const status = line.family === "SERVICE"
      ? (line.serviceDone ? "Done" : "Pending")
      : formatStage(line.stage || "—");
    const supplier = line.resaleSupplierName ? ` &middot; Supplier: ${escapeHtml(line.resaleSupplierName)}` : "";
    const children = (byParent.get(line.id) ?? []).map((child) => renderLine(child, depth + 1)).join("");
    return `
      <tr>
        <td>${indent}${escapeHtml(line.itemQualifiedName)}</td>
        <td>${escapeHtml(line.family)}</td>
        <td class="num">${escapeHtml(line.quantity)}</td>
        <td>${escapeHtml(line.consumptionMode)}</td>
        <td>${escapeHtml(status)}${supplier}</td>
      </tr>
      ${children}`;
  };
  return (byParent.get(null) ?? []).map((line) => renderLine(line, 0)).join("");
}

function checklistRows(payload: CrfPayload): string {
  if (payload.checklist.length === 0) return `<tr><td colspan="3">No checklist template was active when this CRF was submitted.</td></tr>`;
  return payload.checklist.map((entry) => `
    <tr>
      <td>${escapeHtml(entry.description || entry.targetType)}</td>
      <td class="status status--${entry.status.toLocaleLowerCase()}">${escapeHtml(entry.status)}</td>
      <td>${entry.status === "WAIVED" ? escapeHtml(`${entry.waiverReason} (${entry.waiverActorName}, ${entry.waiverRole})`) : ""}</td>
    </tr>`).join("");
}

function approvalRows(payload: CrfPayload): string {
  const decisions = payload.approvalRequests.flatMap((request) => request.decisions.map((decision) => ({ request, decision })));
  if (decisions.length === 0) return `<tr><td colspan="4">No approval decisions recorded at the time this CRF was generated.</td></tr>`;
  return decisions.map(({ request, decision }) => `
    <tr>
      <td>${escapeHtml(request.entityType)}</td>
      <td>${escapeHtml(decision.decidedByName)} (${escapeHtml(decision.decidedByRole)})</td>
      <td class="status status--${decision.decision === "APPROVE" ? "satisfied" : "unsatisfied"}">${escapeHtml(decision.decision)}</td>
      <td>${escapeHtml(decision.comment)}</td>
    </tr>`).join("");
}

/**
 * Renders a CRF revision's frozen payload as a printable HTML document.
 * Always built from a stored crf_revisions.payload_json snapshot — never
 * from live order data — so a historical revision reprints exactly as it
 * was originally approved, even after later order changes.
 */
export function buildCrfHtml(payload: CrfPayload): string {
  return String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>CRF — ${escapeHtml(payload.order.customerName)} — Revision ${escapeHtml(payload.revisionNumber)}</title>
    <style>
      :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #111827; }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 32px; }
      h1 { font-size: 20px; margin: 0 0 4px; }
      h2 { font-size: 14px; margin: 24px 0 8px; text-transform: uppercase; letter-spacing: 0.05em; color: #4b5563; }
      .subtitle { color: #6b7280; margin: 0 0 24px; font-size: 13px; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      th, td { border: 1px solid #d1d5db; padding: 6px 8px; text-align: left; vertical-align: top; }
      th { background: #f3f4f6; }
      td.num { text-align: right; }
      .meta-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 24px; font-size: 13px; margin-bottom: 8px; }
      .meta-grid div { display: flex; justify-content: space-between; border-bottom: 1px dotted #e5e7eb; padding: 2px 0; }
      .status--satisfied { color: #047857; font-weight: 600; }
      .status--waived { color: #b45309; font-weight: 600; }
      .status--unsatisfied { color: #b91c1c; font-weight: 600; }
      @media print { body { padding: 0; } }
    </style>
  </head>
  <body>
    <h1>Customer Requirement Form (CRF)</h1>
    <p class="subtitle">Revision ${escapeHtml(payload.revisionNumber)} &middot; Generated ${escapeHtml(payload.generatedAt)}</p>

    <h2>Order</h2>
    <div class="meta-grid">
      <div><span>Customer</span><strong>${escapeHtml(payload.order.customerName)}</strong></div>
      <div><span>PO Reference</span><strong>${escapeHtml(payload.order.poReference)}</strong></div>
      <div><span>Tally Voucher</span><strong>${escapeHtml(payload.order.voucherNumber)}</strong></div>
      <div><span>Voucher Date</span><strong>${escapeHtml(payload.order.voucherDate)}</strong></div>
      <div><span>PO Value</span><strong>${payload.order.poValue == null ? "—" : escapeHtml(payload.order.poValue)}</strong></div>
      <div><span>Stage</span><strong>${escapeHtml(formatStage(payload.order.orderStage))}</strong></div>
    </div>

    <h2>Tally Source Lines (read-only)</h2>
    <table>
      <thead><tr><th>Item</th><th>Family</th><th class="num">Qty</th><th class="num">Value</th></tr></thead>
      <tbody>
        ${payload.sourceLines.map((line) => `
          <tr>
            <td>${escapeHtml(line.itemQualifiedNameSnapshot)}</td>
            <td>${escapeHtml(line.family)}</td>
            <td class="num">${escapeHtml(line.quantity)}</td>
            <td class="num">${line.value == null ? "—" : escapeHtml(line.value)}</td>
          </tr>`).join("")}
      </tbody>
    </table>

    <h2>Fulfilment Breakdown</h2>
    <table>
      <thead><tr><th>Item</th><th>Family</th><th class="num">Qty</th><th>Consumption</th><th>Stage / Status</th></tr></thead>
      <tbody>${fulfilmentRows(payload)}</tbody>
    </table>

    <h2>Checklist</h2>
    <table>
      <thead><tr><th>Requirement</th><th>Status</th><th>Waiver</th></tr></thead>
      <tbody>${checklistRows(payload)}</tbody>
    </table>

    <h2>Approvals</h2>
    <table>
      <thead><tr><th>Gate</th><th>Decided By</th><th>Decision</th><th>Comment</th></tr></thead>
      <tbody>${approvalRows(payload)}</tbody>
    </table>
  </body>
</html>`;
}
