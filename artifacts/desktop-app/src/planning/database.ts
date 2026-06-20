import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ApplicationDatabase, ApplicationDatabaseMigration } from "../database/application-database";
import type {
  BomLine,
  BomVersion,
  PlanningFreshness,
  PlanningState,
  PlanningSummary,
  ProductOrder,
  ProductOrderRequirement,
  RecommendationDecisionInput,
  RestockHealth,
  RestockPlanningItem,
  RestockPolicyInput,
  SaveBomInput,
  SaveProductOrderInput,
} from "./types";

const MODULE_NAME = "planning";
const EXPORT_SCHEMA_VERSION = "3.0";

type Row = Record<string, any>;

function nowIso(): string {
  return new Date().toISOString();
}

function dateOnly(value?: string): string {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.valueOf())) throw new Error("Enter a valid date.");
  return date.toISOString().slice(0, 10);
}

function wholeNumber(value: unknown, label: string, allowZero = true): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be ${allowZero ? "zero or a positive" : "a positive"} whole number.`);
  }
  return parsed;
}

function percentage(value: unknown, label: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`${label} must be between 0 and 100.`);
  }
  return parsed;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

const migrations: ApplicationDatabaseMigration[] = [
  {
    version: 1,
    description: "Create restock policies, BOM versions, product orders, reservations, and planning exports",
    up(database: DatabaseSync) {
      database.exec(`
        CREATE TABLE planning_restock_policies (
          stock_item_id INTEGER PRIMARY KEY REFERENCES tally_stock_items(id) ON DELETE CASCADE,
          planning_method TEXT NOT NULL DEFAULT 'MANUAL' CHECK (planning_method IN ('MANUAL','USAGE_SUGGESTED')),
          reorder_point INTEGER NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
          target_stock INTEGER NOT NULL DEFAULT 0 CHECK (target_stock >= 0),
          service_reserve INTEGER NOT NULL DEFAULT 0 CHECK (service_reserve >= 0),
          preferred_supplier_id INTEGER REFERENCES suppliers(id),
          lead_time_days INTEGER NOT NULL DEFAULT 0 CHECK (lead_time_days >= 0),
          safety_days INTEGER NOT NULL DEFAULT 0 CHECK (safety_days >= 0),
          minimum_order_quantity INTEGER NOT NULL DEFAULT 0 CHECK (minimum_order_quantity >= 0),
          usage_lookback_days INTEGER NOT NULL DEFAULT 90 CHECK (usage_lookback_days BETWEEN 7 AND 730),
          notes TEXT NOT NULL DEFAULT '',
          updated_by TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE planning_recommendations (
          stock_item_id INTEGER PRIMARY KEY REFERENCES tally_stock_items(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'SUGGESTED' CHECK (status IN ('SUGGESTED','REVIEWED','APPROVED','EXPORTED')),
          approved_order_quantity INTEGER CHECK (approved_order_quantity IS NULL OR approved_order_quantity >= 0),
          reviewed_by TEXT NOT NULL DEFAULT '',
          reviewed_at TEXT,
          exported_at TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE planning_bom_versions (
          id TEXT PRIMARY KEY,
          product_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id) ON DELETE CASCADE,
          version_number INTEGER NOT NULL CHECK (version_number > 0),
          label TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
          source TEXT NOT NULL CHECK (source IN ('TALLY','MANUAL','FILE_IMPORT')),
          valid_from TEXT NOT NULL,
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT '',
          UNIQUE(product_item_id, version_number)
        ) STRICT;

        CREATE TABLE planning_bom_lines (
          id INTEGER PRIMARY KEY,
          bom_version_id TEXT NOT NULL REFERENCES planning_bom_versions(id) ON DELETE CASCADE,
          component_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
          quantity_per_product INTEGER NOT NULL CHECK (quantity_per_product > 0),
          loss_buffer_percent REAL NOT NULL DEFAULT 0 CHECK (loss_buffer_percent >= 0 AND loss_buffer_percent <= 100),
          UNIQUE(bom_version_id, component_item_id)
        ) STRICT;

        CREATE TABLE planning_product_orders (
          id TEXT PRIMARY KEY,
          external_reference TEXT NOT NULL DEFAULT '',
          product_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          required_date TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('DRAFT','CONFIRMED','CANCELLED','COMPLETED')),
          bom_version_id TEXT REFERENCES planning_bom_versions(id),
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE planning_reservations (
          id TEXT PRIMARY KEY,
          product_order_id TEXT NOT NULL REFERENCES planning_product_orders(id) ON DELETE CASCADE,
          component_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
          required_quantity INTEGER NOT NULL CHECK (required_quantity >= 0),
          reserved_quantity INTEGER NOT NULL CHECK (reserved_quantity >= 0),
          status TEXT NOT NULL CHECK (status IN ('ACTIVE','RELEASED','CONSUMED')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(product_order_id, component_item_id)
        ) STRICT;

        CREATE TABLE planning_export_batches (
          id TEXT PRIMARY KEY,
          schema_version TEXT NOT NULL,
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT '',
          excel_filename TEXT NOT NULL,
          csv_filename TEXT NOT NULL DEFAULT '',
          item_count INTEGER NOT NULL,
          payload_hash TEXT NOT NULL DEFAULT ''
        ) STRICT;

        CREATE UNIQUE INDEX idx_planning_orders_reference
          ON planning_product_orders(external_reference, product_item_id)
          WHERE external_reference <> '';
        CREATE INDEX idx_planning_orders_status ON planning_product_orders(status, required_date);
        CREATE INDEX idx_planning_reservations_component ON planning_reservations(component_item_id, status);
        CREATE INDEX idx_planning_boms_product ON planning_bom_versions(product_item_id, status, version_number);
      `);
    },
  },
];

export class PlanningDatabase {
  readonly host: ApplicationDatabase;
  private readonly beforeMigration?: () => void;

  constructor(host: ApplicationDatabase, beforeMigration?: () => void) {
    this.host = host;
    this.beforeMigration = beforeMigration;
    this.ensureReady();
  }

  ensureReady(): number {
    const version = this.host.migrateModule(MODULE_NAME, migrations, this.beforeMigration);
    this.syncMissingTallyBoms();
    return version;
  }

  get db(): DatabaseSync {
    return this.host.db;
  }

  resetForCatalogReplacement(): void {
    this.ensureReady();
    this.host.transaction("clearing demo planning data before catalog replacement", () => {
      this.db.exec(`
        DELETE FROM planning_export_batches;
        DELETE FROM planning_reservations;
        DELETE FROM planning_product_orders;
        DELETE FROM planning_bom_lines;
        DELETE FROM planning_bom_versions;
        DELETE FROM planning_recommendations;
        DELETE FROM planning_restock_policies;
      `);
    });
  }

  private stockItemByGuid(guid: string): Row {
    const row = this.db.prepare(
      "SELECT id, tally_guid, name, parent_name FROM tally_stock_items WHERE tally_guid = ? AND active = 1",
    ).get(text(guid)) as Row | undefined;
    if (!row) throw new Error("The selected Tally Stock Item is no longer active in the Stores Catalog.");
    return row;
  }

  syncMissingTallyBoms(): number {
    const products = this.db.prepare(`
      SELECT DISTINCT bc.product_item_id
      FROM bom_components bc
      WHERE bc.quantity IS NOT NULL AND bc.quantity > 0
        AND NOT EXISTS (
          SELECT 1 FROM planning_bom_versions existing
          WHERE existing.product_item_id = bc.product_item_id
        )
    `).all() as Row[];
    if (products.length === 0) return 0;
    this.host.transaction("importing synchronized Tally BOMs into planning", () => {
      for (const product of products) {
        const id = randomUUID();
        this.db.prepare(`
          INSERT INTO planning_bom_versions(
            id, product_item_id, version_number, label, status, source, valid_from, created_at, created_by
          ) VALUES (?, ?, 1, 'Imported from Tally', 'ACTIVE', 'TALLY', ?, ?, 'Tally sync')
        `).run(id, product.product_item_id, dateOnly(), nowIso());
        const lines = this.db.prepare(`
          SELECT component_item_id, quantity FROM bom_components
          WHERE product_item_id = ? AND quantity IS NOT NULL AND quantity > 0
        `).all(product.product_item_id) as Row[];
        for (const line of lines) {
          this.db.prepare(`
            INSERT INTO planning_bom_lines(
              bom_version_id, component_item_id, quantity_per_product, loss_buffer_percent
            ) VALUES (?, ?, ?, 0)
          `).run(id, line.component_item_id, line.quantity);
        }
      }
    });
    return products.length;
  }

  saveRestockPolicy(input: RestockPolicyInput): void {
    this.ensureReady();
    const item = this.stockItemByGuid(input.tallyItemGuid);
    const method = input.planningMethod === "USAGE_SUGGESTED" ? "USAGE_SUGGESTED" : "MANUAL";
    const reorderPoint = wholeNumber(input.reorderPoint, "Reorder point");
    const targetStock = wholeNumber(input.targetStock, "Target stock");
    if (targetStock < reorderPoint) throw new Error("Target stock cannot be lower than the reorder point.");
    const supplierId = input.preferredSupplierId == null ? null : Number(input.preferredSupplierId);
    if (supplierId != null && !this.db.prepare("SELECT 1 FROM suppliers WHERE id = ?").get(supplierId)) {
      throw new Error("The selected preferred supplier is no longer available.");
    }
    this.host.transaction("saving a restock policy", () => {
      this.db.prepare(`
        INSERT INTO planning_restock_policies(
          stock_item_id, planning_method, reorder_point, target_stock, service_reserve,
          preferred_supplier_id, lead_time_days, safety_days, minimum_order_quantity,
          usage_lookback_days, notes, updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stock_item_id) DO UPDATE SET
          planning_method = excluded.planning_method,
          reorder_point = excluded.reorder_point,
          target_stock = excluded.target_stock,
          service_reserve = excluded.service_reserve,
          preferred_supplier_id = excluded.preferred_supplier_id,
          lead_time_days = excluded.lead_time_days,
          safety_days = excluded.safety_days,
          minimum_order_quantity = excluded.minimum_order_quantity,
          usage_lookback_days = excluded.usage_lookback_days,
          notes = excluded.notes,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `).run(
        item.id,
        method,
        reorderPoint,
        targetStock,
        wholeNumber(input.serviceReserve, "Service reserve"),
        supplierId,
        wholeNumber(input.leadTimeDays, "Lead time"),
        wholeNumber(input.safetyDays, "Safety days"),
        wholeNumber(input.minimumOrderQuantity, "Minimum order quantity"),
        Math.max(7, Math.min(730, wholeNumber(input.usageLookbackDays, "Usage lookback", false))),
        text(input.notes),
        text(input.updatedBy),
        nowIso(),
      );
      this.db.prepare(`
        INSERT INTO planning_recommendations(stock_item_id, status, updated_at)
        VALUES (?, 'SUGGESTED', ?)
        ON CONFLICT(stock_item_id) DO UPDATE SET
          status = 'SUGGESTED',
          approved_order_quantity = NULL,
          reviewed_by = '',
          reviewed_at = NULL,
          exported_at = NULL,
          updated_at = excluded.updated_at
      `).run(item.id, nowIso());
    });
  }

  decideRecommendation(input: RecommendationDecisionInput): void {
    this.ensureReady();
    const item = this.stockItemByGuid(input.tallyItemGuid);
    const allowed = ["SUGGESTED", "REVIEWED", "APPROVED"];
    if (!allowed.includes(input.status)) throw new Error("Choose a valid recommendation status.");
    const quantity = input.approvedOrderQuantity == null
      ? null
      : wholeNumber(input.approvedOrderQuantity, "Approved order quantity");
    this.host.transaction("reviewing a restock recommendation", () => {
      this.db.prepare(`
        INSERT INTO planning_recommendations(
          stock_item_id, status, approved_order_quantity, reviewed_by, reviewed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(stock_item_id) DO UPDATE SET
          status = excluded.status,
          approved_order_quantity = excluded.approved_order_quantity,
          reviewed_by = excluded.reviewed_by,
          reviewed_at = excluded.reviewed_at,
          updated_at = excluded.updated_at
      `).run(item.id, input.status, quantity, text(input.reviewedBy), nowIso(), nowIso());
    });
  }

  saveBom(input: SaveBomInput): BomVersion {
    this.ensureReady();
    const product = this.stockItemByGuid(input.productTallyGuid);
    const lines = Array.isArray(input.lines) ? input.lines : [];
    if (lines.length === 0) throw new Error("Add at least one component to the BOM.");
    const normalized = lines.map((line) => ({
      component: this.stockItemByGuid(line.componentTallyGuid),
      quantity: wholeNumber(line.quantityPerProduct, "Component quantity", false),
      loss: percentage(line.lossBufferPercent ?? 0, "Loss buffer"),
    }));
    if (new Set(normalized.map((line) => Number(line.component.id))).size !== normalized.length) {
      throw new Error("Each component can appear only once in a BOM version.");
    }
    if (normalized.some((line) => Number(line.component.id) === Number(product.id))) {
      throw new Error("A product cannot contain itself as a component.");
    }

    const id = randomUUID();
    this.host.transaction("saving a product BOM version", () => {
      const nextVersion = Number((this.db.prepare(`
        SELECT COALESCE(MAX(version_number), 0) + 1 AS version
        FROM planning_bom_versions WHERE product_item_id = ?
      `).get(product.id) as Row).version);
      if (input.activate !== false) {
        this.db.prepare(`
          UPDATE planning_bom_versions SET status = 'ARCHIVED'
          WHERE product_item_id = ? AND status = 'ACTIVE'
        `).run(product.id);
      }
      this.db.prepare(`
        INSERT INTO planning_bom_versions(
          id, product_item_id, version_number, label, status, source, valid_from, created_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        product.id,
        nextVersion,
        text(input.label) || `BOM v${nextVersion}`,
        input.activate === false ? "DRAFT" : "ACTIVE",
        input.source === "FILE_IMPORT" ? "FILE_IMPORT" : "MANUAL",
        dateOnly(input.validFrom),
        nowIso(),
        text(input.createdBy),
      );
      for (const line of normalized) {
        this.db.prepare(`
          INSERT INTO planning_bom_lines(
            bom_version_id, component_item_id, quantity_per_product, loss_buffer_percent
          ) VALUES (?, ?, ?, ?)
        `).run(id, line.component.id, line.quantity, line.loss);
      }
    });
    return this.getBoms().find((bom) => bom.id === id)!;
  }

  activateBom(bomId: string): void {
    this.ensureReady();
    const row = this.db.prepare("SELECT product_item_id FROM planning_bom_versions WHERE id = ?").get(bomId) as Row | undefined;
    if (!row) throw new Error("BOM version not found.");
    this.host.transaction("activating a BOM version", () => {
      this.db.prepare("UPDATE planning_bom_versions SET status = 'ARCHIVED' WHERE product_item_id = ? AND status = 'ACTIVE'").run(row.product_item_id);
      this.db.prepare("UPDATE planning_bom_versions SET status = 'ACTIVE' WHERE id = ?").run(bomId);
    });
  }

  private activeBomForProduct(productItemId: number): Row | null {
    return (this.db.prepare(`
      SELECT * FROM planning_bom_versions
      WHERE product_item_id = ? AND status = 'ACTIVE'
      ORDER BY version_number DESC LIMIT 1
    `).get(productItemId) as Row | undefined) ?? null;
  }

  saveProductOrder(input: SaveProductOrderInput): ProductOrder {
    this.ensureReady();
    const product = this.stockItemByGuid(input.productTallyGuid);
    const quantity = wholeNumber(input.quantity, "Product order quantity", false);
    const status = input.status === "DRAFT" ? "DRAFT" : "CONFIRMED";
    const suppliedId = text(input.id);
    const externalReference = text(input.externalReference);
    const matchingReference = !suppliedId && externalReference
      ? this.db.prepare(`
          SELECT id FROM planning_product_orders
          WHERE external_reference = ? AND product_item_id = ?
        `).get(externalReference, product.id) as Row | undefined
      : undefined;
    const orderId = suppliedId || text(matchingReference?.id) || randomUUID();
    const timestamp = nowIso();

    this.host.transaction("saving a product order and reservations", () => {
      const existing = this.db.prepare("SELECT created_at FROM planning_product_orders WHERE id = ?").get(orderId) as Row | undefined;
      const bom = this.activeBomForProduct(Number(product.id));
      this.db.prepare(`
        INSERT INTO planning_product_orders(
          id, external_reference, product_item_id, quantity, required_date, status,
          bom_version_id, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          external_reference = excluded.external_reference,
          product_item_id = excluded.product_item_id,
          quantity = excluded.quantity,
          required_date = excluded.required_date,
          status = excluded.status,
          bom_version_id = excluded.bom_version_id,
          notes = excluded.notes,
          updated_at = excluded.updated_at
      `).run(
        orderId,
        externalReference,
        product.id,
        quantity,
        dateOnly(input.requiredDate),
        status,
        bom?.id ?? null,
        text(input.notes),
        existing?.created_at ?? timestamp,
        timestamp,
      );
      this.db.prepare("DELETE FROM planning_reservations WHERE product_order_id = ?").run(orderId);
      if (status === "CONFIRMED" && bom) this.createReservations(orderId, bom, quantity);
    });
    return this.getProductOrders().find((order) => order.id === orderId)!;
  }

  private createReservations(orderId: string, bom: Row, orderQuantity: number): void {
    const lines = this.db.prepare(`
      SELECT component_item_id, quantity_per_product, loss_buffer_percent
      FROM planning_bom_lines WHERE bom_version_id = ? ORDER BY id
    `).all(bom.id) as Row[];
    const timestamp = nowIso();
    for (const line of lines) {
      const required = Math.ceil(
        orderQuantity * Number(line.quantity_per_product) * (1 + Number(line.loss_buffer_percent) / 100),
      );
      // A reservation represents committed demand, not a physical FIFO allocation.
      // Keep the full requirement even when stock is insufficient so the Action
      // Center shows a negative available balance before production is blocked.
      this.db.prepare(`
        INSERT INTO planning_reservations(
          id, product_order_id, component_item_id, required_quantity,
          reserved_quantity, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
      `).run(randomUUID(), orderId, line.component_item_id, required, required, timestamp, timestamp);
    }
  }

  updateProductOrderStatus(orderId: string, status: "CANCELLED" | "COMPLETED" | "CONFIRMED"): void {
    this.ensureReady();
    const row = this.db.prepare("SELECT * FROM planning_product_orders WHERE id = ?").get(orderId) as Row | undefined;
    if (!row) throw new Error("Product order not found.");
    this.host.transaction("updating a product order", () => {
      let bom = row.bom_version_id
        ? this.db.prepare("SELECT * FROM planning_bom_versions WHERE id = ?").get(row.bom_version_id) as Row | undefined
        : undefined;
      if (status === "CONFIRMED" && !bom) {
        bom = this.activeBomForProduct(Number(row.product_item_id)) ?? undefined;
      }
      this.db.prepare(`
        UPDATE planning_product_orders
        SET status = ?, bom_version_id = ?, updated_at = ?
        WHERE id = ?
      `).run(status, status === "CONFIRMED" ? (bom?.id ?? null) : row.bom_version_id, nowIso(), orderId);
      if (status === "CONFIRMED") {
        this.db.prepare("DELETE FROM planning_reservations WHERE product_order_id = ?").run(orderId);
        if (bom) this.createReservations(orderId, bom, Number(row.quantity));
      } else {
        this.db.prepare(`
          UPDATE planning_reservations
          SET status = 'RELEASED', updated_at = ?
          WHERE product_order_id = ? AND status = 'ACTIVE'
        `).run(nowIso(), orderId);
      }
    });
  }



  private getBoms(): BomVersion[] {
    const rows = this.db.prepare(`
      SELECT b.*, item.tally_guid AS product_tally_guid,
        COALESCE(NULLIF(item.local_name_override, ''), item.name) AS product_name
      FROM planning_bom_versions b
      JOIN tally_stock_items item ON item.id = b.product_item_id
      ORDER BY item.name, b.version_number DESC
    `).all() as Row[];
    const lineStatement = this.db.prepare(`
      SELECT l.*, item.tally_guid AS component_tally_guid,
        COALESCE(NULLIF(item.local_name_override, ''), item.name) AS component_name
      FROM planning_bom_lines l
      JOIN tally_stock_items item ON item.id = l.component_item_id
      WHERE l.bom_version_id = ? ORDER BY item.name
    `);
    return rows.map((row) => ({
      id: text(row.id),
      productStockItemId: Number(row.product_item_id),
      productTallyGuid: text(row.product_tally_guid),
      productName: text(row.product_name),
      versionNumber: Number(row.version_number),
      label: text(row.label),
      status: row.status,
      source: row.source,
      validFrom: text(row.valid_from),
      createdAt: text(row.created_at),
      createdBy: text(row.created_by),
      lines: (lineStatement.all(row.id) as Row[]).map((line): BomLine => ({
        id: Number(line.id),
        componentStockItemId: Number(line.component_item_id),
        componentTallyGuid: text(line.component_tally_guid),
        componentName: text(line.component_name),
        quantityPerProduct: Number(line.quantity_per_product),
        lossBufferPercent: Number(line.loss_buffer_percent),
      })),
    }));
  }

  private getProductOrders(): ProductOrder[] {
    const rows = this.db.prepare(`
      SELECT o.*, item.tally_guid AS product_tally_guid,
        COALESCE(NULLIF(item.local_name_override, ''), item.name) AS product_name,
        bom.label AS bom_label, bom.version_number AS bom_version_number
      FROM planning_product_orders o
      JOIN tally_stock_items item ON item.id = o.product_item_id
      LEFT JOIN planning_bom_versions bom ON bom.id = o.bom_version_id
      ORDER BY CASE o.status WHEN 'CONFIRMED' THEN 0 WHEN 'DRAFT' THEN 1 ELSE 2 END,
        o.required_date, o.created_at DESC
    `).all() as Row[];
    const requirementsStatement = this.db.prepare(`
      SELECT r.*, item.tally_guid AS component_tally_guid,
        COALESCE(NULLIF(item.local_name_override, ''), item.name) AS component_name,
        line.quantity_per_product, line.loss_buffer_percent,
        COALESCE((SELECT SUM(quantity_remaining) FROM purchase_lots WHERE stock_item_id = r.component_item_id), 0) AS on_hand,
        COALESCE((SELECT service_reserve FROM planning_restock_policies WHERE stock_item_id = r.component_item_id), 0) AS service_reserve,
        COALESCE((SELECT SUM(pol.ordered_quantity - pol.received_quantity)
          FROM purchase_order_lines pol JOIN purchase_orders po ON po.id = pol.purchase_order_id
          WHERE pol.stock_item_id = r.component_item_id
            AND po.status <> 'CLOSED'
            AND pol.ordered_quantity > pol.received_quantity), 0) AS incoming
      FROM planning_reservations r
      JOIN tally_stock_items item ON item.id = r.component_item_id
      LEFT JOIN planning_product_orders po ON po.id = r.product_order_id
      LEFT JOIN planning_bom_lines line ON line.bom_version_id = po.bom_version_id AND line.component_item_id = r.component_item_id
      WHERE r.product_order_id = ? ORDER BY item.name
    `);
    const priorCommittedByComponent = new Map<number, number>();
    return rows.map((row) => {
      const requirements = (requirementsStatement.all(row.id) as Row[]).map((requirement): ProductOrderRequirement => {
        const componentId = Number(requirement.component_item_id);
        const priorCommitted = priorCommittedByComponent.get(componentId) ?? 0;
        const onHandAvailable = Math.max(0, Number(requirement.on_hand) - Number(requirement.service_reserve));
        const totalIncoming = Math.max(0, Number(requirement.incoming));
        const availableBeforeOrder = Math.max(0, onHandAvailable - priorCommitted);
        const projectedBeforeOrder = Math.max(0, onHandAvailable + totalIncoming - priorCommitted);
        const required = Number(requirement.required_quantity);
        const incomingAvailableForOrder = Math.min(
          Math.max(0, projectedBeforeOrder - availableBeforeOrder),
          Math.max(0, required - availableBeforeOrder),
        );
        if (row.status === "CONFIRMED") {
          priorCommittedByComponent.set(componentId, priorCommitted + required);
        }
        return {
          componentStockItemId: Number(requirement.component_item_id),
          componentTallyGuid: text(requirement.component_tally_guid),
          componentName: text(requirement.component_name),
          baseQuantity: Number(requirement.quantity_per_product ?? required) * Number(row.quantity),
          lossBufferPercent: Number(requirement.loss_buffer_percent ?? 0),
          requiredQuantity: required,
          reservedQuantity: Number(requirement.reserved_quantity),
          availableBeforeOrder,
          incomingQuantity: incomingAvailableForOrder,
          shortageNow: Math.max(0, required - availableBeforeOrder),
          shortageAfterIncoming: Math.max(0, required - projectedBeforeOrder),
        };
      });
      let feasibility: ProductOrder["feasibility"] = "BOM_INCOMPLETE";
      if (row.bom_version_id && requirements.length > 0) {
        if (requirements.every((line) => line.shortageNow === 0)) feasibility = "READY";
        else if (requirements.every((line) => line.shortageAfterIncoming === 0)) feasibility = "READY_WITH_INCOMING";
        else if (requirements.some((line) => line.shortageAfterIncoming >= line.requiredQuantity)) feasibility = "SHORT_COMPONENTS";
        else feasibility = "AT_RISK";
      }
      return {
        id: text(row.id),
        externalReference: text(row.external_reference),
        productStockItemId: Number(row.product_item_id),
        productTallyGuid: text(row.product_tally_guid),
        productName: text(row.product_name),
        quantity: Number(row.quantity),
        requiredDate: text(row.required_date),
        status: row.status,
        bomVersionId: row.bom_version_id ? text(row.bom_version_id) : null,
        bomVersionLabel: row.bom_version_id ? `${text(row.bom_label)} (v${row.bom_version_number})` : "No active BOM",
        feasibility,
        notes: text(row.notes),
        createdAt: text(row.created_at),
        updatedAt: text(row.updated_at),
        requirements,
      };
    });
  }

  private usageForItem(stockItemId: number, lookbackDays: number): number {
    const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN m.workflow = 'MATERIAL_OUT' THEN m.quantity
          WHEN a.direction = 'ADDITIONAL_OUT' THEN m.quantity
          WHEN a.direction = 'RETURN_TO_STOCK' THEN -m.quantity
          ELSE 0
        END
      ), 0) AS net_out
      FROM inventory_movements m
      LEFT JOIN inventory_adjustments a ON a.movement_id = m.id
      WHERE m.stock_item_id = ? AND m.event_date >= ?
    `).get(stockItemId, since) as Row;
    return Math.max(0, Number(row.net_out)) / lookbackDays;
  }

  private observedLeadTime(stockItemId: number, supplierId: number | null): number | null {
    const rows = this.db.prepare(`
      SELECT CAST(julianday(g.voucher_date) - julianday(po.voucher_date) AS INTEGER) AS days
      FROM grn_lines gl
      JOIN grns g ON g.id = gl.grn_id
      JOIN purchase_orders po ON po.id = g.purchase_order_id
      WHERE gl.stock_item_id = ?
        AND (? IS NULL OR g.supplier_id = ?)
        AND julianday(g.voucher_date) >= julianday(po.voucher_date)
      ORDER BY g.voucher_date DESC LIMIT 30
    `).all(stockItemId, supplierId, supplierId) as Row[];
    return median(rows.map((row) => Number(row.days)).filter((days) => Number.isFinite(days) && days >= 0));
  }

  private getPlanningItems(): RestockPlanningItem[] {
    const rows = this.db.prepare(`
      SELECT item.id, item.tally_guid,
        COALESCE(NULLIF(item.local_name_override, ''), item.name) AS name,
        item.parent_name, item.source, item.catalog_status,
        COALESCE(item.catalog_role_override, group_settings.catalog_role, 'OTHER') AS catalog_role,
        policy.planning_method, policy.reorder_point, policy.target_stock,
        policy.service_reserve, policy.preferred_supplier_id,
        supplier.name AS preferred_supplier_name, policy.lead_time_days,
        policy.safety_days, policy.minimum_order_quantity, policy.usage_lookback_days,
        policy.notes, policy.updated_by, policy.updated_at,
        recommendation.status AS recommendation_status,
        recommendation.approved_order_quantity,
        COALESCE((SELECT SUM(quantity_remaining) FROM purchase_lots WHERE stock_item_id = item.id), 0) AS on_hand,
        COALESCE((SELECT SUM(reserved_quantity) FROM planning_reservations WHERE component_item_id = item.id AND status = 'ACTIVE'), 0) AS reserved,
        COALESCE((SELECT SUM(pol.ordered_quantity - pol.received_quantity)
          FROM purchase_order_lines pol JOIN purchase_orders po ON po.id = pol.purchase_order_id
          WHERE pol.stock_item_id = item.id
            AND po.status <> 'CLOSED'
            AND pol.ordered_quantity > pol.received_quantity), 0) AS incoming
      FROM tally_stock_items item
      LEFT JOIN catalog_group_settings group_settings ON group_settings.group_name = item.parent_name COLLATE NOCASE
      LEFT JOIN planning_restock_policies policy ON policy.stock_item_id = item.id
      LEFT JOIN suppliers supplier ON supplier.id = policy.preferred_supplier_id
      LEFT JOIN planning_recommendations recommendation ON recommendation.stock_item_id = item.id
      WHERE item.active = 1
        AND item.catalog_ignored = 0
        AND COALESCE(group_settings.ignored, 0) = 0
        AND item.catalog_status <> 'DUPLICATE'
        AND (
          item.catalog_status <> 'OBSOLETE'
          OR EXISTS (
            SELECT 1 FROM purchase_lots stocked_lot
            WHERE stocked_lot.stock_item_id = item.id
              AND stocked_lot.quantity_remaining > 0
          )
        )
      ORDER BY item.name
    `).all() as Row[];
    return rows.map((row) => {
      const configured = row.planning_method != null;
      const lookbackDays = Number(row.usage_lookback_days ?? 90);
      const averageDailyUsage = this.usageForItem(Number(row.id), lookbackDays);
      const serviceReserve = Number(row.service_reserve ?? 0);
      const leadTimeDays = Number(row.lead_time_days ?? 0);
      const safetyDays = Number(row.safety_days ?? 0);
      const observedLeadTimeMedianDays = this.observedLeadTime(
        Number(row.id),
        row.preferred_supplier_id == null ? null : Number(row.preferred_supplier_id),
      );
      const effectiveLeadTimeDays = leadTimeDays > 0 ? leadTimeDays : (observedLeadTimeMedianDays ?? 0);
      const suggestedReorderPoint = Math.ceil(averageDailyUsage * (effectiveLeadTimeDays + safetyDays) + serviceReserve);
      const reorderPoint = Number(row.reorder_point ?? 0);
      const targetStock = Number(row.target_stock ?? 0);
      const onHand = Number(row.on_hand);
      const reserved = Number(row.reserved);
      const incoming = Number(row.incoming);
      const available = onHand - reserved - serviceReserve;
      const projected = available + incoming;
      const minimumOrderQuantity = Number(row.minimum_order_quantity ?? 0);
      const obsolete = text(row.catalog_status) === "OBSOLETE";
      const suggestedObsoleteTarget = Math.ceil(averageDailyUsage * 365 * 3.5);
      const yearsOfStock = averageDailyUsage > 0 ? onHand / (averageDailyUsage * 365) : null;
      let suggestedOrderQuantity = Math.max(0, targetStock - projected);
      if (obsolete) suggestedOrderQuantity = Math.max(0, targetStock - projected);
      if (suggestedOrderQuantity > 0 && minimumOrderQuantity > 0) {
        suggestedOrderQuantity = Math.max(suggestedOrderQuantity, minimumOrderQuantity);
      }
      let health: RestockHealth = "UNCONFIGURED";
      if (configured) {
        if (projected < 0) health = "CRITICAL";
        else if (projected <= reorderPoint) health = "REORDER_NOW";
        else if (projected <= reorderPoint + Math.max(1, Math.ceil(reorderPoint * 0.2))) health = "REORDER_SOON";
        else if (targetStock > 0 && projected > targetStock) health = "EXCESS";
        else health = "HEALTHY";
      }
      const warnings: string[] = [];
      if (!configured) warnings.push("Restock policy not configured.");
      if (configured && !row.preferred_supplier_id) warnings.push("Preferred supplier not set.");
      if (configured && leadTimeDays === 0) warnings.push("Supplier lead time not set.");
      if (obsolete && targetStock === 0) warnings.push("Obsolete item needs a target quantity for approximately 3–4 years of expected usage.");
      if (obsolete && yearsOfStock != null && (yearsOfStock < 3 || yearsOfStock > 4)) {
        warnings.push(`Current stock covers approximately ${yearsOfStock.toFixed(1)} years; the obsolete-stock goal is 3–4 years.`);
      }
      return {
        stockItemId: Number(row.id),
        tallyItemGuid: text(row.tally_guid),
        itemName: text(row.name),
        groupName: text(row.parent_name),
        catalogSource: row.source === "LOCAL" ? "LOCAL" : "TALLY",
        catalogStatus: obsolete ? "OBSOLETE" : "ACTIVE",
        catalogRole: text(row.catalog_role) as RestockPlanningItem["catalogRole"],
        planningMethod: row.planning_method ?? "MANUAL",
        reorderPoint,
        targetStock,
        serviceReserve,
        preferredSupplierId: row.preferred_supplier_id == null ? null : Number(row.preferred_supplier_id),
        preferredSupplierName: text(row.preferred_supplier_name),
        leadTimeDays,
        safetyDays,
        minimumOrderQuantity,
        usageLookbackDays: lookbackDays,
        notes: text(row.notes),
        updatedBy: text(row.updated_by),
        updatedAt: text(row.updated_at),
        onHand,
        reserved,
        available,
        incoming,
        projected,
        averageDailyUsage,
        yearsOfStock,
        suggestedObsoleteTarget,
        suggestedReorderPoint,
        effectiveLeadTimeDays,
        observedLeadTimeMedianDays,
        suggestedOrderQuantity,
        approvedOrderQuantity: row.approved_order_quantity == null ? null : Number(row.approved_order_quantity),
        recommendationStatus: row.recommendation_status ?? "SUGGESTED",
        health,
        dataWarnings: warnings,
      };
    });
  }

  getState(): PlanningState {
    this.ensureReady();
    const generatedAt = nowIso();
    const items = this.getPlanningItems();
    const boms = this.getBoms();
    const productOrders = this.getProductOrders();
    const tallySync = (this.db.prepare("SELECT value_json FROM settings WHERE key = 'last_tally_sync_at'").get() as Row | undefined)?.value_json;
    let tallySyncedAt: string | null = null;
    if (tallySync) {
      try { tallySyncedAt = JSON.parse(tallySync); } catch { tallySyncedAt = null; }
    }
    const tallyAgeDays = tallySyncedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(tallySyncedAt).valueOf()) / 86_400_000))
      : null;
    const freshness: PlanningFreshness = {
      localInventoryUpdatedAt: generatedAt,
      tallySyncedAt,
      tallyStale: tallyAgeDays == null || tallyAgeDays >= 2,
      tallyAgeDays,
      message: tallyAgeDays == null
        ? "Tally has not synchronized yet. Local inventory and reservations remain available."
        : tallyAgeDays >= 2
          ? `Tally last synchronized ${tallyAgeDays} days ago. Incoming Purchase Order quantities may be stale.`
          : "Local inventory is live. Tally purchasing data is recent.",
    };
    const summary: PlanningSummary = {
      critical: items.filter((item) => item.health === "CRITICAL").length,
      reorderNow: items.filter((item) => item.health === "REORDER_NOW").length,
      reorderSoon: items.filter((item) => item.health === "REORDER_SOON").length,
      healthy: items.filter((item) => item.health === "HEALTHY").length,
      excess: items.filter((item) => item.health === "EXCESS").length,
      unconfigured: items.filter((item) => item.health === "UNCONFIGURED").length,
      ordersAtRisk: productOrders.filter((order) => ["AT_RISK", "SHORT_COMPONENTS", "BOM_INCOMPLETE"].includes(order.feasibility) && order.status === "CONFIRMED").length,
      ordersReady: productOrders.filter((order) => ["READY", "READY_WITH_INCOMING"].includes(order.feasibility) && order.status === "CONFIRMED").length,
      missingBom: productOrders.filter((order) => order.feasibility === "BOM_INCOMPLETE" && order.status === "CONFIRMED").length,
    };
    return {
      moduleVersion: this.host.moduleVersion(MODULE_NAME),
      exportSchemaVersion: EXPORT_SCHEMA_VERSION,
      generatedAt,
      freshness,
      summary,
      items,
      boms,
      productOrders,
      groups: [...new Set(items.map((item) => item.groupName).filter(Boolean))].sort(),
    };
  }

  markRecommendationsExported(stockItemIds: number[], exportedAt: string): void {
    this.ensureReady();
    if (stockItemIds.length === 0) return;
    const statement = this.db.prepare(`
      UPDATE planning_recommendations SET status = 'EXPORTED', exported_at = ?, updated_at = ?
      WHERE stock_item_id = ?
    `);
    this.host.transaction("marking restock recommendations exported", () => {
      for (const id of stockItemIds) statement.run(exportedAt, exportedAt, id);
    });
  }

  recordExportBatch(input: {
    id: string;
    createdAt: string;
    createdBy: string;
    excelFilename: string;
    csvFilename: string;
    itemCount: number;
    payloadHash: string;
  }): void {
    this.ensureReady();
    this.db.prepare(`
      INSERT INTO planning_export_batches(
        id, schema_version, created_at, created_by, excel_filename, csv_filename, item_count, payload_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, EXPORT_SCHEMA_VERSION, input.createdAt, input.createdBy, input.excelFilename, input.csvFilename, input.itemCount, input.payloadHash);
  }
}
