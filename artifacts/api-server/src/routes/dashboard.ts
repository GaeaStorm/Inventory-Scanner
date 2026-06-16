import fs from "node:fs";
import path from "node:path";

import { Router, type Request, type Response } from "express";
import QRCode from "qrcode";

import { logger } from "../lib/logger";
import { getLanAddresses } from "../lib/network";
import {
  getWorkbookPath,
  readWorkbookPreview,
  setWorkbookPath,
  type WorkbookPreview,
} from "../lib/workbook";

const router = Router();

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Inventory Scanner</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system,
          BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #0b1020;
        color: #eef2ff;
      }

      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: #0b1020; }
      button, a, input { font: inherit; }
      a { color: inherit; }

      input {
        width: 100%;
        border: 1px solid #344166;
        border-radius: 10px;
        background: #0b1020;
        padding: 10px 12px;
        color: #eef2ff;
      }

      input:focus {
        border-color: #60a5fa;
        outline: 2px solid rgb(96 165 250 / 24%);
      }

      .shell {
        width: min(1180px, calc(100% - 32px));
        margin: 0 auto;
        padding: 32px 0 48px;
      }

      .header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 24px;
        margin-bottom: 24px;
      }

      h1 { margin: 0 0 8px; font-size: clamp(28px, 5vw, 44px); }
      .subtitle { margin: 0; color: #aab4d0; }

      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 1px solid #293456;
        border-radius: 999px;
        padding: 8px 12px;
        background: #111936;
        white-space: nowrap;
      }

      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #f59e0b;
        box-shadow: 0 0 0 4px rgb(245 158 11 / 14%);
      }

      .dot.online {
        background: #22c55e;
        box-shadow: 0 0 0 4px rgb(34 197 94 / 14%);
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
        margin-bottom: 16px;
      }

      .card {
        border: 1px solid #293456;
        border-radius: 18px;
        background: #111936;
        padding: 20px;
        box-shadow: 0 18px 50px rgb(0 0 0 / 18%);
      }

      .card h2 { margin: 0 0 8px; font-size: 17px; }
      .muted { color: #aab4d0; }
      .small { font-size: 13px; }

      .url-list {
        display: grid;
        gap: 10px;
        margin-top: 16px;
      }

      .url-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        gap: 10px;
      }

      .qr-panel {
        display: none;
        grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
        align-items: center;
        gap: 18px;
        margin-top: 18px;
        padding-top: 18px;
        border-top: 1px solid #293456;
      }

      .qr-panel.visible { display: grid; }

      .qr-image {
        width: min(100%, 240px);
        aspect-ratio: 1;
        border-radius: 14px;
        background: #ffffff;
        padding: 10px;
      }

      .qr-url {
        display: block;
        margin-top: 10px;
        overflow-wrap: anywhere;
        color: #dbeafe;
      }

      code {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        border: 1px solid #344166;
        border-radius: 10px;
        background: #0b1020;
        padding: 10px 12px;
        color: #dbeafe;
      }

      .button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid #52638f;
        border-radius: 10px;
        padding: 9px 13px;
        background: #1d2a50;
        color: #fff;
        text-decoration: none;
        cursor: pointer;
      }

      .button:hover { background: #263865; }
      .button.primary { background: #2563eb; border-color: #3b82f6; }
      .button.primary:hover { background: #1d4ed8; }
      .button[disabled] { cursor: not-allowed; opacity: 0.45; }

      .workbook-form {
        display: grid;
        gap: 10px;
        margin-top: 18px;
        padding-top: 16px;
        border-top: 1px solid #293456;
      }

      .form-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .form-message { min-height: 18px; }
      .form-message.success { color: #86efac; }
      .form-message.error { color: #fca5a5; }

      .meta {
        display: grid;
        gap: 8px;
        margin-top: 14px;
      }

      .meta-row {
        display: grid;
        grid-template-columns: 110px minmax(0, 1fr);
        gap: 12px;
      }

      .meta-row strong { color: #c7d2fe; }
      .meta-row span { overflow-wrap: anywhere; }

      .table-card { padding: 0; overflow: hidden; }
      .table-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        padding: 18px 20px;
        border-bottom: 1px solid #293456;
      }

      .table-head h2 { margin: 0; }
      .table-wrap { overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; min-width: 940px; }
      th, td {
        padding: 12px 14px;
        border-bottom: 1px solid #222d4d;
        text-align: left;
        vertical-align: top;
      }
      th {
        position: sticky;
        top: 0;
        background: #111936;
        color: #aab4d0;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      td { font-size: 14px; }
      tbody tr:hover { background: #151f40; }
      .empty { padding: 40px 20px; text-align: center; color: #aab4d0; }

      .footer {
        margin-top: 14px;
        text-align: right;
        color: #7f8bad;
        font-size: 12px;
      }

      @media (max-width: 760px) {
        .shell { width: min(100% - 20px, 1180px); padding-top: 20px; }
        .header { flex-direction: column; }
        .grid { grid-template-columns: 1fr; }
        .url-row { grid-template-columns: 1fr; }
        .qr-panel { grid-template-columns: 1fr; }
        .qr-image { margin: 0 auto; }
        .button { width: 100%; }
        .meta-row { grid-template-columns: 1fr; gap: 2px; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <header class="header">
        <div>
          <h1>Inventory Scanner</h1>
          <p class="subtitle">Local control panel</p>
        </div>
        <div class="status">
          <span id="status-dot" class="dot"></span>
          <span id="status-text">Connecting…</span>
        </div>
      </header>

      <section class="grid">
        <article class="card">
          <h2>Phone connection</h2>
          <p class="muted small">
            The app normally detects the server automatically. If it does not,
            open Settings in the app and scan one of these setup QR codes. The
            phone and computer must be on the same network.
          </p>
          <div id="url-list" class="url-list"></div>
          <div id="qr-panel" class="qr-panel">
            <img id="qr-image" class="qr-image" alt="Inventory Scanner setup QR code" />
            <div>
              <h2 style="margin-bottom: 8px">Scan in the app</h2>
              <p class="muted small" style="margin: 0">
                In Inventory Scanner, open Settings and choose
                <strong>Scan setup QR</strong>. The address is saved after a
                successful scan.
              </p>
              <span id="qr-url" class="qr-url small"></span>
            </div>
          </div>
        </article>

        <article class="card">
          <h2>Excel workbook</h2>
          <div class="meta">
            <div class="meta-row">
              <strong>Status</strong>
              <span id="workbook-status">Checking…</span>
            </div>
            <div class="meta-row">
              <strong>Rows</strong>
              <span id="row-count">0</span>
            </div>
            <div class="meta-row">
              <strong>Updated</strong>
              <span id="modified-at">—</span>
            </div>
            <div class="meta-row">
              <strong>Location</strong>
              <span id="workbook-path">—</span>
            </div>
          </div>
          <div style="margin-top: 16px">
            <a
              id="download-button"
              class="button primary"
              href="/api/workbook/download"
            >Download workbook</a>
          </div>

          <form id="workbook-form" class="workbook-form">
            <label for="workbook-location" class="small">
              Workbook location
            </label>
            <input
              id="workbook-location"
              name="workbookLocation"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="Full path ending in .xlsx"
            />
            <div class="muted small">
              Enter an .xlsx file path or an existing directory. Missing
              directories and workbooks are created automatically.
            </div>
            <div class="form-actions">
              <button id="save-location-button" class="button" type="submit">
                Use this location
              </button>
              <button id="default-location-button" class="button" type="button">
                Use default location
              </button>
            </div>
            <div id="location-message" class="form-message small"></div>
          </form>
        </article>
      </section>

      <section class="card table-card">
        <div class="table-head">
          <div>
            <h2>Latest transactions</h2>
            <div class="muted small">Newest entries appear first.</div>
          </div>
          <button id="refresh-button" class="button" type="button">
            Refresh
          </button>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time (IST)</th>
                <th>Reference</th>
                <th>Movement</th>
                <th>Item code</th>
                <th>Item</th>
                <th>In</th>
                <th>Out</th>
                <th>Godown</th>
                <th>Used in</th>
              </tr>
            </thead>
            <tbody id="rows">
              <tr><td colspan="9" class="empty">Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <div id="last-refresh" class="footer"></div>
    </main>

    <script>
      const fields = [
        "Timestamp in IST",
        "Ref No",
        "Movement Type",
        "Item Code",
        "Item Name",
        "In Qty",
        "Out Qty",
        "Godown",
        "Used In",
      ];

      const statusDot = document.querySelector("#status-dot");
      const statusText = document.querySelector("#status-text");
      const urlList = document.querySelector("#url-list");
      const rowsElement = document.querySelector("#rows");
      const qrPanel = document.querySelector("#qr-panel");
      const qrImage = document.querySelector("#qr-image");
      const qrUrl = document.querySelector("#qr-url");
      const refreshButton = document.querySelector("#refresh-button");
      const downloadButton = document.querySelector("#download-button");
      const workbookForm = document.querySelector("#workbook-form");
      const workbookLocation = document.querySelector("#workbook-location");
      const saveLocationButton = document.querySelector(
        "#save-location-button",
      );
      const defaultLocationButton = document.querySelector(
        "#default-location-button",
      );
      const locationMessage = document.querySelector("#location-message");

      function makeCell(value) {
        const cell = document.createElement("td");
        cell.textContent = value === "" || value == null ? "—" : String(value);
        return cell;
      }

      async function copyText(value, button) {
        await navigator.clipboard.writeText(value);
        const previous = button.textContent;
        button.textContent = "Copied";
        window.setTimeout(() => { button.textContent = previous; }, 1200);
      }

      function showSetupQr(url) {
        qrImage.src = "/api/connect/qr.svg?url=" + encodeURIComponent(url);
        qrUrl.textContent = url;
        qrPanel.classList.add("visible");
      }

      function renderUrls(urls) {
        urlList.replaceChildren();

        for (const url of urls) {
          const row = document.createElement("div");
          row.className = "url-row";

          const code = document.createElement("code");
          code.textContent = url;
          code.title = url;

          const copyButton = document.createElement("button");
          copyButton.className = "button";
          copyButton.type = "button";
          copyButton.textContent = "Copy";
          copyButton.addEventListener("click", () => copyText(url, copyButton));

          const qrButton = document.createElement("button");
          qrButton.className = "button primary";
          qrButton.type = "button";
          qrButton.textContent = "Show QR";
          qrButton.addEventListener("click", () => showSetupQr(url));

          row.append(code, copyButton, qrButton);
          urlList.append(row);
        }

        if (urls.length > 0 && !qrPanel.classList.contains("visible")) {
          showSetupQr(urls[0]);
        }
      }

      function setLocationMessage(message, kind) {
        locationMessage.textContent = message;
        locationMessage.classList.remove("success", "error");

        if (kind) {
          locationMessage.classList.add(kind);
        }
      }

      function renderRows(rows) {
        rowsElement.replaceChildren();

        if (rows.length === 0) {
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          cell.colSpan = fields.length;
          cell.className = "empty";
          cell.textContent = "No transactions have been saved yet.";
          row.append(cell);
          rowsElement.append(row);
          return;
        }

        for (const item of rows) {
          const row = document.createElement("tr");
          for (const field of fields) {
            row.append(makeCell(item[field]));
          }
          rowsElement.append(row);
        }
      }

      async function refresh() {
        refreshButton.disabled = true;

        try {
          const response = await fetch("/api/dashboard?limit=12", {
            cache: "no-store",
          });

          if (!response.ok) {
            throw new Error("Dashboard request failed: " + response.status);
          }

          const data = await response.json();
          statusDot.classList.add("online");
          statusText.textContent = "API online";
          renderUrls(data.scannerUrls);

          document.querySelector("#workbook-status").textContent =
            data.workbook.error
              ? "Cannot read workbook: " + data.workbook.error
              : data.workbook.exists
                ? "Ready"
                : "Not created";
          document.querySelector("#row-count").textContent =
            String(data.workbook.totalRows);
          document.querySelector("#modified-at").textContent =
            data.workbook.modifiedAt
              ? new Date(data.workbook.modifiedAt).toLocaleString()
              : "—";
          document.querySelector("#workbook-path").textContent =
            data.workbook.path;

          if (document.activeElement !== workbookLocation) {
            workbookLocation.value = data.workbook.path;
          }

          const canDownload =
            data.workbook.exists && !data.workbook.error;
          downloadButton.style.pointerEvents = canDownload ? "auto" : "none";
          downloadButton.setAttribute(
            "aria-disabled",
            canDownload ? "false" : "true",
          );
          downloadButton.style.opacity = canDownload ? "1" : "0.45";

          renderRows(data.workbook.rows);
          document.querySelector("#last-refresh").textContent =
            "Last refreshed " + new Date().toLocaleTimeString();
        } catch (error) {
          statusDot.classList.remove("online");
          statusText.textContent = "API unavailable";
          console.error(error);
        } finally {
          refreshButton.disabled = false;
        }
      }

      async function saveWorkbookLocation(pathValue) {
        saveLocationButton.disabled = true;
        defaultLocationButton.disabled = true;
        setLocationMessage("Saving…");

        try {
          const response = await fetch("/api/workbook/location", {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ path: pathValue }),
          });
          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "The workbook location was rejected");
          }

          workbookLocation.value = data.workbook.path;
          setLocationMessage(
            data.created
              ? "Workbook created and selected."
              : "Workbook location updated.",
            "success",
          );
          await refresh();
        } catch (error) {
          setLocationMessage(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        } finally {
          saveLocationButton.disabled = false;
          defaultLocationButton.disabled = false;
        }
      }

      workbookForm.addEventListener("submit", (event) => {
        event.preventDefault();
        saveWorkbookLocation(workbookLocation.value);
      });

      defaultLocationButton.addEventListener("click", () => {
        saveWorkbookLocation("");
      });

      refreshButton.addEventListener("click", refresh);
      refresh();
      window.setInterval(refresh, 3000);
    </script>
  </body>
</html>`;

function parsePreviewLimit(value: unknown): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 12;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLocalMachineRequest(req: Request): boolean {
  const remoteAddress = (req.socket.remoteAddress ?? "").replace(
    /^::ffff:/,
    "",
  );
  const localAddresses = new Set([
    "127.0.0.1",
    "::1",
    ...getLanAddresses(0).map(({ address }) => address),
  ]);

  return localAddresses.has(remoteAddress);
}

function readWorkbookPreviewSafely(limit: number): WorkbookPreview {
  try {
    return readWorkbookPreview(limit);
  } catch (error) {
    const workbookPath = getWorkbookPath();
    let modifiedAt: string | null = null;

    try {
      modifiedAt = fs.existsSync(workbookPath)
        ? fs.statSync(workbookPath).mtime.toISOString()
        : null;
    } catch {
      modifiedAt = null;
    }

    logger.error(
      { err: error, path: workbookPath },
      "Failed to read workbook preview",
    );

    return {
      exists: fs.existsSync(workbookPath),
      path: workbookPath,
      fileName: path.basename(workbookPath),
      modifiedAt,
      totalRows: 0,
      rows: [],
      error: getErrorMessage(error),
    };
  }
}

router.get("/", (_req: Request, res: Response) => {
  res
    .status(200)
    .type("html")
    .set("Cache-Control", "no-store")
    .send(DASHBOARD_HTML);
});

router.get("/favicon.ico", (_req: Request, res: Response) => {
  res.status(204).end();
});

function getScannerUrls(req: Request): string[] {
  const fallbackPort = Number(process.env["PORT"] ?? 5050);
  const port = req.socket.localPort ?? fallbackPort;
  const lanAddresses = getLanAddresses(port);

  return lanAddresses.length > 0
    ? lanAddresses.map(({ url }) => url)
    : [`http://localhost:${port}`];
}

router.get("/api/dashboard", (req: Request, res: Response) => {
  const scannerUrls = getScannerUrls(req);

  res
    .set("Cache-Control", "no-store")
    .json({
      status: "ok",
      scannerUrls,
      workbook: readWorkbookPreviewSafely(
        parsePreviewLimit(req.query["limit"]),
      ),
    });
});

router.get("/api/connect/qr.svg", async (req: Request, res: Response) => {
  const requestedUrl =
    typeof req.query["url"] === "string" ? req.query["url"] : "";
  const scannerUrls = getScannerUrls(req);

  if (!scannerUrls.includes(requestedUrl)) {
    res.status(400).json({
      error: "The requested server URL is not available from this computer",
    });
    return;
  }

  const payload = JSON.stringify({
    type: "inventory-scanner/server",
    version: 1,
    url: requestedUrl,
  });

  try {
    const svg = await QRCode.toString(payload, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      width: 280,
    });

    res
      .status(200)
      .type("image/svg+xml")
      .set("Cache-Control", "no-store")
      .send(svg);
  } catch (error) {
    logger.error(
      { err: error, url: requestedUrl },
      "Failed to generate server setup QR code",
    );
    res.status(500).json({
      error: "The setup QR code could not be generated",
    });
  }
});

router.put("/api/workbook/location", (req: Request, res: Response) => {
  if (!isLocalMachineRequest(req)) {
    res.status(403).json({
      error:
        "Workbook locations can only be changed from a browser on this computer",
    });
    return;
  }

  if (typeof req.body?.path !== "string") {
    res.status(400).json({
      error: "A workbook path is required",
    });
    return;
  }

  try {
    const result = setWorkbookPath(req.body.path);
    res
      .set("Cache-Control", "no-store")
      .json({
        created: result.created,
        workbook: readWorkbookPreview(12),
      });
  } catch (error) {
    logger.error(
      {
        err: error,
        requestedPath: req.body.path,
      },
      "Failed to change workbook location",
    );
    res.status(400).json({
      error: getErrorMessage(error),
    });
  }
});

router.get("/api/workbook/download", (_req: Request, res: Response) => {
  const workbookPath = getWorkbookPath();

  if (!fs.existsSync(workbookPath)) {
    res.status(404).json({
      error: "The workbook does not exist yet",
    });
    return;
  }

  res.download(workbookPath, path.basename(workbookPath), (error) => {
    if (error && !res.headersSent) {
      logger.error(
        { err: error, path: workbookPath },
        "Failed to download workbook",
      );
      res.status(500).json({
        error: "The workbook could not be downloaded",
      });
    }
  });
});

export default router;
