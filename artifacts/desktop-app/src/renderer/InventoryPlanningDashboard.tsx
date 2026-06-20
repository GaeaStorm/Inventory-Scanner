import { useState } from "react";

import BomManager from "./BomManager";
import InfoTip from "./InfoTip";
import ProductOrderPlanner from "./ProductOrderPlanner";
import RestockActionCenter from "./RestockActionCenter";
import type { PlanningState, StoresState } from "./types";

interface Props {
  planning: PlanningState;
  stores: StoresState;
  onPlanningChanged: (state: PlanningState) => void;
  onStoresChanged: (state: StoresState) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

type PlanningSection = "action" | "boms" | "orders";

const sections: Array<{ id: PlanningSection; label: string }> = [
  { id: "action", label: "Action Center" },
  { id: "boms", label: "Product BOMs" },
  { id: "orders", label: "Stock Planning" },
];

export default function InventoryPlanningDashboard({
  planning,
  stores,
  onPlanningChanged,
  onStoresChanged,
  onNotice,
  onError,
}: Props) {
  const [section, setSection] = useState<PlanningSection>("action");

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
        <RestockActionCenter
          planning={planning}
          stores={stores}
          onChanged={onPlanningChanged}
          onNavigate={setSection}
          onNotice={onNotice}
          onError={onError}
        />
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
    </section>
  );
}
