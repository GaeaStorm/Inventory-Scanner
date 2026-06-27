import { useState } from "react";

import BomManager from "./BomManager";
import BoxQrCodeCreatorTab from "./BoxQrCodeCreatorTab";
import BulkMaterialInForm from "./BulkMaterialInForm";
import CatalogStatusPanel from "./CatalogStatusPanel";
import InfoTip from "./InfoTip";
import OpeningQuantityPanel from "./OpeningQuantityPanel";
import ProductOrderPlanner from "./ProductOrderPlanner";
import RestockActionCenter from "./RestockActionCenter";
import type { Permission, PlanningState, StoresState } from "./types";

interface Props {
  planning: PlanningState;
  stores: StoresState;
  permissions: Permission[];
  onPlanningChanged: (state: PlanningState) => void;
  onStoresChanged: (state: StoresState) => void;
  onRefresh: () => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  scannerUrls: string[];
  canManageScannerPairing: boolean;
}

type PlanningSection = "action" | "boms" | "orders" | "tracker" | "qr";

function formatCode(value: string | null): string {
  if (!value) return "";
  return value
    .toLocaleLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toLocaleUpperCase());
}

const sections: Array<{ id: PlanningSection; label: string }> = [
  { id: "action", label: "Overview" },
  { id: "tracker", label: "Catalog Manager" },
  { id: "boms", label: "Product BOMs" },
  // { id: "orders", label: "Stock Planning" },
  { id: "qr", label: "QR Code Creator" },
];

export default function InventoryPlanningDashboard({
  planning,
  stores,
  permissions,
  onPlanningChanged,
  onStoresChanged,
  onRefresh,
  onNotice,
  onError,
  scannerUrls,
  canManageScannerPairing,
}: Props) {
  const [section, setSection] = useState<PlanningSection>("action");
  const can = (permission: Permission) => permissions.includes(permission);

  return (
    <section className="tab-page planning-page">
      <div className="page-heading planning-page-heading">
        <div className="heading-with-info">
          <div><p className="eyebrow">PLANNING</p><h1>Inventory Dashboard</h1></div>
          <InfoTip>
            Restock policies, BOMs, product demand, reservations, and incoming Purchase Orders are calculated from the Local Stores Database. Cached Tally data remains usable while Tally is unavailable.
          </InfoTip>
        </div>
      </div>

      <nav className="planning-subnav" aria-label="Inventory dashboard sections">
        {sections.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={section === entry.id ? "planning-subnav__active" : ""}
            onClick={() => setSection(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      {section === "action" && (
        <>
          {can("RECEIVE_MATERIAL") && <BulkMaterialInForm
            stores={stores}
            onChanged={onStoresChanged}
            onNotice={onNotice}
            onError={onError}
          />}
          <RestockActionCenter
            planning={planning}
            stores={stores}
            onChanged={onPlanningChanged}
            onStoresChanged={onStoresChanged}
            onNavigate={setSection}
            onNotice={onNotice}
            onError={onError}
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
        </>
      )}

      {section === "boms" && (
        <BomManager
          planning={planning}
          stores={stores}
          onChanged={onPlanningChanged}
          onStoresChanged={onStoresChanged}
          onNotice={onNotice}
          onError={onError}
        />
      )}

      {section === "orders" && (
        <ProductOrderPlanner
          planning={planning}
          stores={stores}
          onChanged={onPlanningChanged}
          onNotice={onNotice}
          onError={onError}
        />
      )}

      {section === "tracker" && (
        <div className="tab-page">
          <div className="page-heading">
            <button className="button button--secondary" type="button" onClick={() => void onRefresh()}>Refresh</button>
          </div>
          {can("STOCK_ADJUST") && <OpeningQuantityPanel
            stores={stores}
            onChanged={onStoresChanged}
            onNotice={onNotice}
            onError={onError}
          />}
          {can("CATALOG_MANAGE") && <CatalogStatusPanel
            stores={stores}
            onChanged={onStoresChanged}
            onNotice={onNotice}
            onError={onError}
          />}
        </div>
      )}

      {section === "qr" && (
        <BoxQrCodeCreatorTab
          stores={stores}
          onChanged={onStoresChanged}
          scannerUrls={scannerUrls}
          canManageScannerPairing={canManageScannerPairing}
        />
      )}
    </section>
  );
}
