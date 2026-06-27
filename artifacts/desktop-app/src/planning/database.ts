import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ApplicationDatabase, ApplicationDatabaseMigration } from "../database/application-database";
import type {
  ApprovalDecision,
  ApprovalRequest,
  BomLine,
  BomVersion,
  BulkProductOrderUpdateInput,
  ChecklistResult,
  ChecklistTemplate,
  CrfPayload,
  CrfRevision,
  PlanningFreshness,
  PlanningState,
  PlanningSummary,
  ProductOrder,
  ProductOrderType,
  ProductOrderFieldDefinition,
  ProductOrderRequirement,
  ProductOrderWorkflowState,
  RecommendationDecisionInput,
  RestockHealth,
  RestockPlanningItem,
  RestockPolicyInput,
  SalesOrder,
  SalesOrderFulfilmentLine,
  SalesOrderKind,
  SalesOrderSourceLine,
  SalesOrderStageHistory,
  SalesOrderStage,
  SalesOrderWorkflowStage,
  SaveSalesOrderInput,
  SaveSalesOrderWorkflowStageInput,
  SaveBomInput,
  SaveChecklistTemplateInput,
  SaveProductOrderFieldDefinitionInput,
  SaveProductOrderInput,
  SaveProductOrderWorkflowStateInput,
  SaveSalesOrderFulfilmentLineInput,
  TallySalesOrderImportLine,
} from "./types";
import type { ActorContext, Permission } from "../operations/types";
import { allPermissions } from "../operations/permissions";
import { formatQualifiedItemName, resolvePrimaryGroupFamily } from "../stores/item-family";
import { payloadHash } from "../database/hash";
import type { TallySalesOrder } from "../tally/types";
import {
  APPROVAL_PERMISSION_REQUIREMENTS,
  hasRejection,
  isApprovalSatisfied,
  pickQualifyingPermission,
  type ApprovalEntityType,
} from "./approvals";
import { resolveChecklistRequirement } from "./checklist";

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

function parseJsonSafe<T>(value: string, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function optionalDate(value: unknown): string {
  const normalized = text(value);
  if (!normalized) return "";
  return dateOnly(normalized);
}

function optionalNumber(value: unknown, label: string, whole = false): number | null {
  if (value == null || text(value) === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (whole && !Number.isInteger(parsed))) {
    throw new Error(`${label} must be ${whole ? "a whole number" : "a number"} that is zero or greater.`);
  }
  return parsed;
}

function fieldKey(value: unknown): string {
  return text(value)
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

function normalizedOrderType(value: unknown): ProductOrderType {
  return text(value).toLocaleUpperCase() === "SERVICE" ? "SERVICE" : "PRODUCTION";
}

function normalizedSalesOrderKind(value: unknown): SalesOrderKind {
  return text(value).toLocaleUpperCase() === "SERVICE" ? "SERVICE" : "SALES";
}

function workflowStageId(value: unknown): string {
  const raw = text(value);
  const normalized = raw
    .toLocaleUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || randomUUID();
}

// Resale and Raw Material fulfilment-line stages are fixed per the brief and
// validated in application code rather than a DB CHECK, since mixing all 4
// families' stage vocabularies into one constraint would be unreadable.
const RESALE_FULFILMENT_STAGES = [
  "pending-supplier", "pending-order", "awaiting-delivery", "items-received",
  "items-repackaged", "awaiting-dispatch", "dispatched", "crac-generated",
];
const RAW_MATERIAL_FULFILMENT_STAGES = [
  "awaiting-restock", "items-received", "awaiting-dispatch", "dispatched", "crac-generated",
];

export function warrantyStatusForSerial(
  serialNumberValue: string,
  orderCreatedAtValue: string,
): ProductOrder["warrantyStatus"] {
  const match = text(serialNumberValue).match(/^(\d{2})(0[1-9]|1[0-2])/);
  if (!match) return "OUT_OF_WARRANTY";
  const manufactureMonth = (2000 + Number(match[1])) * 12 + Number(match[2]) - 1;
  const createdAt = new Date(orderCreatedAtValue);
  if (Number.isNaN(createdAt.valueOf())) return "OUT_OF_WARRANTY";
  const orderMonth = createdAt.getUTCFullYear() * 12 + createdAt.getUTCMonth();
  const ageMonths = orderMonth - manufactureMonth;
  return ageMonths >= 0 && ageMonths <= 15 ? "IN_WARRANTY" : "OUT_OF_WARRANTY";
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
  {
    version: 2,
    description: "Add configurable production-order workflow and tracker fields",
    up(database: DatabaseSync) {
      database.exec(`
        CREATE TABLE planning_product_order_workflow_states (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          color TEXT NOT NULL,
          position INTEGER NOT NULL,
          terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1))
        ) STRICT;

        INSERT INTO planning_product_order_workflow_states(id, name, color, position, terminal) VALUES
          ('pending', 'Pending', '#6B778C', 1, 0),
          ('crf-pending', 'CRF Pending', '#9F7AEA', 2, 0),
          ('crf-sent', 'CRF Sent', '#6554C0', 3, 0),
          ('product-confirmation', 'Product Confirmation', '#0052CC', 4, 0),
          ('raw-material', 'Raw Material to be Procured', '#FF8B00', 5, 0),
          ('material-available', 'Material Available', '#00A3BF', 6, 0),
          ('in-production', 'In Production', '#0065FF', 7, 0),
          ('ready-dispatch', 'Ready for Dispatch', '#00875A', 8, 0),
          ('dispatched', 'Dispatched', '#36B37E', 9, 1),
          ('pending-material', 'Pending Material', '#DE350B', 10, 0),
          ('hold', 'Hold', '#97A0AF', 11, 0);

        ALTER TABLE planning_product_orders ADD COLUMN file_number TEXT NOT NULL DEFAULT '';
        ALTER TABLE planning_product_orders ADD COLUMN organisation TEXT NOT NULL DEFAULT '';
        ALTER TABLE planning_product_orders ADD COLUMN purchase_order_date TEXT NOT NULL DEFAULT '';
        ALTER TABLE planning_product_orders ADD COLUMN last_dispatch_date TEXT NOT NULL DEFAULT '';
        ALTER TABLE planning_product_orders ADD COLUMN pending_quantity INTEGER;
        ALTER TABLE planning_product_orders ADD COLUMN value_including_gst REAL;
        ALTER TABLE planning_product_orders ADD COLUMN pending_material TEXT NOT NULL DEFAULT '';
        ALTER TABLE planning_product_orders ADD COLUMN raw_material_to_order TEXT NOT NULL DEFAULT '';
        ALTER TABLE planning_product_orders ADD COLUMN crf_status TEXT NOT NULL DEFAULT '';
        ALTER TABLE planning_product_orders ADD COLUMN crac_status TEXT NOT NULL DEFAULT '';
        ALTER TABLE planning_product_orders ADD COLUMN task_remarks TEXT NOT NULL DEFAULT '';
        ALTER TABLE planning_product_orders ADD COLUMN responsible_person TEXT NOT NULL DEFAULT '';
        ALTER TABLE planning_product_orders ADD COLUMN follow_up_date TEXT NOT NULL DEFAULT '';
        ALTER TABLE planning_product_orders ADD COLUMN dispatch_schedule TEXT NOT NULL DEFAULT '';
        ALTER TABLE planning_product_orders ADD COLUMN priority TEXT NOT NULL DEFAULT '';
        ALTER TABLE planning_product_orders ADD COLUMN workflow_state_id TEXT REFERENCES planning_product_order_workflow_states(id);

        UPDATE planning_product_orders
        SET workflow_state_id = CASE
          WHEN status = 'COMPLETED' THEN 'dispatched'
          WHEN status = 'CANCELLED' THEN 'hold'
          ELSE 'pending'
        END;

        CREATE INDEX idx_planning_orders_workflow
          ON planning_product_orders(workflow_state_id, required_date);

        CREATE TABLE planning_product_order_field_definitions (
          id TEXT PRIMARY KEY,
          field_key TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL UNIQUE COLLATE NOCASE,
          field_type TEXT NOT NULL CHECK (field_type IN ('TEXT','NUMBER','DATE','BOOLEAN')),
          position INTEGER NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE planning_product_order_field_values (
          product_order_id TEXT NOT NULL REFERENCES planning_product_orders(id) ON DELETE CASCADE,
          field_id TEXT NOT NULL REFERENCES planning_product_order_field_definitions(id) ON DELETE CASCADE,
          value_json TEXT NOT NULL,
          PRIMARY KEY(product_order_id, field_id)
        ) STRICT;
      `);
    },
  },
  {
    version: 3,
    description: "Standardize the customer-order lifecycle and record time spent in every stage",
    up(database: DatabaseSync) {
      database.exec(`
        INSERT OR IGNORE INTO planning_product_order_workflow_states(id, name, color, position, terminal) VALUES
          ('po-pending', 'PO Pending', '#6B778C', 1, 0),
          ('po-generated', 'PO Generated', '#5268CA', 2, 0),
          ('crf-pending', 'CRF Pending', '#9F7AEA', 3, 0),
          ('crf-sent', 'CRF Sent', '#6554C0', 4, 0),
          ('material-planning', 'Material Planning', '#5268CA', 5, 0),
          ('material-purchase', 'Material Purchase', '#B7791F', 6, 0),
          ('quality-control', 'Quality Control', '#B7791F', 7, 0),
          ('pcb-soldering', 'PCB Soldering', '#246BCE', 8, 0),
          ('initial-testing', 'Initial Testing', '#246BCE', 9, 0),
          ('burn-test', 'Burn Test', '#246BCE', 10, 0),
          ('final-testing', 'Final Testing', '#246BCE', 11, 0),
          ('packing', 'Packing', '#246BCE', 12, 0),
          ('pending-dispatch', 'Pending Dispatch', '#B7791F', 13, 0),
          ('dispatched', 'Dispatched', '#23855B', 14, 1),
          ('crac-generated', 'CRAC Generated', '#23855B', 15, 1);

        UPDATE planning_product_order_workflow_states SET name = 'PO Pending', color = '#6B778C', position = 1, terminal = 0 WHERE id = 'po-pending';
        UPDATE planning_product_order_workflow_states SET name = 'PO Generated', color = '#5268CA', position = 2, terminal = 0 WHERE id = 'po-generated';
        UPDATE planning_product_order_workflow_states SET name = 'CRF Pending', color = '#9F7AEA', position = 3, terminal = 0 WHERE id = 'crf-pending';
        UPDATE planning_product_order_workflow_states SET name = 'CRF Sent', color = '#6554C0', position = 4, terminal = 0 WHERE id = 'crf-sent';
        UPDATE planning_product_order_workflow_states SET name = 'Material Planning', color = '#5268CA', position = 5, terminal = 0 WHERE id = 'material-planning';
        UPDATE planning_product_order_workflow_states SET name = 'Material Purchase', color = '#B7791F', position = 6, terminal = 0 WHERE id = 'material-purchase';
        UPDATE planning_product_order_workflow_states SET name = 'Quality Control', color = '#B7791F', position = 7, terminal = 0 WHERE id = 'quality-control';
        UPDATE planning_product_order_workflow_states SET name = 'PCB Soldering', color = '#246BCE', position = 8, terminal = 0 WHERE id = 'pcb-soldering';
        UPDATE planning_product_order_workflow_states SET name = 'Initial Testing', color = '#246BCE', position = 9, terminal = 0 WHERE id = 'initial-testing';
        UPDATE planning_product_order_workflow_states SET name = 'Burn Test', color = '#246BCE', position = 10, terminal = 0 WHERE id = 'burn-test';
        UPDATE planning_product_order_workflow_states SET name = 'Final Testing', color = '#246BCE', position = 11, terminal = 0 WHERE id = 'final-testing';
        UPDATE planning_product_order_workflow_states SET name = 'Packing', color = '#246BCE', position = 12, terminal = 0 WHERE id = 'packing';
        UPDATE planning_product_order_workflow_states SET name = 'Pending Dispatch', color = '#B7791F', position = 13, terminal = 0 WHERE id = 'pending-dispatch';
        UPDATE planning_product_order_workflow_states SET name = 'Dispatched', color = '#23855B', position = 14, terminal = 1 WHERE id = 'dispatched';
        UPDATE planning_product_order_workflow_states SET name = 'CRAC Generated', color = '#23855B', position = 15, terminal = 1 WHERE id = 'crac-generated';

        UPDATE planning_product_orders SET workflow_state_id = CASE workflow_state_id
          WHEN 'pending' THEN 'po-pending'
          WHEN 'product-confirmation' THEN 'po-generated'
          WHEN 'raw-material' THEN 'material-purchase'
          WHEN 'pending-material' THEN 'material-purchase'
          WHEN 'material-available' THEN 'material-planning'
          WHEN 'in-production' THEN 'pcb-soldering'
          WHEN 'ready-dispatch' THEN 'pending-dispatch'
          WHEN 'hold' THEN 'po-pending'
          ELSE workflow_state_id
        END;
        UPDATE planning_product_orders SET workflow_state_id = 'po-pending'
        WHERE workflow_state_id NOT IN (
          'po-pending','po-generated','crf-pending','crf-sent','material-planning',
          'material-purchase','quality-control','pcb-soldering','initial-testing',
          'burn-test','final-testing','packing','pending-dispatch','dispatched','crac-generated'
        ) OR workflow_state_id IS NULL;

        DELETE FROM planning_product_order_workflow_states WHERE id NOT IN (
          'po-pending','po-generated','crf-pending','crf-sent','material-planning',
          'material-purchase','quality-control','pcb-soldering','initial-testing',
          'burn-test','final-testing','packing','pending-dispatch','dispatched','crac-generated'
        );

        CREATE TABLE planning_product_order_stage_history (
          id TEXT PRIMARY KEY,
          product_order_id TEXT NOT NULL REFERENCES planning_product_orders(id) ON DELETE CASCADE,
          workflow_state_id TEXT NOT NULL REFERENCES planning_product_order_workflow_states(id),
          entered_at TEXT NOT NULL,
          exited_at TEXT
        ) STRICT;
        CREATE INDEX idx_planning_stage_history_state
          ON planning_product_order_stage_history(workflow_state_id, entered_at, exited_at);
        CREATE INDEX idx_planning_stage_history_order
          ON planning_product_order_stage_history(product_order_id, entered_at);

        INSERT INTO planning_product_order_stage_history(id, product_order_id, workflow_state_id, entered_at, exited_at)
        SELECT lower(hex(randomblob(16))), id, workflow_state_id, updated_at, NULL
        FROM planning_product_orders;
      `);
    },
  },
  {
    version: 4,
    description: "Add separately timed service orders, serial numbers, and warranty tracking",
    up(database: DatabaseSync) {
      database.exec(`
        ALTER TABLE planning_product_order_workflow_states
          ADD COLUMN order_type TEXT NOT NULL DEFAULT 'PRODUCTION'
          CHECK (order_type IN ('PRODUCTION','SERVICE'));
        ALTER TABLE planning_product_orders
          ADD COLUMN order_type TEXT NOT NULL DEFAULT 'PRODUCTION'
          CHECK (order_type IN ('PRODUCTION','SERVICE'));
        ALTER TABLE planning_product_orders
          ADD COLUMN serial_number TEXT NOT NULL DEFAULT '';

        INSERT INTO planning_product_order_workflow_states(id, name, color, position, terminal, order_type) VALUES
          ('service-incoming', 'Service · Incoming', '#6B778C', 101, 0, 'SERVICE'),
          ('service-estimation', 'Service · Estimation', '#5268CA', 102, 0, 'SERVICE'),
          ('service-estimate-approval', 'Service · Estimate Approval', '#9F7AEA', 103, 0, 'SERVICE'),
          ('service-fault-finding', 'Service · Fault Finding', '#246BCE', 104, 0, 'SERVICE'),
          ('service-initial-testing', 'Service · Initial Testing', '#246BCE', 105, 0, 'SERVICE'),
          ('service-burn-test', 'Service · Burn Test', '#246BCE', 106, 0, 'SERVICE'),
          ('service-final-testing', 'Service · Final Testing', '#246BCE', 107, 0, 'SERVICE'),
          ('service-payment', 'Service · Payment', '#B7791F', 108, 0, 'SERVICE'),
          ('service-dispatch', 'Service · Dispatch', '#23855B', 109, 1, 'SERVICE');

        DROP INDEX idx_planning_orders_reference;
        CREATE UNIQUE INDEX idx_planning_orders_reference
          ON planning_product_orders(external_reference, product_item_id, order_type, serial_number)
          WHERE external_reference <> '';
        CREATE INDEX idx_planning_orders_type
          ON planning_product_orders(order_type, status, required_date);
      `);
    },
  },
  {
    version: 5,
    description: "Record user-visible order activity",
    up(database: DatabaseSync) {
      database.exec(`
        CREATE TABLE planning_product_order_activity (
          id TEXT PRIMARY KEY,
          product_order_id TEXT NOT NULL REFERENCES planning_product_orders(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL CHECK (event_type IN ('CREATED','UPDATED','STAGE_CHANGED','STATUS_CHANGED','TALLY_IMPORTED')),
          actor_name TEXT NOT NULL DEFAULT '',
          actor_role TEXT NOT NULL DEFAULT '',
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_planning_order_activity
          ON planning_product_order_activity(product_order_id, created_at DESC);

        INSERT INTO planning_product_order_activity(
          id, product_order_id, event_type, actor_name, actor_role, summary, created_at
        )
        SELECT lower(hex(randomblob(16))), id, 'CREATED', 'System', 'SYSTEM',
          'Existing order added to activity history', created_at
        FROM planning_product_orders;
      `);
    },
  },
  {
    version: 6,
    description: "Add the Sales Order aggregate (header, read-only Tally source lines, fulfilment lines)",
    up(database: DatabaseSync) {
      database.exec(`
        CREATE TABLE planning_sales_orders (
          id TEXT PRIMARY KEY,
          tally_voucher_guid TEXT NOT NULL UNIQUE,
          customer_name TEXT NOT NULL DEFAULT '',
          customer_tally_guid TEXT NOT NULL DEFAULT '',
          po_reference TEXT NOT NULL DEFAULT '',
          po_value REAL,
          voucher_number TEXT NOT NULL DEFAULT '',
          voucher_date TEXT NOT NULL DEFAULT '',
          owner_user_id TEXT NOT NULL DEFAULT '',
          order_stage TEXT NOT NULL DEFAULT 'PENDING_PO_APPROVAL'
            CHECK (order_stage IN ('PENDING_PO_APPROVAL','CRF_PENDING','CRF_SENT','IN_FULFILMENT','COMPLETED')),
          source_snapshot_hash TEXT NOT NULL DEFAULT '',
          source_changed INTEGER NOT NULL DEFAULT 0 CHECK (source_changed IN (0,1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_sales_orders_stage ON planning_sales_orders(order_stage, updated_at);

        CREATE TABLE planning_sales_order_source_lines (
          id TEXT PRIMARY KEY,
          sales_order_id TEXT NOT NULL REFERENCES planning_sales_orders(id) ON DELETE CASCADE,
          tally_voucher_line_guid TEXT NOT NULL DEFAULT '',
          item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
          item_name_snapshot TEXT NOT NULL DEFAULT '',
          item_qualified_name_snapshot TEXT NOT NULL DEFAULT '',
          family TEXT NOT NULL DEFAULT 'UNKNOWN'
            CHECK (family IN ('MANUFACTURED','RESALE','SERVICE','RAW_MATERIAL','UNKNOWN')),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          value REAL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_sales_order_source_lines_order ON planning_sales_order_source_lines(sales_order_id);

        CREATE TABLE planning_sales_order_fulfilment_lines (
          id TEXT PRIMARY KEY,
          sales_order_id TEXT NOT NULL REFERENCES planning_sales_orders(id) ON DELETE CASCADE,
          parent_fulfilment_line_id TEXT REFERENCES planning_sales_order_fulfilment_lines(id) ON DELETE CASCADE,
          family TEXT NOT NULL CHECK (family IN ('MANUFACTURED','RESALE','SERVICE','RAW_MATERIAL')),
          item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          consumption_mode TEXT NOT NULL DEFAULT 'SOLD_DIRECT'
            CHECK (consumption_mode IN ('SOLD_DIRECT','INTERNAL_CONSUMPTION')),
          stage TEXT NOT NULL DEFAULT '',
          service_done INTEGER NOT NULL DEFAULT 0 CHECK (service_done IN (0,1)),
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_sales_order_fulfilment_lines_order ON planning_sales_order_fulfilment_lines(sales_order_id);
        CREATE INDEX idx_sales_order_fulfilment_lines_parent ON planning_sales_order_fulfilment_lines(parent_fulfilment_line_id);

        CREATE TABLE planning_sales_order_stage_history (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('ORDER','FULFILMENT_LINE')),
          scope_id TEXT NOT NULL,
          stage TEXT NOT NULL,
          entered_at TEXT NOT NULL,
          exited_at TEXT
        ) STRICT;
        CREATE INDEX idx_sales_order_stage_history_scope ON planning_sales_order_stage_history(scope, scope_id, entered_at);

        CREATE TABLE planning_sales_order_resale_suppliers (
          fulfilment_line_id TEXT PRIMARY KEY REFERENCES planning_sales_order_fulfilment_lines(id) ON DELETE CASCADE,
          supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
          assigned_at TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 7,
    description: "Add the dual-approval engine and checklist engine for Sales Orders",
    up(database: DatabaseSync) {
      database.exec(`
        CREATE TABLE approval_requests (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL CHECK (entity_type IN ('SALES_ORDER_PO','SALES_ORDER_CRF')),
          entity_id TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED')),
          created_by_user_id TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          superseded_by_request_id TEXT REFERENCES approval_requests(id)
        ) STRICT;
        CREATE INDEX idx_approval_requests_entity ON approval_requests(entity_type, entity_id, status);

        CREATE TABLE approval_decisions (
          id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
          decided_by_user_id TEXT NOT NULL,
          decided_by_name TEXT NOT NULL DEFAULT '',
          decided_by_role TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
          comment TEXT NOT NULL DEFAULT '',
          payload_hash_at_decision TEXT NOT NULL DEFAULT '',
          decided_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_approval_decisions_request ON approval_decisions(request_id);

        CREATE TABLE checklist_templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          version INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
          created_at TEXT NOT NULL,
          UNIQUE(name, version)
        ) STRICT;

        CREATE TABLE checklist_requirements (
          id TEXT PRIMARY KEY,
          template_id TEXT NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
          target_type TEXT NOT NULL CHECK (target_type IN (
            'EXACT_ITEM','GROUP_SUBTREE','PRIMARY_GROUP','TOP_LEVEL_LINES',
            'CHILDREN_OF_MANUFACTURED','EACH_MANUFACTURED_PRODUCT'
          )),
          target_value TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT ''
        ) STRICT;
        CREATE INDEX idx_checklist_requirements_template ON checklist_requirements(template_id);

        CREATE TABLE checklist_results (
          id TEXT PRIMARY KEY,
          sales_order_id TEXT NOT NULL REFERENCES planning_sales_orders(id) ON DELETE CASCADE,
          requirement_id TEXT NOT NULL REFERENCES checklist_requirements(id),
          template_id TEXT NOT NULL REFERENCES checklist_templates(id),
          status TEXT NOT NULL CHECK (status IN ('SATISFIED','WAIVED')),
          waiver_reason TEXT NOT NULL DEFAULT '',
          waiver_actor_user_id TEXT NOT NULL DEFAULT '',
          waiver_actor_name TEXT NOT NULL DEFAULT '',
          waiver_role TEXT NOT NULL DEFAULT '',
          waiver_at TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_checklist_results_order ON checklist_results(sales_order_id);
      `);
    },
  },
  {
    version: 8,
    description: "Add CRF revisions and Tally source-amendment tracking for Sales Orders",
    up(database: DatabaseSync) {
      database.exec(`
        CREATE TABLE crf_revisions (
          id TEXT PRIMARY KEY,
          sales_order_id TEXT NOT NULL REFERENCES planning_sales_orders(id) ON DELETE CASCADE,
          revision_number INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          superseded_at TEXT,
          UNIQUE(sales_order_id, revision_number)
        ) STRICT;
        CREATE INDEX idx_crf_revisions_order ON crf_revisions(sales_order_id, revision_number DESC);

        CREATE TABLE planning_sales_order_source_amendments (
          id TEXT PRIMARY KEY,
          sales_order_id TEXT NOT NULL REFERENCES planning_sales_orders(id) ON DELETE CASCADE,
          new_source_lines_json TEXT NOT NULL,
          diff_summary TEXT NOT NULL DEFAULT '',
          detected_at TEXT NOT NULL,
          applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0,1)),
          applied_at TEXT
        ) STRICT;
        CREATE INDEX idx_sales_order_amendments_order ON planning_sales_order_source_amendments(sales_order_id, applied);
      `);
    },
  },
  {
    version: 9,
    description: "Add a promised dispatch / due date to Sales Orders so they can be sorted alongside Service Orders",
    up(database: DatabaseSync) {
      database.exec(`
        ALTER TABLE planning_sales_orders ADD COLUMN due_date TEXT NOT NULL DEFAULT '';
      `);
    },
  },
  {
    version: 10,
    description: "Pin each approval decision to the exact permission slot it fills, so custom roles work correctly",
    up(database: DatabaseSync) {
      database.exec(`
        ALTER TABLE approval_decisions ADD COLUMN qualifying_permission TEXT NOT NULL DEFAULT '';
      `);
      // Best-effort backfill for existing decisions: the original system only
      // had ACCOUNTS/SALES roles, which map 1:1 to the two CRF permission
      // slots (PO approval only ever had one slot, ACCOUNTS).
      database.exec(`
        UPDATE approval_decisions SET qualifying_permission = 'SALES_ORDER_APPROVE_PO'
        WHERE qualifying_permission = '' AND decided_by_role = 'ACCOUNTS'
          AND request_id IN (SELECT id FROM approval_requests WHERE entity_type = 'SALES_ORDER_PO');
        UPDATE approval_decisions SET qualifying_permission = 'SALES_ORDER_APPROVE_CRF_ACCOUNTS'
        WHERE qualifying_permission = '' AND decided_by_role = 'ACCOUNTS'
          AND request_id IN (SELECT id FROM approval_requests WHERE entity_type = 'SALES_ORDER_CRF');
        UPDATE approval_decisions SET qualifying_permission = 'SALES_ORDER_APPROVE_CRF_SALES'
        WHERE qualifying_permission = '' AND decided_by_role = 'SALES'
          AND request_id IN (SELECT id FROM approval_requests WHERE entity_type = 'SALES_ORDER_CRF');
      `);
    },
  },
  {
    version: 11,
    description: "Add an independent hold/cancel status to Sales Orders and fulfilment lines, and allow Product Orders to go on hold",
    up(database: DatabaseSync) {
      database.exec(`
        ALTER TABLE planning_sales_orders ADD COLUMN hold_status TEXT NOT NULL DEFAULT 'NONE'
          CHECK (hold_status IN ('NONE','ON_HOLD','CANCELLED'));
        ALTER TABLE planning_sales_order_fulfilment_lines ADD COLUMN hold_status TEXT NOT NULL DEFAULT 'NONE'
          CHECK (hold_status IN ('NONE','ON_HOLD','CANCELLED'));

        CREATE TABLE planning_product_orders_new (
          id TEXT PRIMARY KEY,
          external_reference TEXT NOT NULL DEFAULT '',
          product_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          required_date TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('DRAFT','CONFIRMED','ON_HOLD','CANCELLED','COMPLETED')),
          bom_version_id TEXT REFERENCES planning_bom_versions(id),
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          file_number TEXT NOT NULL DEFAULT '',
          organisation TEXT NOT NULL DEFAULT '',
          purchase_order_date TEXT NOT NULL DEFAULT '',
          last_dispatch_date TEXT NOT NULL DEFAULT '',
          pending_quantity INTEGER,
          value_including_gst REAL,
          pending_material TEXT NOT NULL DEFAULT '',
          raw_material_to_order TEXT NOT NULL DEFAULT '',
          crf_status TEXT NOT NULL DEFAULT '',
          crac_status TEXT NOT NULL DEFAULT '',
          task_remarks TEXT NOT NULL DEFAULT '',
          responsible_person TEXT NOT NULL DEFAULT '',
          follow_up_date TEXT NOT NULL DEFAULT '',
          dispatch_schedule TEXT NOT NULL DEFAULT '',
          priority TEXT NOT NULL DEFAULT '',
          workflow_state_id TEXT REFERENCES planning_product_order_workflow_states(id),
          order_type TEXT NOT NULL DEFAULT 'PRODUCTION' CHECK (order_type IN ('PRODUCTION','SERVICE')),
          serial_number TEXT NOT NULL DEFAULT ''
        ) STRICT;
        INSERT INTO planning_product_orders_new SELECT
          id, external_reference, product_item_id, quantity, required_date, status, bom_version_id, notes,
          created_at, updated_at, file_number, organisation, purchase_order_date, last_dispatch_date,
          pending_quantity, value_including_gst, pending_material, raw_material_to_order, crf_status, crac_status,
          task_remarks, responsible_person, follow_up_date, dispatch_schedule, priority, workflow_state_id,
          order_type, serial_number
        FROM planning_product_orders;
        DROP TABLE planning_product_orders;
        ALTER TABLE planning_product_orders_new RENAME TO planning_product_orders;
        CREATE UNIQUE INDEX idx_planning_orders_reference
          ON planning_product_orders(external_reference, product_item_id, order_type, serial_number)
          WHERE external_reference <> '';
        CREATE INDEX idx_planning_orders_status ON planning_product_orders(status, required_date);
        CREATE INDEX idx_planning_orders_workflow ON planning_product_orders(workflow_state_id, required_date);
        CREATE INDEX idx_planning_orders_type ON planning_product_orders(order_type, status, required_date);
      `);
    },
  },
  {
    version: 12,
    description: "Make Sales Order creation and workflow stages configurable by order kind",
    up(database: DatabaseSync) {
      database.exec(`
        CREATE TABLE planning_sales_orders_new (
          id TEXT PRIMARY KEY,
          order_kind TEXT NOT NULL DEFAULT 'SALES' CHECK (order_kind IN ('SALES','SERVICE')),
          tally_voucher_guid TEXT NOT NULL UNIQUE,
          customer_name TEXT NOT NULL DEFAULT '',
          customer_tally_guid TEXT NOT NULL DEFAULT '',
          po_reference TEXT NOT NULL DEFAULT '',
          po_value REAL,
          voucher_number TEXT NOT NULL DEFAULT '',
          voucher_date TEXT NOT NULL DEFAULT '',
          due_date TEXT NOT NULL DEFAULT '',
          owner_user_id TEXT NOT NULL DEFAULT '',
          order_stage TEXT NOT NULL DEFAULT 'PENDING_PO_APPROVAL',
          hold_status TEXT NOT NULL DEFAULT 'NONE' CHECK (hold_status IN ('NONE','ON_HOLD','CANCELLED')),
          source_snapshot_hash TEXT NOT NULL DEFAULT '',
          source_changed INTEGER NOT NULL DEFAULT 0 CHECK (source_changed IN (0,1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO planning_sales_orders_new(
          id, order_kind, tally_voucher_guid, customer_name, customer_tally_guid, po_reference,
          po_value, voucher_number, voucher_date, due_date, owner_user_id, order_stage, hold_status,
          source_snapshot_hash, source_changed, created_at, updated_at
        )
        SELECT
          id, 'SALES', tally_voucher_guid, customer_name, customer_tally_guid, po_reference,
          po_value, voucher_number, voucher_date, due_date, owner_user_id, order_stage, hold_status,
          source_snapshot_hash, source_changed, created_at, updated_at
        FROM planning_sales_orders;
        DROP TABLE planning_sales_orders;
        ALTER TABLE planning_sales_orders_new RENAME TO planning_sales_orders;
        CREATE INDEX idx_sales_orders_stage ON planning_sales_orders(order_stage, updated_at);
        CREATE INDEX idx_sales_orders_kind ON planning_sales_orders(order_kind, updated_at);

        CREATE TABLE approval_requests_new (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          target_stage TEXT NOT NULL DEFAULT '',
          payload_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','SUPERSEDED')),
          created_by_user_id TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          superseded_by_request_id TEXT REFERENCES approval_requests(id)
        ) STRICT;
        INSERT INTO approval_requests_new(
          id, entity_type, entity_id, target_stage, payload_hash, status, created_by_user_id, created_at, superseded_by_request_id
        )
        SELECT
          id, entity_type, entity_id,
          CASE entity_type
            WHEN 'SALES_ORDER_PO' THEN 'CRF_PENDING'
            WHEN 'SALES_ORDER_CRF' THEN 'IN_FULFILMENT'
            ELSE ''
          END,
          payload_hash, status, created_by_user_id, created_at, superseded_by_request_id
        FROM approval_requests;
        DROP TABLE approval_requests;
        ALTER TABLE approval_requests_new RENAME TO approval_requests;
        CREATE INDEX idx_approval_requests_entity ON approval_requests(entity_type, entity_id, status);

        CREATE TABLE planning_sales_order_workflow_stages (
          id TEXT NOT NULL,
          order_kind TEXT NOT NULL DEFAULT 'SALES' CHECK (order_kind IN ('SALES','SERVICE')),
          stock_group_name TEXT NOT NULL DEFAULT '',
          name TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '#6B778C',
          position INTEGER NOT NULL,
          terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0,1)),
          required_permissions_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(id, order_kind, stock_group_name)
        ) STRICT;
      `);
      const timestamp = nowIso();
      const insert = database.prepare(`
        INSERT INTO planning_sales_order_workflow_stages(
          id, order_kind, stock_group_name, name, color, position, terminal, required_permissions_json, created_at, updated_at
        ) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?)
      `);
      const defaults: Array<[string, SalesOrderKind, string, string, number, number, Permission[]]> = [
        ["PENDING_PO_APPROVAL", "SALES", "PO Approval", "#6B778C", 1, 0, []],
        ["CRF_PENDING", "SALES", "CRF Pending", "#9F7AEA", 2, 0, ["SALES_ORDER_APPROVE_PO"]],
        ["CRF_SENT", "SALES", "CRF Sent", "#6554C0", 3, 0, []],
        ["IN_FULFILMENT", "SALES", "In Fulfilment", "#246BCE", 4, 0, ["SALES_ORDER_APPROVE_CRF_ACCOUNTS", "SALES_ORDER_APPROVE_CRF_SALES"]],
        ["COMPLETED", "SALES", "Completed", "#23855B", 5, 1, []],
        ["PENDING_PO_APPROVAL", "SERVICE", "Service Order Entered", "#6B778C", 1, 0, []],
        ["CRF_PENDING", "SERVICE", "Service Scope Pending", "#9F7AEA", 2, 0, ["SALES_ORDER_APPROVE_PO"]],
        ["CRF_SENT", "SERVICE", "Service Scope Sent", "#6554C0", 3, 0, []],
        ["IN_FULFILMENT", "SERVICE", "Service Execution", "#246BCE", 4, 0, ["SALES_ORDER_APPROVE_CRF_ACCOUNTS", "SALES_ORDER_APPROVE_CRF_SALES"]],
        ["COMPLETED", "SERVICE", "Completed", "#23855B", 5, 1, []],
      ];
      for (const [id, kind, name, color, position, terminal, permissions] of defaults) {
        insert.run(id, kind, name, color, position, terminal, JSON.stringify(permissions), timestamp, timestamp);
      }
    },
  },
  {
    version: 13,
    description: "Allow item workflow stages to be scoped by Stock Group and gated by permissions",
    up(database: DatabaseSync) {
      database.exec(`
        ALTER TABLE planning_product_order_workflow_states ADD COLUMN stock_group_name TEXT NOT NULL DEFAULT '';
        ALTER TABLE planning_product_order_workflow_states ADD COLUMN required_permissions_json TEXT NOT NULL DEFAULT '[]';
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
    // Migration 11 recreates planning_product_orders (SQLite can't widen a CHECK
    // constraint in place), which has FK children (reservations, stage history,
    // activity) — foreign_keys must be off while the parent table is briefly
    // gone, and can only be toggled outside an active transaction.
    this.host.db.exec("PRAGMA foreign_keys = OFF");
    let version: number;
    try {
      version = this.host.migrateModule(MODULE_NAME, migrations, this.beforeMigration);
    } finally {
      this.host.db.exec("PRAGMA foreign_keys = ON");
    }
    this.syncMissingTallyBoms();
    return version;
  }

  get db(): DatabaseSync {
    return this.host.db;
  }

  private recordOrderActivity(
    orderId: string,
    eventType: ProductOrder["activity"][number]["eventType"],
    summary: string,
    actor?: ActorContext,
  ): void {
    this.db.prepare(`
      INSERT INTO planning_product_order_activity(
        id, product_order_id, event_type, actor_name, actor_role, summary, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      orderId,
      eventType,
      actor?.displayName ?? "System",
      actor?.role ?? "SYSTEM",
      summary,
      nowIso(),
    );
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

  private workflowStageAppliesToItem(stage: Row, itemId: number): boolean {
    const stockGroupName = text(stage.stock_group_name);
    if (!stockGroupName) return true;
    const item = this.db.prepare("SELECT parent_name FROM tally_stock_items WHERE id = ?").get(itemId) as Row | undefined;
    if (!item) return false;
    return this.resolveGroupPath(text(item.parent_name)).includes(stockGroupName);
  }

  private requireWorkflowStagePermissions(stage: Row, actor?: ActorContext): void {
    const requiredPermissions = parseJsonSafe<string[]>(text(stage.required_permissions_json), [])
      .filter((permission): permission is Permission => allPermissions.includes(permission as Permission));
    if (requiredPermissions.length === 0) return;
    if (!actor?.permissions?.some((permission) => requiredPermissions.includes(permission))) {
      throw new Error(`Moving to ${text(stage.name)} requires one of these permissions: ${requiredPermissions.join(", ")}.`);
    }
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
      const automaticVersion = Number((this.db.prepare(`
        SELECT COALESCE(MAX(version_number), 0) + 1 AS version
        FROM planning_bom_versions WHERE product_item_id = ?
      `).get(product.id) as Row).version);
      const requestedVersion = input.versionNumber == null
        ? automaticVersion
        : wholeNumber(input.versionNumber, "BOM version", false);
      const existingVersion = this.db.prepare(`
        SELECT 1 FROM planning_bom_versions
        WHERE product_item_id = ? AND version_number = ?
      `).get(product.id, requestedVersion);
      if (existingVersion) {
        throw new Error(`BOM version ${requestedVersion} already exists for ${text(product.name)}.`);
      }
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
        requestedVersion,
        text(input.label) || `BOM v${requestedVersion}`,
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

  saveProductOrderWorkflowState(input: SaveProductOrderWorkflowStateInput): ProductOrderWorkflowState {
    this.ensureReady();
    const orderType = normalizedOrderType(input.orderType);
    const stockGroupName = text(input.stockGroupName);
    const name = text(input.name);
    if (!name) throw new Error("Stage name is required.");
    const requiredPermissions = [...new Set((input.requiredPermissions ?? []).map((permission) => text(permission)).filter(Boolean))];
    const unknown = requiredPermissions.find((permission) => !allPermissions.includes(permission as Permission));
    if (unknown) throw new Error(`Unknown approval permission: ${unknown}.`);
    const id = input.id
      ? workflowStageId(input.id).toLocaleLowerCase().replaceAll("_", "-")
      : workflowStageId(stockGroupName ? `${stockGroupName}-${name}` : name).toLocaleLowerCase().replaceAll("_", "-");
    const position = input.position == null
      ? Number((this.db.prepare(`
        SELECT COALESCE(MAX(position), 0) + 1 AS next_position
        FROM planning_product_order_workflow_states
        WHERE order_type = ? AND stock_group_name = ?
      `).get(orderType, stockGroupName) as Row).next_position)
      : wholeNumber(input.position, "Stage position", false);
    this.db.prepare(`
      INSERT INTO planning_product_order_workflow_states(
        id, name, color, position, terminal, order_type, stock_group_name, required_permissions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        color = excluded.color,
        position = excluded.position,
        terminal = excluded.terminal,
        order_type = excluded.order_type,
        stock_group_name = excluded.stock_group_name,
        required_permissions_json = excluded.required_permissions_json
    `).run(
      id, name, text(input.color) || "#6B778C", position, input.terminal ? 1 : 0,
      orderType, stockGroupName, json(requiredPermissions),
    );
    return this.getProductOrderWorkflowStates().find((stage) => stage.id === id)!;
  }

  deleteProductOrderWorkflowState(stateIdValue: string): void {
    this.ensureReady();
    const stateId = text(stateIdValue);
    const state = this.db.prepare(`
      SELECT id, name, order_type, stock_group_name
      FROM planning_product_order_workflow_states
      WHERE id = ?
    `).get(stateId) as Row | undefined;
    if (!state) throw new Error("Stage not found.");
    const currentOrders = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM planning_product_orders WHERE workflow_state_id = ?
    `).get(stateId) as Row).count);
    const orderHistory = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM planning_product_order_stage_history WHERE workflow_state_id = ?
    `).get(stateId) as Row).count);
    const fulfilmentLines = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM planning_sales_order_fulfilment_lines WHERE stage = ?
    `).get(stateId) as Row).count);
    const fulfilmentHistory = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM planning_sales_order_stage_history
      WHERE scope = 'FULFILMENT_LINE' AND stage = ?
    `).get(stateId) as Row).count);
    const approvals = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM approval_requests WHERE target_stage = ?
    `).get(stateId) as Row).count);
    if (currentOrders || orderHistory || fulfilmentLines || fulfilmentHistory || approvals) {
      throw new Error("This item stage is already used by orders, history, or approvals, so it cannot be deleted.");
    }
    const peers = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM planning_product_order_workflow_states
      WHERE order_type = ? AND stock_group_name = ?
    `).get(text(state.order_type), text(state.stock_group_name)) as Row).count);
    if (!text(state.stock_group_name) && peers <= 1) throw new Error("Keep at least one item stage in the default workflow.");
    this.db.prepare("DELETE FROM planning_product_order_workflow_states WHERE id = ?").run(stateId);
  }

  saveProductOrderFieldDefinition(input: SaveProductOrderFieldDefinitionInput): ProductOrderFieldDefinition {
    this.ensureReady();
    const label = text(input.label);
    if (!label) throw new Error("Enter a field label.");
    const key = fieldKey(label);
    if (!key) throw new Error("Enter a field label containing letters or numbers.");
    const allowed = ["TEXT", "NUMBER", "DATE", "BOOLEAN"];
    const type = allowed.includes(input.type) ? input.type : "TEXT";
    const existing = this.db.prepare(`
      SELECT 1 FROM planning_product_order_field_definitions
      WHERE field_key = ? OR label = ? COLLATE NOCASE
    `).get(key, label);
    if (existing) throw new Error("A custom field with this label already exists.");
    const id = randomUUID();
    const position = Number((this.db.prepare(`
      SELECT COALESCE(MAX(position), 0) + 1 AS position FROM planning_product_order_field_definitions
    `).get() as Row).position);
    this.db.prepare(`
      INSERT INTO planning_product_order_field_definitions(
        id, field_key, label, field_type, position, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, key, label, type, position, nowIso());
    return this.getProductOrderFieldDefinitions().find((field) => field.id === id)!;
  }

  deleteProductOrderFieldDefinition(fieldIdValue: string): void {
    this.ensureReady();
    const fieldId = text(fieldIdValue);
    const field = this.db.prepare(`
      SELECT id FROM planning_product_order_field_definitions WHERE id = ?
    `).get(fieldId);
    if (!field) throw new Error("Custom field not found.");
    this.host.transaction("deleting a production order custom field", () => {
      this.db.prepare("DELETE FROM planning_product_order_field_definitions WHERE id = ?").run(fieldId);
      this.db.prepare(`
        UPDATE planning_product_order_field_definitions
        SET position = (
          SELECT COUNT(*) FROM planning_product_order_field_definitions earlier
          WHERE earlier.position <= planning_product_order_field_definitions.position
        )
      `).run();
    });
  }

  updateProductOrderWorkflowState(orderId: string, workflowStateId: string, actor?: ActorContext): void {
    this.ensureReady();
    const state = this.db.prepare(`
      SELECT id, name, order_type, stock_group_name, required_permissions_json FROM planning_product_order_workflow_states WHERE id = ?
    `).get(text(workflowStateId)) as Row | undefined;
    if (!state) throw new Error("Workflow state not found.");
    const order = this.db.prepare(`
      SELECT workflow_state_id, order_type, product_item_id FROM planning_product_orders WHERE id = ?
    `).get(text(orderId)) as Row | undefined;
    if (!order) throw new Error("Product order not found.");
    if (normalizedOrderType(order.order_type) !== normalizedOrderType(state.order_type)) {
      throw new Error("Choose a stage belonging to this order type.");
    }
    if (!this.workflowStageAppliesToItem(state, Number(order.product_item_id))) {
      throw new Error("Choose a stage configured for this item's Stock Group.");
    }
    this.requireWorkflowStagePermissions(state, actor);
    if (normalizedOrderType(order.order_type) === "PRODUCTION" && text(state.id) === "quality-control" && !this.db.prepare(`
      SELECT 1 FROM planning_product_order_stage_history
      WHERE product_order_id = ? AND workflow_state_id = 'material-purchase'
    `).get(text(orderId))) {
      throw new Error("Quality Control is available only after the order has entered Material Purchase.");
    }
    this.host.transaction("updating an order stage", () => {
      if (text(order.workflow_state_id) === text(state.id)) return;
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE planning_product_order_stage_history SET exited_at = ?
        WHERE product_order_id = ? AND exited_at IS NULL
      `).run(timestamp, text(orderId));
      this.db.prepare(`
        INSERT INTO planning_product_order_stage_history(id, product_order_id, workflow_state_id, entered_at)
        VALUES (?, ?, ?, ?)
      `).run(randomUUID(), text(orderId), state.id, timestamp);
      this.db.prepare(`
        UPDATE planning_product_orders SET workflow_state_id = ?, updated_at = ? WHERE id = ?
      `).run(state.id, timestamp, text(orderId));
      const stateName = text((this.db.prepare(
        "SELECT name FROM planning_product_order_workflow_states WHERE id = ?",
      ).get(state.id) as Row | undefined)?.name);
      this.recordOrderActivity(text(orderId), "STAGE_CHANGED", `Stage changed to ${stateName}`, actor);
    });
  }

  saveProductOrder(input: SaveProductOrderInput, actor?: ActorContext, activityType?: "TALLY_IMPORTED"): ProductOrder {
    this.ensureReady();
    const product = this.stockItemByGuid(input.productTallyGuid);
    const orderType = normalizedOrderType(input.orderType);
    const serialNumber = text(input.serialNumber);
    if (orderType === "SERVICE" && !/^(\d{2})(0[1-9]|1[0-2])/.test(serialNumber)) {
      throw new Error("Service Order Serial No must begin with a valid YYMM manufacturing date.");
    }
    const quantity = wholeNumber(input.quantity, "Product order quantity", false);
    const status = input.status === "DRAFT" ? "DRAFT" : "CONFIRMED";
    const suppliedId = text(input.id);
    const externalReference = text(input.externalReference);
    const matchingReference = !suppliedId && externalReference
      ? this.db.prepare(`
          SELECT id FROM planning_product_orders
          WHERE external_reference = ? AND product_item_id = ?
            AND order_type = ? AND serial_number = ?
        `).get(externalReference, product.id, orderType, serialNumber) as Row | undefined
      : undefined;
    const orderId = suppliedId || text(matchingReference?.id) || randomUUID();
    const timestamp = nowIso();

    this.host.transaction("saving a product order and reservations", () => {
      const existing = this.db.prepare("SELECT * FROM planning_product_orders WHERE id = ?").get(orderId) as Row | undefined;
      if (existing && normalizedOrderType(existing.order_type) !== orderType) {
        throw new Error("An existing order cannot be changed between Production and Service.");
      }
      const bom = orderType === "PRODUCTION" ? this.activeBomForProduct(Number(product.id)) : null;
      const workflowStateId = text(input.workflowStateId)
        || text(existing?.workflow_state_id)
        || text((this.db.prepare(`
          SELECT id FROM planning_product_order_workflow_states
          WHERE order_type = ? AND stock_group_name = '' ORDER BY position LIMIT 1
        `).get(orderType) as Row | undefined)?.id);
      const workflowState = this.db.prepare(`
        SELECT id, name, order_type, stock_group_name, required_permissions_json FROM planning_product_order_workflow_states WHERE id = ?
      `).get(workflowStateId) as Row | undefined;
      if (!workflowState || normalizedOrderType(workflowState.order_type) !== orderType) {
        throw new Error("Choose a valid workflow state.");
      }
      if (!this.workflowStageAppliesToItem(workflowState, Number(product.id))) {
        throw new Error("Choose a stage configured for this item's Stock Group.");
      }
      this.requireWorkflowStagePermissions(workflowState, actor);
      if (orderType === "PRODUCTION" && workflowStateId === "quality-control" && !this.db.prepare(`
        SELECT 1 FROM planning_product_order_stage_history
        WHERE product_order_id = ? AND workflow_state_id = 'material-purchase'
      `).get(orderId)) {
        throw new Error("Quality Control is available only after the order has entered Material Purchase.");
      }
      this.db.prepare(`
        INSERT INTO planning_product_orders(
          id, external_reference, product_item_id, quantity, required_date, status,
          bom_version_id, notes, created_at, updated_at, file_number, organisation,
          purchase_order_date, last_dispatch_date, pending_quantity, value_including_gst,
          pending_material, raw_material_to_order, crf_status, crac_status, task_remarks,
          responsible_person, follow_up_date, dispatch_schedule, priority, workflow_state_id,
          order_type, serial_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          external_reference = excluded.external_reference,
          product_item_id = excluded.product_item_id,
          quantity = excluded.quantity,
          required_date = excluded.required_date,
          status = excluded.status,
          bom_version_id = excluded.bom_version_id,
          notes = excluded.notes,
          file_number = excluded.file_number,
          organisation = excluded.organisation,
          purchase_order_date = excluded.purchase_order_date,
          last_dispatch_date = excluded.last_dispatch_date,
          pending_quantity = excluded.pending_quantity,
          value_including_gst = excluded.value_including_gst,
          pending_material = excluded.pending_material,
          raw_material_to_order = excluded.raw_material_to_order,
          crf_status = excluded.crf_status,
          crac_status = excluded.crac_status,
          task_remarks = excluded.task_remarks,
          responsible_person = excluded.responsible_person,
          follow_up_date = excluded.follow_up_date,
          dispatch_schedule = excluded.dispatch_schedule,
          priority = excluded.priority,
          workflow_state_id = excluded.workflow_state_id,
          serial_number = excluded.serial_number,
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
        input.fileNumber === undefined ? text(existing?.file_number) : text(input.fileNumber),
        input.organisation === undefined ? text(existing?.organisation) : text(input.organisation),
        input.purchaseOrderDate === undefined ? text(existing?.purchase_order_date) : optionalDate(input.purchaseOrderDate),
        input.lastDispatchDate === undefined ? text(existing?.last_dispatch_date) : optionalDate(input.lastDispatchDate),
        input.pendingQuantity === undefined ? (existing?.pending_quantity ?? null) : optionalNumber(input.pendingQuantity, "Pending quantity", true),
        input.valueIncludingGst === undefined ? (existing?.value_including_gst ?? null) : optionalNumber(input.valueIncludingGst, "Value including GST"),
        input.pendingMaterial === undefined ? text(existing?.pending_material) : text(input.pendingMaterial),
        input.rawMaterialToOrder === undefined ? text(existing?.raw_material_to_order) : text(input.rawMaterialToOrder),
        input.crfStatus === undefined ? text(existing?.crf_status) : text(input.crfStatus),
        input.cracStatus === undefined ? text(existing?.crac_status) : text(input.cracStatus),
        input.taskRemarks === undefined ? text(existing?.task_remarks) : text(input.taskRemarks),
        input.responsiblePerson === undefined ? text(existing?.responsible_person) : text(input.responsiblePerson),
        input.followUpDate === undefined ? text(existing?.follow_up_date) : optionalDate(input.followUpDate),
        input.dispatchSchedule === undefined ? text(existing?.dispatch_schedule) : text(input.dispatchSchedule),
        input.priority === undefined ? (text(existing?.priority) || (orderType === "SERVICE" ? "LOW" : "")) : text(input.priority),
        workflowStateId,
        orderType,
        serialNumber,
      );
      if (!existing || text(existing.workflow_state_id) !== workflowStateId) {
        if (existing) {
          this.db.prepare(`
            UPDATE planning_product_order_stage_history SET exited_at = ?
            WHERE product_order_id = ? AND exited_at IS NULL
          `).run(timestamp, orderId);
        }
        this.db.prepare(`
          INSERT INTO planning_product_order_stage_history(id, product_order_id, workflow_state_id, entered_at)
          VALUES (?, ?, ?, ?)
        `).run(randomUUID(), orderId, workflowStateId, timestamp);
      }
      if (input.customFields) {
        const definitions = new Map(this.getProductOrderFieldDefinitions().map((field) => [field.key, field]));
        const upsert = this.db.prepare(`
          INSERT INTO planning_product_order_field_values(product_order_id, field_id, value_json)
          VALUES (?, ?, ?)
          ON CONFLICT(product_order_id, field_id) DO UPDATE SET value_json = excluded.value_json
        `);
        for (const [key, value] of Object.entries(input.customFields)) {
          const definition = definitions.get(key);
          if (!definition) continue;
          upsert.run(orderId, definition.id, JSON.stringify(value ?? null));
        }
      }
      const reservationBasisChanged = !existing
        || Number(existing.product_item_id) !== Number(product.id)
        || Number(existing.quantity) !== quantity
        || text(existing.status) !== status
        || text(existing.bom_version_id) !== text(bom?.id);
      if (reservationBasisChanged) {
        this.db.prepare("DELETE FROM planning_reservations WHERE product_order_id = ?").run(orderId);
        if (orderType === "PRODUCTION" && status === "CONFIRMED" && bom) this.createReservations(orderId, bom, quantity);
      }
      this.recordOrderActivity(
        orderId,
        activityType ?? (existing ? "UPDATED" : "CREATED"),
        activityType === "TALLY_IMPORTED"
          ? `Imported from Tally Sales Order ${externalReference || input.fileNumber || orderId}`
          : existing ? "Order information updated" : `${orderType === "SERVICE" ? "Service" : "Production"} Order created`,
        actor,
      );
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

  updateProductOrderStatus(orderId: string, status: "CANCELLED" | "COMPLETED" | "CONFIRMED" | "ON_HOLD", actor?: ActorContext): void {
    this.ensureReady();
    const row = this.db.prepare("SELECT * FROM planning_product_orders WHERE id = ?").get(orderId) as Row | undefined;
    if (!row) throw new Error("Product order not found.");
    this.host.transaction("updating a product order", () => {
      const orderType = normalizedOrderType(row.order_type);
      let bom = orderType === "PRODUCTION" && row.bom_version_id
        ? this.db.prepare("SELECT * FROM planning_bom_versions WHERE id = ?").get(row.bom_version_id) as Row | undefined
        : undefined;
      if (orderType === "PRODUCTION" && status === "CONFIRMED" && !bom) {
        bom = this.activeBomForProduct(Number(row.product_item_id)) ?? undefined;
      }
      this.db.prepare(`
        UPDATE planning_product_orders
        SET status = ?, bom_version_id = ?, updated_at = ?
        WHERE id = ?
      `).run(status, status === "CONFIRMED" ? (bom?.id ?? null) : row.bom_version_id, nowIso(), orderId);
      if (status === "CONFIRMED") {
        this.db.prepare("DELETE FROM planning_reservations WHERE product_order_id = ?").run(orderId);
        if (orderType === "PRODUCTION" && bom) this.createReservations(orderId, bom, Number(row.quantity));
      } else {
        this.db.prepare(`
          UPDATE planning_reservations
          SET status = 'RELEASED', updated_at = ?
          WHERE product_order_id = ? AND status = 'ACTIVE'
        `).run(nowIso(), orderId);
      }
      this.recordOrderActivity(orderId, "STATUS_CHANGED", `Order marked ${status.toLocaleLowerCase()}`, actor);
    });
  }

  bulkUpdateProductOrders(input: BulkProductOrderUpdateInput, actor?: ActorContext): void {
    this.ensureReady();
    const ids = [...new Set(input.orderIds.map(text).filter(Boolean))];
    if (ids.length === 0) throw new Error("Select at least one order.");
    for (const id of ids) {
      const order = this.getProductOrders().find((entry) => entry.id === id);
      if (!order) continue;
      if (input.workflowStateId) this.updateProductOrderWorkflowState(id, input.workflowStateId, actor);
      if (input.responsiblePerson !== undefined || input.priority !== undefined) {
        this.saveProductOrder({
          id,
          orderType: order.orderType,
          serialNumber: order.serialNumber,
          externalReference: order.externalReference,
          productTallyGuid: order.productTallyGuid,
          quantity: order.quantity,
          requiredDate: order.requiredDate,
          responsiblePerson: input.responsiblePerson ?? order.responsiblePerson,
          priority: input.priority ?? order.priority,
        }, actor);
      }
    }
  }

  importTallySalesOrders(lines: TallySalesOrderImportLine[], actor?: ActorContext): {
    imported: number;
    skipped: number;
    unmatched: number;
  } {
    this.ensureReady();
    let imported = 0;
    let skipped = 0;
    let unmatched = 0;
    for (const line of lines) {
      const product = line.productTallyGuid
        ? this.db.prepare("SELECT tally_guid FROM tally_stock_items WHERE tally_guid = ?").get(line.productTallyGuid)
        : this.db.prepare(`
            SELECT tally_guid FROM tally_stock_items
            WHERE name = ? COLLATE NOCASE OR local_name_override = ? COLLATE NOCASE
            LIMIT 1
          `).get(line.productName, line.productName);
      if (!product) {
        unmatched += 1;
        continue;
      }
      const productGuid = text((product as Row).tally_guid);
      const existing = this.db.prepare(`
        SELECT id FROM planning_product_orders
        WHERE order_type = 'PRODUCTION'
          AND external_reference = ?
          AND product_item_id = (SELECT id FROM tally_stock_items WHERE tally_guid = ?)
      `).get(line.voucherNumber || line.reference, productGuid);
      if (existing) {
        skipped += 1;
        continue;
      }
      this.saveProductOrder({
        orderType: "PRODUCTION",
        fileNumber: line.tallyGuid,
        organisation: line.customerName,
        externalReference: line.voucherNumber || line.reference,
        purchaseOrderDate: line.voucherDate,
        productTallyGuid: productGuid,
        quantity: Math.max(1, Math.round(line.quantity)),
        pendingQuantity: Math.max(1, Math.round(line.quantity)),
        valueIncludingGst: line.value,
        requiredDate: line.voucherDate,
        workflowStateId: "po-pending",
        status: "CONFIRMED",
        notes: "Imported read-only from Tally Sales Order. Local workflow fields remain managed here.",
      }, actor, "TALLY_IMPORTED");
      imported += 1;
    }
    return { imported, skipped, unmatched };
  }

  /** Walks tally_stock_groups.parent_name up to "Primary", same algorithm Stores uses. */
  private resolveGroupPath(directName: string): string[] {
    const direct = text(directName);
    if (!direct) return [];
    const groupRows = this.db.prepare("SELECT name, parent_name FROM tally_stock_groups").all() as Row[];
    const parents = new Map(groupRows.map((row) => [text(row.name).toLocaleLowerCase(), text(row.parent_name)]));
    const result: string[] = [];
    let current = direct;
    const visited = new Set<string>();
    for (;;) {
      const key = current.toLocaleLowerCase();
      if (visited.has(key)) break;
      visited.add(key);
      result.unshift(current);
      const parent = parents.get(key) ?? "";
      if (!parent || parent.toLocaleLowerCase() === "primary") break;
      current = parent;
    }
    return result;
  }

  /**
   * Builds/refreshes the new Sales Order aggregate (one row per Tally voucher,
   * read-only source lines classified by Stock Group family). Runs alongside
   * importTallySalesOrders(), which keeps populating the legacy flat
   * Production Order register unchanged — neither path replaces the other yet.
   * Fulfilment lines are never auto-created here; Sales adds those manually.
   */
  importTallySalesOrderAggregates(orders: TallySalesOrder[], actor?: ActorContext): {
    imported: number;
    updated: number;
    unmatched: number;
  } {
    this.ensureReady();
    let imported = 0;
    let updated = 0;
    let unmatched = 0;
    for (const order of orders) {
      const candidateLines = order.lines.filter((line) => line.quantity != null && line.quantity > 0);
      const resolvedLines = candidateLines
        .map((line) => ({
          line,
          item: line.itemGuid
            ? (this.db.prepare(
                "SELECT id, tally_guid, name, parent_name FROM tally_stock_items WHERE tally_guid = ?",
              ).get(line.itemGuid) as Row | undefined)
            : undefined,
        }))
        .filter((entry): entry is { line: typeof entry.line; item: Row } => Boolean(entry.item));
      if (resolvedLines.length === 0) {
        unmatched += 1;
        continue;
      }

      const existing = this.db.prepare(
        "SELECT id, order_stage FROM planning_sales_orders WHERE tally_voucher_guid = ?",
      ).get(order.guid) as Row | undefined;
      const orderId = existing ? text(existing.id) : randomUUID();
      const timestamp = nowIso();
      const totalValue = resolvedLines.reduce((sum, entry) => sum + (entry.line.value ?? 0), 0);
      const newSourceLines = resolvedLines.map((entry) => {
        const groupPath = this.resolveGroupPath(text(entry.item.parent_name));
        return {
          itemId: Number(entry.item.id),
          itemTallyGuid: text(entry.item.tally_guid),
          itemNameSnapshot: text(entry.item.name),
          itemQualifiedNameSnapshot: formatQualifiedItemName(groupPath, text(entry.item.name)),
          family: resolvePrimaryGroupFamily(groupPath),
          quantity: Math.max(1, Math.round(entry.line.quantity!)),
          value: entry.line.value ?? null,
        };
      });

      // Once fulfilment work has started (CRF sent or later), a re-sync that
      // changes source lines must never silently rewrite an approved/active
      // CRF — record it as a pending amendment instead, per the brief.
      const fulfilmentStarted = existing && ["CRF_SENT", "IN_FULFILMENT", "COMPLETED"].includes(text(existing.order_stage));
      if (fulfilmentStarted) {
        const currentLines = this.db.prepare(`
          SELECT sl.item_id, sl.quantity, sl.value, item.tally_guid AS item_tally_guid
          FROM planning_sales_order_source_lines sl JOIN tally_stock_items item ON item.id = sl.item_id
          WHERE sl.sales_order_id = ?
        `).all(orderId) as Row[];
        const currentSignature = currentLines.map((row) => `${row.item_tally_guid}:${row.quantity}:${row.value ?? ""}`).sort().join("|");
        const newSignature = newSourceLines.map((line) => `${line.itemTallyGuid}:${line.quantity}:${line.value ?? ""}`).sort().join("|");
        if (currentSignature !== newSignature) {
          this.host.transaction("recording a Tally source amendment", () => {
            this.db.prepare(`
              INSERT INTO planning_sales_order_source_amendments(id, sales_order_id, new_source_lines_json, diff_summary, detected_at, applied)
              VALUES (?, ?, ?, ?, ?, 0)
            `).run(
              randomUUID(), orderId, json(newSourceLines),
              `Tally voucher ${order.voucherNumber || order.guid} changed lines after fulfilment had already started.`,
              timestamp,
            );
            this.db.prepare("UPDATE planning_sales_orders SET source_changed = 1, updated_at = ? WHERE id = ?").run(timestamp, orderId);
            this.invalidatePendingApprovals(orderId);
          });
          updated += 1;
          continue;
        }
      }

      this.host.transaction("importing a Sales Order aggregate from Tally", () => {
        if (existing) {
          this.db.prepare(`
            UPDATE planning_sales_orders
            SET customer_name = ?, po_reference = ?, po_value = ?, voucher_number = ?, voucher_date = ?, updated_at = ?
            WHERE id = ?
          `).run(order.customerName, order.reference, totalValue, order.voucherNumber, order.voucherDate, timestamp, orderId);
        } else {
          this.db.prepare(`
            INSERT INTO planning_sales_orders(
              id, tally_voucher_guid, customer_name, customer_tally_guid, po_reference, po_value,
              voucher_number, voucher_date, owner_user_id, order_stage, created_at, updated_at
            ) VALUES (?, ?, ?, '', ?, ?, ?, ?, '', 'PENDING_PO_APPROVAL', ?, ?)
          `).run(orderId, order.guid, order.customerName, order.reference, totalValue, order.voucherNumber, order.voucherDate, timestamp, timestamp);
          this.db.prepare(`
            INSERT INTO planning_sales_order_stage_history(id, scope, scope_id, stage, entered_at)
            VALUES (?, 'ORDER', ?, 'PENDING_PO_APPROVAL', ?)
          `).run(randomUUID(), orderId, timestamp);
        }
        this.db.prepare("DELETE FROM planning_sales_order_source_lines WHERE sales_order_id = ?").run(orderId);
        for (const line of newSourceLines) {
          this.db.prepare(`
            INSERT INTO planning_sales_order_source_lines(
              id, sales_order_id, tally_voucher_line_guid, item_id, item_name_snapshot,
              item_qualified_name_snapshot, family, quantity, value, created_at
            ) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?)
          `).run(randomUUID(), orderId, line.itemId, line.itemNameSnapshot, line.itemQualifiedNameSnapshot, line.family, line.quantity, line.value, timestamp);
        }
      });
      if (existing) updated += 1; else imported += 1;
    }
    return { imported, updated, unmatched };
  }

  getSalesOrderWorkflowStages(): SalesOrderWorkflowStage[] {
    this.ensureReady();
    return (this.db.prepare(`
      SELECT * FROM planning_sales_order_workflow_stages
      ORDER BY order_kind, stock_group_name COLLATE NOCASE, position, name COLLATE NOCASE
    `).all() as Row[]).map((row) => ({
      id: text(row.id),
      orderKind: normalizedSalesOrderKind(row.order_kind),
      stockGroupName: text(row.stock_group_name),
      name: text(row.name),
      color: text(row.color) || "#6B778C",
      position: Number(row.position),
      terminal: Number(row.terminal) === 1,
      requiredPermissions: parseJsonSafe<string[]>(text(row.required_permissions_json), []),
    }));
  }

  saveSalesOrderWorkflowStage(input: SaveSalesOrderWorkflowStageInput): void {
    this.ensureReady();
    const orderKind = normalizedSalesOrderKind(input.orderKind);
    const stockGroupName = "";
    const name = text(input.name);
    if (!name) throw new Error("Stage name is required.");
    const requiredPermissions = [...new Set((input.requiredPermissions ?? []).map((permission) => text(permission)).filter(Boolean))];
    const unknown = requiredPermissions.find((permission) => !allPermissions.includes(permission as Permission));
    if (unknown) throw new Error(`Unknown approval permission: ${unknown}.`);
    const existingPosition = input.position == null ? null : wholeNumber(input.position, "Stage position", false);
    const position = existingPosition ?? Number((this.db.prepare(`
      SELECT COALESCE(MAX(position), 0) + 1 AS next_position
      FROM planning_sales_order_workflow_stages
      WHERE order_kind = ? AND stock_group_name = ?
    `).get(orderKind, stockGroupName) as Row).next_position);
    const id = input.id ? workflowStageId(input.id) : workflowStageId(name);
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO planning_sales_order_workflow_stages(
        id, order_kind, stock_group_name, name, color, position, terminal, required_permissions_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, order_kind, stock_group_name) DO UPDATE SET
        name = excluded.name,
        color = excluded.color,
        position = excluded.position,
        terminal = excluded.terminal,
        required_permissions_json = excluded.required_permissions_json,
        updated_at = excluded.updated_at
    `).run(
      id, orderKind, stockGroupName, name, text(input.color) || "#6B778C",
      position, input.terminal ? 1 : 0, json(requiredPermissions), timestamp, timestamp,
    );
  }

  deleteSalesOrderWorkflowStage(input: { id: string; orderKind?: SalesOrderKind; stockGroupName?: string }): void {
    this.ensureReady();
    const id = workflowStageId(input.id);
    const orderKind = normalizedSalesOrderKind(input.orderKind);
    const stockGroupName = text(input.stockGroupName);
    const stage = this.db.prepare(`
      SELECT id, name, order_kind, stock_group_name
      FROM planning_sales_order_workflow_stages
      WHERE id = ? AND order_kind = ? AND stock_group_name = ?
    `).get(id, orderKind, stockGroupName) as Row | undefined;
    if (!stage) throw new Error("Stage not found.");
    const currentOrders = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM planning_sales_orders
      WHERE order_kind = ? AND order_stage = ?
    `).get(orderKind, id) as Row).count);
    const orderHistory = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM planning_sales_order_stage_history
      WHERE scope = 'ORDER' AND stage = ?
    `).get(id) as Row).count);
    const approvals = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM approval_requests WHERE target_stage = ?
    `).get(id) as Row).count);
    if (currentOrders || orderHistory || approvals) {
      throw new Error("This order stage is already used by orders, history, or approvals, so it cannot be deleted.");
    }
    const peers = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM planning_sales_order_workflow_stages
      WHERE order_kind = ? AND stock_group_name = ?
    `).get(orderKind, stockGroupName) as Row).count);
    if (peers <= 1) throw new Error("Keep at least one order stage for this order type.");
    this.db.prepare(`
      DELETE FROM planning_sales_order_workflow_stages
      WHERE id = ? AND order_kind = ? AND stock_group_name = ?
    `).run(id, orderKind, stockGroupName);
  }

  private salesOrderSourceLineFromItem(input: {
    item: Row;
    quantity: number;
    value: number | null;
  }): Omit<SalesOrderSourceLine, "id" | "tallyVoucherLineGuid"> {
    const groupPath = this.resolveGroupPath(text(input.item.parent_name));
    return {
      itemId: Number(input.item.id),
      itemTallyGuid: text(input.item.tally_guid),
      itemNameSnapshot: text(input.item.name),
      itemQualifiedNameSnapshot: formatQualifiedItemName(groupPath, text(input.item.name)),
      family: resolvePrimaryGroupFamily(groupPath),
      quantity: input.quantity,
      value: input.value,
    };
  }

  private salesOrderWorkflowStagesFor(orderKind: SalesOrderKind, stockGroupName: string): SalesOrderWorkflowStage[] {
    const rows = (this.db.prepare(`
      SELECT * FROM planning_sales_order_workflow_stages
      WHERE order_kind = ? AND stock_group_name = ?
      ORDER BY position, name COLLATE NOCASE
    `).all(orderKind, stockGroupName) as Row[]);
    if (rows.length === 0 && stockGroupName) return this.salesOrderWorkflowStagesFor(orderKind, "");
    return rows.map((row) => ({
      id: text(row.id),
      orderKind: normalizedSalesOrderKind(row.order_kind),
      stockGroupName: text(row.stock_group_name),
      name: text(row.name),
      color: text(row.color) || "#6B778C",
      position: Number(row.position),
      terminal: Number(row.terminal) === 1,
      requiredPermissions: parseJsonSafe<string[]>(text(row.required_permissions_json), []),
    }));
  }

  private salesOrderWorkflowStagesForOrder(orderId: string): SalesOrderWorkflowStage[] {
    const order = this.salesOrderById(orderId);
    return this.salesOrderWorkflowStagesFor(normalizedSalesOrderKind(order.order_kind), "");
  }

  private requiredPermissionsForSalesOrderStage(orderId: string, targetStage: string): Permission[] {
    const stage = this.salesOrderWorkflowStagesForOrder(orderId).find((entry) => entry.id === targetStage);
    return (stage?.requiredPermissions ?? []).filter((permission): permission is Permission =>
      allPermissions.includes(permission as Permission),
    );
  }

  saveSalesOrder(input: SaveSalesOrderInput, actor?: ActorContext): SalesOrder {
    this.ensureReady();
    const orderKind = normalizedSalesOrderKind(input.orderKind);
    const customerName = text(input.customerName);
    if (!customerName) throw new Error("Customer name is required.");
    const poReference = text(input.poReference);
    if (!poReference) throw new Error("PO/reference is required.");
    if (!input.sourceLines?.length) throw new Error("Add at least one order line.");
    const sourceLines = input.sourceLines.map((line) => {
      const item = this.stockItemByGuid(line.itemTallyGuid);
      return this.salesOrderSourceLineFromItem({
        item,
        quantity: wholeNumber(line.quantity, "Order line quantity", false),
        value: optionalNumber(line.value ?? null, "Order line value"),
      });
    });
    const initialStage = this.salesOrderWorkflowStagesFor(orderKind, "")[0]?.id ?? "PENDING_PO_APPROVAL";
    const orderId = text(input.id) || randomUUID();
    const existing = text(input.id) ? this.db.prepare(
      "SELECT id, order_stage FROM planning_sales_orders WHERE id = ?",
    ).get(orderId) as Row | undefined : undefined;
    if (input.id && !existing) throw new Error("Sales Order not found.");
    if (existing && ["CRF_SENT", "IN_FULFILMENT", "COMPLETED"].includes(text(existing.order_stage))) {
      throw new Error("This order has already entered fulfilment. Create an amendment instead of editing the source order.");
    }
    const timestamp = nowIso();
    const voucherNumber = text(input.voucherNumber) || `${orderKind === "SERVICE" ? "SVO" : "SO"}-${poReference}`;
    const voucherGuid = existing
      ? text((this.db.prepare("SELECT tally_voucher_guid FROM planning_sales_orders WHERE id = ?").get(orderId) as Row).tally_voucher_guid)
      : `LOCAL:${orderKind}:${orderId}`;
    this.host.transaction(existing ? "updating a local Sales Order" : "creating a local Sales Order", () => {
      if (existing) {
        this.db.prepare(`
          UPDATE planning_sales_orders
          SET order_kind = ?, customer_name = ?, customer_tally_guid = ?, po_reference = ?, po_value = ?,
            voucher_number = ?, voucher_date = ?, due_date = ?, owner_user_id = ?, updated_at = ?
          WHERE id = ?
        `).run(
          orderKind, customerName, text(input.customerTallyGuid), poReference,
          optionalNumber(input.poValue ?? null, "PO value"), voucherNumber,
          optionalDate(input.voucherDate) || dateOnly(), optionalDate(input.dueDate),
          text(input.ownerUserId ?? actor?.userId ?? ""), timestamp, orderId,
        );
        this.db.prepare("DELETE FROM planning_sales_order_source_lines WHERE sales_order_id = ?").run(orderId);
        this.invalidatePendingApprovals(orderId);
      } else {
        this.db.prepare(`
          INSERT INTO planning_sales_orders(
            id, order_kind, tally_voucher_guid, customer_name, customer_tally_guid, po_reference, po_value,
            voucher_number, voucher_date, due_date, owner_user_id, order_stage, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          orderId, orderKind, voucherGuid, customerName, text(input.customerTallyGuid), poReference,
          optionalNumber(input.poValue ?? null, "PO value"), voucherNumber,
          optionalDate(input.voucherDate) || dateOnly(), optionalDate(input.dueDate),
          text(input.ownerUserId ?? actor?.userId ?? ""), initialStage, timestamp, timestamp,
        );
        this.db.prepare(`
          INSERT INTO planning_sales_order_stage_history(id, scope, scope_id, stage, entered_at)
          VALUES (?, 'ORDER', ?, ?, ?)
        `).run(randomUUID(), orderId, initialStage, timestamp);
      }
      for (const line of sourceLines) {
        this.db.prepare(`
          INSERT INTO planning_sales_order_source_lines(
            id, sales_order_id, tally_voucher_line_guid, item_id, item_name_snapshot,
            item_qualified_name_snapshot, family, quantity, value, created_at
          ) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), orderId, line.itemId, line.itemNameSnapshot,
          line.itemQualifiedNameSnapshot, line.family, line.quantity, line.value, timestamp,
        );
      }
    });
    return this.getSalesOrders().find((entry) => entry.id === orderId)!;
  }

  /**
   * Sales/Accounts applying a detected Tally amendment: replaces the source
   * lines, clears the source_changed flag, and requires a brand-new CRF
   * revision since the underlying commercial data has changed.
   */
  applySourceAmendment(amendmentId: string, actor?: ActorContext): SalesOrder {
    this.ensureReady();
    const amendment = this.db.prepare(
      "SELECT * FROM planning_sales_order_source_amendments WHERE id = ?",
    ).get(amendmentId) as Row | undefined;
    if (!amendment) throw new Error("Source amendment not found.");
    if (Number(amendment.applied) === 1) throw new Error("This amendment was already applied.");
    const salesOrderId = text(amendment.sales_order_id);
    const newLines = parseJsonSafe<Array<{
      itemId: number; itemNameSnapshot: string; itemQualifiedNameSnapshot: string;
      family: string; quantity: number; value: number | null;
    }>>(text(amendment.new_source_lines_json), []);
    const timestamp = nowIso();
    this.host.transaction("applying a Tally source amendment", () => {
      this.db.prepare("DELETE FROM planning_sales_order_source_lines WHERE sales_order_id = ?").run(salesOrderId);
      for (const line of newLines) {
        this.db.prepare(`
          INSERT INTO planning_sales_order_source_lines(
            id, sales_order_id, tally_voucher_line_guid, item_id, item_name_snapshot,
            item_qualified_name_snapshot, family, quantity, value, created_at
          ) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), salesOrderId, line.itemId, line.itemNameSnapshot, line.itemQualifiedNameSnapshot, line.family, line.quantity, line.value, timestamp);
      }
      this.db.prepare("UPDATE planning_sales_order_source_amendments SET applied = 1, applied_at = ? WHERE id = ?").run(timestamp, amendmentId);
      this.db.prepare("UPDATE planning_sales_orders SET source_changed = 0, updated_at = ? WHERE id = ?").run(timestamp, salesOrderId);
      this.invalidatePendingApprovals(salesOrderId);
    });
    return this.getSalesOrders().find((entry) => entry.id === salesOrderId)!;
  }

  /**
   * After Accounts reviews and applies a Tally amendment on an order whose
   * CRF was already sent, this freezes a new CRF revision and re-opens
   * approval — required because the underlying commercial data changed.
   */
  requestCrfReapproval(salesOrderId: string, actor?: ActorContext): SalesOrder {
    this.ensureReady();
    this.requireSourceNotChanged(salesOrderId);
    this.host.transaction("requesting CRF re-approval after an amendment", () => {
      this.createCrfRevision(salesOrderId);
      this.createApprovalRequest("SALES_ORDER_CRF", salesOrderId, actor, "IN_FULFILMENT");
    });
    return this.getSalesOrders().find((entry) => entry.id === salesOrderId)!;
  }

  private mapSalesOrderSourceLine(row: Row): SalesOrderSourceLine {
    return {
      id: text(row.id),
      tallyVoucherLineGuid: text(row.tally_voucher_line_guid),
      itemId: Number(row.item_id),
      itemTallyGuid: text(row.item_tally_guid),
      itemNameSnapshot: text(row.item_name_snapshot),
      itemQualifiedNameSnapshot: text(row.item_qualified_name_snapshot),
      family: text(row.family) as SalesOrderSourceLine["family"],
      quantity: Number(row.quantity),
      value: row.value == null ? null : Number(row.value),
    };
  }

  private mapSalesOrderFulfilmentLine(row: Row): SalesOrderFulfilmentLine {
    return {
      id: text(row.id),
      salesOrderId: text(row.sales_order_id),
      parentFulfilmentLineId: row.parent_fulfilment_line_id == null ? null : text(row.parent_fulfilment_line_id),
      family: text(row.family) as SalesOrderFulfilmentLine["family"],
      itemId: Number(row.item_id),
      itemTallyGuid: text(row.item_tally_guid),
      itemName: text(row.item_name),
      itemQualifiedName: text(row.item_qualified_name),
      quantity: Number(row.quantity),
      consumptionMode: text(row.consumption_mode) as SalesOrderFulfilmentLine["consumptionMode"],
      stage: text(row.stage),
      holdStatus: text(row.hold_status) as SalesOrderFulfilmentLine["holdStatus"],
      serviceDone: Number(row.service_done) === 1,
      resaleSupplierId: row.resale_supplier_id == null ? null : Number(row.resale_supplier_id),
      resaleSupplierName: text(row.resale_supplier_name),
      notes: text(row.notes),
      stageHistory: [],
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    };
  }

  getSalesOrders(): SalesOrder[] {
    const orderRows = this.db.prepare("SELECT * FROM planning_sales_orders ORDER BY created_at DESC").all() as Row[];
    const sourceLineRows = this.db.prepare(`
      SELECT sl.*, item.tally_guid AS item_tally_guid
      FROM planning_sales_order_source_lines sl
      JOIN tally_stock_items item ON item.id = sl.item_id
      ORDER BY sl.created_at
    `).all() as Row[];
    const fulfilmentLineRows = this.db.prepare(`
      SELECT fl.*, item.tally_guid AS item_tally_guid,
        COALESCE(NULLIF(item.local_name_override, ''), item.name) AS item_name,
        item.parent_name AS item_parent_name,
        supplier.name AS resale_supplier_name, rs.supplier_id AS resale_supplier_id
      FROM planning_sales_order_fulfilment_lines fl
      JOIN tally_stock_items item ON item.id = fl.item_id
      LEFT JOIN planning_sales_order_resale_suppliers rs ON rs.fulfilment_line_id = fl.id
      LEFT JOIN suppliers supplier ON supplier.id = rs.supplier_id
      ORDER BY fl.created_at
    `).all() as Row[];
    const sourceLinesByOrder = new Map<string, SalesOrderSourceLine[]>();
    for (const row of sourceLineRows) {
      const list = sourceLinesByOrder.get(text(row.sales_order_id)) ?? [];
      list.push(this.mapSalesOrderSourceLine(row));
      sourceLinesByOrder.set(text(row.sales_order_id), list);
    }
    const fulfilmentLinesByOrder = new Map<string, SalesOrderFulfilmentLine[]>();
    for (const row of fulfilmentLineRows) {
      const groupPath = this.resolveGroupPath(text(row.item_parent_name));
      const list = fulfilmentLinesByOrder.get(text(row.sales_order_id)) ?? [];
      list.push({
        ...this.mapSalesOrderFulfilmentLine(row),
        itemQualifiedName: formatQualifiedItemName(groupPath, text(row.item_name)),
      });
      fulfilmentLinesByOrder.set(text(row.sales_order_id), list);
    }
    const requestRows = this.db.prepare(`
      SELECT * FROM approval_requests WHERE entity_type IN ('SALES_ORDER_PO','SALES_ORDER_CRF','SALES_ORDER_STAGE') ORDER BY created_at
    `).all() as Row[];
    const decisionRows = this.db.prepare("SELECT * FROM approval_decisions ORDER BY decided_at").all() as Row[];
    const decisionsByRequest = new Map<string, ApprovalDecision[]>();
    for (const row of decisionRows) {
      const list = decisionsByRequest.get(text(row.request_id)) ?? [];
      list.push({
        id: text(row.id),
        decidedByUserId: text(row.decided_by_user_id),
        decidedByName: text(row.decided_by_name),
        decidedByRole: text(row.decided_by_role),
        decision: text(row.decision) as ApprovalDecision["decision"],
        comment: text(row.comment),
        decidedAt: text(row.decided_at),
      });
      decisionsByRequest.set(text(row.request_id), list);
    }
    const requestsByOrder = new Map<string, ApprovalRequest[]>();
    for (const row of requestRows) {
      const list = requestsByOrder.get(text(row.entity_id)) ?? [];
      list.push({
        id: text(row.id),
        entityType: text(row.entity_type) as ApprovalRequest["entityType"],
        entityId: text(row.entity_id),
        targetStage: text(row.target_stage),
        status: text(row.status) as ApprovalRequest["status"],
        payloadHash: text(row.payload_hash),
        createdByUserId: text(row.created_by_user_id),
        createdAt: text(row.created_at),
        decisions: decisionsByRequest.get(text(row.id)) ?? [],
      });
      requestsByOrder.set(text(row.entity_id), list);
    }
    const revisionRows = this.db.prepare(
      "SELECT id, sales_order_id, revision_number, created_at, superseded_at FROM crf_revisions ORDER BY revision_number",
    ).all() as Row[];
    const revisionsByOrder = new Map<string, SalesOrder["crfRevisions"]>();
    for (const row of revisionRows) {
      const list = revisionsByOrder.get(text(row.sales_order_id)) ?? [];
      list.push({
        id: text(row.id),
        revisionNumber: Number(row.revision_number),
        createdAt: text(row.created_at),
        supersededAt: row.superseded_at == null ? null : text(row.superseded_at),
      });
      revisionsByOrder.set(text(row.sales_order_id), list);
    }
    const pendingAmendmentRows = this.db.prepare(
      "SELECT * FROM planning_sales_order_source_amendments WHERE applied = 0 ORDER BY detected_at DESC",
    ).all() as Row[];
    const pendingAmendmentByOrder = new Map<string, Row>();
    for (const row of pendingAmendmentRows) {
      if (!pendingAmendmentByOrder.has(text(row.sales_order_id))) pendingAmendmentByOrder.set(text(row.sales_order_id), row);
    }
    const productStageNames = new Map(this.getProductOrderWorkflowStates().map((stage) => [stage.id, stage.name]));
    const salesStageNames = new Map(this.getSalesOrderWorkflowStages().map((stage) => [stage.id, stage.name]));
    const formatFallbackStageName = (stageId: string) => stageId
      .replaceAll("_", " ")
      .replaceAll("-", " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
    const mapStageHistory = (row: Row): SalesOrderStageHistory => {
      const stageId = text(row.stage);
      const end = row.exited_at ? new Date(text(row.exited_at)).valueOf() : Date.now();
      const start = new Date(text(row.entered_at)).valueOf();
      return {
        id: text(row.id),
        scope: text(row.scope) as SalesOrderStageHistory["scope"],
        scopeId: text(row.scope_id),
        stageId,
        stageName: salesStageNames.get(stageId) ?? productStageNames.get(stageId) ?? formatFallbackStageName(stageId),
        enteredAt: text(row.entered_at),
        exitedAt: row.exited_at ? text(row.exited_at) : null,
        durationHours: Math.max(0, (end - start) / 3_600_000),
      };
    };
    const orderStageHistoryByOrder = new Map<string, SalesOrderStageHistory[]>();
    const fulfilmentStageHistoryByLine = new Map<string, SalesOrderStageHistory[]>();
    for (const row of this.db.prepare("SELECT * FROM planning_sales_order_stage_history ORDER BY entered_at").all() as Row[]) {
      const mapped = mapStageHistory(row);
      const target = mapped.scope === "ORDER" ? orderStageHistoryByOrder : fulfilmentStageHistoryByLine;
      const list = target.get(mapped.scopeId) ?? [];
      list.push(mapped);
      target.set(mapped.scopeId, list);
    }
    return orderRows.map((row) => {
      const pendingAmendment = pendingAmendmentByOrder.get(text(row.id));
      const fulfilmentLines = fulfilmentLinesByOrder.get(text(row.id)) ?? [];
      return {
        id: text(row.id),
        orderKind: normalizedSalesOrderKind(row.order_kind),
        tallyVoucherGuid: text(row.tally_voucher_guid),
        customerName: text(row.customer_name),
        customerTallyGuid: text(row.customer_tally_guid),
        poReference: text(row.po_reference),
        poValue: row.po_value == null ? null : Number(row.po_value),
        voucherNumber: text(row.voucher_number),
        voucherDate: text(row.voucher_date),
        dueDate: text(row.due_date),
        ownerUserId: text(row.owner_user_id),
        orderStage: text(row.order_stage) as SalesOrder["orderStage"],
        holdStatus: text(row.hold_status) as SalesOrder["holdStatus"],
        sourceChanged: Number(row.source_changed) === 1,
        stageHistory: orderStageHistoryByOrder.get(text(row.id)) ?? [],
        sourceLines: sourceLinesByOrder.get(text(row.id)) ?? [],
        fulfilmentLines: fulfilmentLines.map((line) => ({
          ...line,
          stageHistory: fulfilmentStageHistoryByLine.get(line.id) ?? [],
        })),
        approvalRequests: requestsByOrder.get(text(row.id)) ?? [],
        crfRevisions: revisionsByOrder.get(text(row.id)) ?? [],
        pendingSourceAmendment: pendingAmendment ? {
          id: text(pendingAmendment.id),
          salesOrderId: text(pendingAmendment.sales_order_id),
          newSourceLines: parseJsonSafe<SalesOrderSourceLine[]>(text(pendingAmendment.new_source_lines_json), []),
          diffSummary: text(pendingAmendment.diff_summary),
          detectedAt: text(pendingAmendment.detected_at),
          applied: false,
          appliedAt: null,
        } : null,
        createdAt: text(row.created_at),
        updatedAt: text(row.updated_at),
      };
    });
  }

  private salesOrderById(salesOrderId: string): Row {
    const row = this.db.prepare("SELECT * FROM planning_sales_orders WHERE id = ?").get(text(salesOrderId)) as Row | undefined;
    if (!row) throw new Error("Sales Order not found.");
    return row;
  }

  private fulfilmentLineById(fulfilmentLineId: string): Row {
    const row = this.db.prepare(
      "SELECT * FROM planning_sales_order_fulfilment_lines WHERE id = ?",
    ).get(text(fulfilmentLineId)) as Row | undefined;
    if (!row) throw new Error("Fulfilment line not found.");
    return row;
  }

  private oneSalesOrderFulfilmentLine(salesOrderId: string, fulfilmentLineId: string): SalesOrderFulfilmentLine {
    const order = this.getSalesOrders().find((entry) => entry.id === salesOrderId);
    const line = order?.fulfilmentLines.find((entry) => entry.id === fulfilmentLineId);
    if (!line) throw new Error("Fulfilment line not found after the update.");
    return line;
  }

  /**
   * Adds a fulfilment line under a Sales Order. Family is always derived
   * from the item's Stock Group ancestry — never accepted from the caller —
   * per the brief's "users must not manually select a conflicting item type."
   */
  addSalesOrderFulfilmentLine(input: SaveSalesOrderFulfilmentLineInput, actor?: ActorContext): SalesOrderFulfilmentLine {
    this.ensureReady();
    this.salesOrderById(input.salesOrderId);
    const item = this.stockItemByGuid(input.itemTallyGuid);
    const groupPath = this.resolveGroupPath(text(item.parent_name));
    const family = resolvePrimaryGroupFamily(groupPath);
    if (family === "UNKNOWN") {
      throw new Error("This item's Stock Group does not resolve to Manufactured Products, Resale Goods, Service, or Raw Materials.");
    }
    const parentId = text(input.parentFulfilmentLineId ?? "");
    if (parentId) {
      const parent = this.db.prepare(
        "SELECT family FROM planning_sales_order_fulfilment_lines WHERE id = ? AND sales_order_id = ?",
      ).get(parentId, input.salesOrderId) as Row | undefined;
      if (!parent) throw new Error("Parent fulfilment line not found on this order.");
      if (text(parent.family) !== "MANUFACTURED") {
        throw new Error("Only Manufactured Product lines can have supporting Resale or Raw Material lines.");
      }
      if (family === "MANUFACTURED" || family === "SERVICE") {
        throw new Error("Manufactured and Service lines must be top-level, not nested under another line.");
      }
    }
    const quantity = wholeNumber(input.quantity, "Fulfilment line quantity", false);
    const consumptionMode = input.consumptionMode === "INTERNAL_CONSUMPTION" ? "INTERNAL_CONSUMPTION" : "SOLD_DIRECT";
    if (consumptionMode === "INTERNAL_CONSUMPTION" && family !== "RAW_MATERIAL") {
      throw new Error("Only Raw Material lines may be marked for internal consumption.");
    }
    const id = randomUUID();
    const timestamp = nowIso();
    const initialStage = family === "MANUFACTURED" ? "material-planning"
      : family === "RESALE" ? RESALE_FULFILMENT_STAGES[0]
      : family === "RAW_MATERIAL" && consumptionMode === "SOLD_DIRECT" ? RAW_MATERIAL_FULFILMENT_STAGES[0]
      : "";
    this.host.transaction("adding a Sales Order fulfilment line", () => {
      this.db.prepare(`
        INSERT INTO planning_sales_order_fulfilment_lines(
          id, sales_order_id, parent_fulfilment_line_id, family, item_id, quantity,
          consumption_mode, stage, service_done, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        id, input.salesOrderId, parentId || null, family, Number(item.id), quantity,
        consumptionMode, initialStage, text(input.notes ?? ""), timestamp, timestamp,
      );
      if (initialStage) {
        this.db.prepare(`
          INSERT INTO planning_sales_order_stage_history(id, scope, scope_id, stage, entered_at)
          VALUES (?, 'FULFILMENT_LINE', ?, ?, ?)
        `).run(randomUUID(), id, initialStage, timestamp);
      }
      this.invalidatePendingApprovals(input.salesOrderId);
    });
    return this.oneSalesOrderFulfilmentLine(input.salesOrderId, id);
  }

  private setFulfilmentLineStage(fulfilmentLineId: string, stage: string): void {
    const timestamp = nowIso();
    this.host.transaction("advancing a Sales Order fulfilment line stage", () => {
      const line = this.db.prepare(
        "SELECT sales_order_id FROM planning_sales_order_fulfilment_lines WHERE id = ?",
      ).get(fulfilmentLineId) as Row;
      this.db.prepare(`
        UPDATE planning_sales_order_stage_history SET exited_at = ?
        WHERE scope = 'FULFILMENT_LINE' AND scope_id = ? AND exited_at IS NULL
      `).run(timestamp, fulfilmentLineId);
      this.db.prepare(`
        INSERT INTO planning_sales_order_stage_history(id, scope, scope_id, stage, entered_at)
        VALUES (?, 'FULFILMENT_LINE', ?, ?, ?)
      `).run(randomUUID(), fulfilmentLineId, stage, timestamp);
      this.db.prepare(`
        UPDATE planning_sales_order_fulfilment_lines SET stage = ?, updated_at = ? WHERE id = ?
      `).run(stage, timestamp, fulfilmentLineId);
      this.invalidatePendingApprovals(text(line.sales_order_id));
    });
  }

  /** MANUFACTURED lines reuse the existing 15-stage workflow lookup, starting at Material Planning since PO/CRF are now order-level concerns. */
  private advanceManufacturedFulfilmentLine(fulfilmentLineId: string, targetStageId: string, actor?: ActorContext): void {
    const line = this.fulfilmentLineById(fulfilmentLineId);
    const states = this.db.prepare(`
      SELECT id, name, position, stock_group_name, required_permissions_json FROM planning_product_order_workflow_states
      WHERE order_type = 'PRODUCTION' ORDER BY position
    `).all() as Row[];
    const materialPlanningPosition = Number(states.find((entry) => text(entry.id) === "material-planning")?.position ?? 0);
    const eligible = states.filter((entry) =>
      Number(entry.position) >= materialPlanningPosition
      && this.workflowStageAppliesToItem(entry, Number(line.item_id)),
    );
    const target = eligible.find((entry) => text(entry.id) === targetStageId);
    if (!target) throw new Error("Choose a valid Manufactured fulfilment stage.");
    this.requireWorkflowStagePermissions(target, actor);
    if (text(target.id) === "quality-control") {
      const reachedMaterialPurchase = this.db.prepare(`
        SELECT 1 FROM planning_sales_order_stage_history
        WHERE scope = 'FULFILMENT_LINE' AND scope_id = ? AND stage = 'material-purchase'
      `).get(fulfilmentLineId);
      if (!reachedMaterialPurchase) throw new Error("Quality Control is available only after the line has entered Material Purchase.");
    }
    this.setFulfilmentLineStage(fulfilmentLineId, text(target.id));
  }

  private advanceFixedStageFulfilmentLine(fulfilmentLineId: string, targetStage: string, allowedStages: string[]): void {
    if (!allowedStages.includes(targetStage)) {
      throw new Error(`Choose a valid stage: ${allowedStages.join(", ")}.`);
    }
    this.setFulfilmentLineStage(fulfilmentLineId, targetStage);
  }

  private requireSourceNotChanged(salesOrderId: string): void {
    const order = this.db.prepare("SELECT source_changed FROM planning_sales_orders WHERE id = ?").get(salesOrderId) as Row | undefined;
    if (order && Number(order.source_changed) === 1) {
      throw new Error("Tally changed this order's source lines after fulfilment started. Apply or review the amendment before progressing lines further.");
    }
  }

  advanceFulfilmentLineStage(fulfilmentLineId: string, targetStage: string, actor?: ActorContext): SalesOrderFulfilmentLine {
    this.ensureReady();
    const line = this.fulfilmentLineById(fulfilmentLineId);
    this.requireSourceNotChanged(text(line.sales_order_id));
    if (text(line.consumption_mode) === "INTERNAL_CONSUMPTION") {
      throw new Error("Internally consumed Raw Materials use Material Issue/reservation actions instead of dispatch stages.");
    }
    const family = text(line.family);
    const normalizedTarget = text(targetStage).toLocaleLowerCase();
    if (family === "MANUFACTURED") this.advanceManufacturedFulfilmentLine(fulfilmentLineId, normalizedTarget, actor);
    else if (family === "RESALE") this.advanceFixedStageFulfilmentLine(fulfilmentLineId, normalizedTarget, RESALE_FULFILMENT_STAGES);
    else if (family === "RAW_MATERIAL") this.advanceFixedStageFulfilmentLine(fulfilmentLineId, normalizedTarget, RAW_MATERIAL_FULFILMENT_STAGES);
    else throw new Error("Service lines use markFulfilmentLineServiceDone instead of stage progression.");
    return this.oneSalesOrderFulfilmentLine(text(line.sales_order_id), fulfilmentLineId);
  }

  assignResaleSupplier(fulfilmentLineId: string, supplierId: number, _actor?: ActorContext): SalesOrderFulfilmentLine {
    this.ensureReady();
    const line = this.fulfilmentLineById(fulfilmentLineId);
    if (text(line.family) !== "RESALE") throw new Error("Only Resale lines take a supplier assignment.");
    const supplier = this.db.prepare("SELECT id FROM suppliers WHERE id = ?").get(supplierId) as Row | undefined;
    if (!supplier) throw new Error("Choose a synchronized supplier.");
    this.host.transaction("assigning a Resale line supplier", () => {
      this.db.prepare(`
        INSERT INTO planning_sales_order_resale_suppliers(fulfilment_line_id, supplier_id, assigned_at)
        VALUES (?, ?, ?)
        ON CONFLICT(fulfilment_line_id) DO UPDATE SET supplier_id = excluded.supplier_id, assigned_at = excluded.assigned_at
      `).run(fulfilmentLineId, supplierId, nowIso());
      this.invalidatePendingApprovals(text(line.sales_order_id));
    });
    return this.oneSalesOrderFulfilmentLine(text(line.sales_order_id), fulfilmentLineId);
  }

  setFulfilmentLineServiceDone(fulfilmentLineId: string, done: boolean, _actor?: ActorContext): SalesOrderFulfilmentLine {
    this.ensureReady();
    const line = this.fulfilmentLineById(fulfilmentLineId);
    this.requireSourceNotChanged(text(line.sales_order_id));
    if (text(line.family) !== "SERVICE") throw new Error("Only Service lines use a done flag.");
    this.host.transaction("updating a Service line's done flag", () => {
      this.db.prepare(
        "UPDATE planning_sales_order_fulfilment_lines SET service_done = ?, updated_at = ? WHERE id = ?",
      ).run(done ? 1 : 0, nowIso(), fulfilmentLineId);
      this.invalidatePendingApprovals(text(line.sales_order_id));
    });
    return this.oneSalesOrderFulfilmentLine(text(line.sales_order_id), fulfilmentLineId);
  }

  /**
   * Order-level stage machine. Moves forward exactly one stage at a time.
   * PENDING_PO_APPROVAL → CRF_PENDING and CRF_SENT → IN_FULFILMENT are
   * approval-gated and rejected here — only the approval engine may apply
   * those two transitions, via setSalesOrderStage(), once a decision exists.
   */
  advanceSalesOrderStage(orderId: string, targetStage: SalesOrderStage, actor?: ActorContext): SalesOrder {
    this.ensureReady();
    const order = this.salesOrderById(orderId);
    const stages = this.salesOrderWorkflowStagesForOrder(orderId);
    const currentIndex = stages.findIndex((stage) => stage.id === text(order.order_stage));
    const targetIndex = stages.findIndex((stage) => stage.id === targetStage);
    if (targetIndex !== currentIndex + 1) {
      throw new Error("Sales Order stages move forward one step at a time.");
    }
    if (targetStage === "CRF_PENDING" || targetStage === "IN_FULFILMENT") {
      throw new Error(`Moving to ${targetStage} requires an approved request — use the approval workflow instead.`);
    }
    const requiredPermissions = this.requiredPermissionsForSalesOrderStage(orderId, targetStage);
    if (requiredPermissions.length > 0) {
      this.host.transaction("requesting stage-transition approval", () => {
        this.createApprovalRequest("SALES_ORDER_STAGE", orderId, actor, targetStage);
      });
      return this.getSalesOrders().find((entry) => entry.id === orderId)!;
    }
    this.setSalesOrderStage(orderId, targetStage, actor);
    const updated = this.getSalesOrders().find((entry) => entry.id === orderId);
    if (!updated) throw new Error("Sales Order not found after the update.");
    return updated;
  }

  /** Internal entry point for the approval engine (Phase 6) — bypasses the forward-only/approval-gate checks above. */
  setSalesOrderStage(orderId: string, targetStage: SalesOrderStage, _actor?: ActorContext): void {
    const timestamp = nowIso();
    this.host.transaction("advancing a Sales Order stage", () => {
      this.db.prepare(`
        UPDATE planning_sales_order_stage_history SET exited_at = ?
        WHERE scope = 'ORDER' AND scope_id = ? AND exited_at IS NULL
      `).run(timestamp, orderId);
      this.db.prepare(`
        INSERT INTO planning_sales_order_stage_history(id, scope, scope_id, stage, entered_at)
        VALUES (?, 'ORDER', ?, ?, ?)
      `).run(randomUUID(), orderId, targetStage, timestamp);
      this.db.prepare(
        "UPDATE planning_sales_orders SET order_stage = ?, updated_at = ? WHERE id = ?",
      ).run(targetStage, timestamp, orderId);
    });
  }

  /**
   * Marks any PENDING approval request for this Sales Order SUPERSEDED.
   * Called whenever approval-relevant data (fulfilment lines, supplier
   * assignment, etc.) changes — the brief requires editing to invalidate a
   * pending approval rather than letting it silently apply to changed data.
   */
  private invalidatePendingApprovals(salesOrderId: string): void {
    const pending = this.db.prepare(`
      SELECT id FROM approval_requests WHERE entity_id = ? AND status = 'PENDING'
    `).all(salesOrderId) as Row[];
    if (pending.length === 0) return;
    this.db.prepare(`
      UPDATE approval_requests SET status = 'SUPERSEDED' WHERE entity_id = ? AND status = 'PENDING'
    `).run(salesOrderId);
  }

  private currentSalesOrderPayload(salesOrderId: string): unknown {
    const order = this.getSalesOrders().find((entry) => entry.id === salesOrderId);
    if (!order) throw new Error("Sales Order not found.");
    return {
      sourceLines: order.sourceLines,
      fulfilmentLines: order.fulfilmentLines.map((line) => ({
        ...line,
        // Exclude fields that mutate as a side effect of progress, not of CRF content.
        updatedAt: undefined,
      })),
    };
  }

  private createApprovalRequest(
    entityType: ApprovalEntityType,
    salesOrderId: string,
    actor?: ActorContext,
    targetStage = "",
  ): ApprovalRequest {
    const existingPending = this.db.prepare(`
      SELECT 1 FROM approval_requests WHERE entity_type = ? AND entity_id = ? AND status = 'PENDING'
    `).get(entityType, salesOrderId);
    if (existingPending) throw new Error("An approval request is already pending for this Sales Order.");
    const id = randomUUID();
    const timestamp = nowIso();
    const hash = payloadHash(this.currentSalesOrderPayload(salesOrderId));
    this.db.prepare(`
      INSERT INTO approval_requests(id, entity_type, entity_id, target_stage, payload_hash, status, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)
    `).run(id, entityType, salesOrderId, targetStage, hash, actor?.userId ?? "", timestamp);
    const order = this.getSalesOrders().find((entry) => entry.id === salesOrderId);
    return order!.approvalRequests.find((entry) => entry.id === id)!;
  }

  /** Lets Sales record a promised dispatch date so the order can be sorted alongside Service Orders in one combined register. */
  setSalesOrderDueDate(salesOrderId: string, dueDate: string, _actor?: ActorContext): SalesOrder {
    this.ensureReady();
    this.salesOrderById(salesOrderId);
    this.db.prepare("UPDATE planning_sales_orders SET due_date = ?, updated_at = ? WHERE id = ?")
      .run(text(dueDate), nowIso(), salesOrderId);
    return this.getSalesOrders().find((entry) => entry.id === salesOrderId)!;
  }

  /** Independent of orderStage — never writes a stage-history row, so no duration is ever attributed to a hold/cancel period. */
  setSalesOrderHoldStatus(salesOrderId: string, holdStatus: SalesOrder["holdStatus"], _actor?: ActorContext): SalesOrder {
    this.ensureReady();
    this.salesOrderById(salesOrderId);
    this.db.prepare("UPDATE planning_sales_orders SET hold_status = ?, updated_at = ? WHERE id = ?")
      .run(holdStatus, nowIso(), salesOrderId);
    return this.getSalesOrders().find((entry) => entry.id === salesOrderId)!;
  }

  /** Independent of the per-family stage field — never writes a stage-history row. */
  setFulfilmentLineHoldStatus(fulfilmentLineId: string, holdStatus: SalesOrderFulfilmentLine["holdStatus"], _actor?: ActorContext): SalesOrder {
    this.ensureReady();
    const line = this.fulfilmentLineById(fulfilmentLineId);
    this.db.prepare("UPDATE planning_sales_order_fulfilment_lines SET hold_status = ?, updated_at = ? WHERE id = ?")
      .run(holdStatus, nowIso(), fulfilmentLineId);
    return this.getSalesOrders().find((entry) => entry.id === text(line.sales_order_id))!;
  }

  /** Accounts approval gate for a freshly-entered Sales Order (PENDING_PO_APPROVAL stage). */
  requestPoApproval(salesOrderId: string, actor?: ActorContext): SalesOrder {
    this.ensureReady();
    this.salesOrderById(salesOrderId);
    this.host.transaction("requesting PO approval", () => {
      this.createApprovalRequest("SALES_ORDER_PO", salesOrderId, actor, "CRF_PENDING");
    });
    return this.getSalesOrders().find((entry) => entry.id === salesOrderId)!;
  }

  /**
   * Sales completing the CRF: advances the order to CRF_SENT, freezes an
   * immutable CRF revision (the exact snapshot submitted for approval), and
   * opens the dual Accounts+Sales approval request.
   */
  submitCrfForApproval(salesOrderId: string, actor?: ActorContext): SalesOrder {
    this.ensureReady();
    this.advanceSalesOrderStage(salesOrderId, "CRF_SENT", actor);
    this.host.transaction("submitting a CRF for approval", () => {
      this.createCrfRevision(salesOrderId);
      this.createApprovalRequest("SALES_ORDER_CRF", salesOrderId, actor, "IN_FULFILMENT");
    });
    return this.getSalesOrders().find((entry) => entry.id === salesOrderId)!;
  }

  private createCrfRevision(salesOrderId: string): CrfRevision {
    const order = this.getSalesOrders().find((entry) => entry.id === salesOrderId);
    if (!order) throw new Error("Sales Order not found.");
    const latest = this.db.prepare(
      "SELECT COALESCE(MAX(revision_number), 0) AS revision FROM crf_revisions WHERE sales_order_id = ?",
    ).get(salesOrderId) as Row;
    const revisionNumber = Number(latest.revision) + 1;
    const payload: CrfPayload = {
      revisionNumber,
      generatedAt: nowIso(),
      order: {
        id: order.id,
        customerName: order.customerName,
        poReference: order.poReference,
        poValue: order.poValue,
        voucherNumber: order.voucherNumber,
        voucherDate: order.voucherDate,
        orderStage: order.orderStage,
      },
      sourceLines: order.sourceLines,
      fulfilmentLines: order.fulfilmentLines,
      checklist: this.getChecklistResultsForOrder(salesOrderId),
      approvalRequests: order.approvalRequests,
    };
    const id = randomUUID();
    const timestamp = nowIso();
    const hash = payloadHash(payload);
    this.db.prepare(
      "UPDATE crf_revisions SET superseded_at = ? WHERE sales_order_id = ? AND superseded_at IS NULL",
    ).run(timestamp, salesOrderId);
    this.db.prepare(`
      INSERT INTO crf_revisions(id, sales_order_id, revision_number, payload_json, payload_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, salesOrderId, revisionNumber, json(payload), hash, timestamp);
    return { id, salesOrderId, revisionNumber, payload, payloadHash: hash, createdAt: timestamp, supersededAt: null };
  }

  /** Full payload for Preview/Print/PDF — re-rendering an old revision always replays its frozen JSON, never live data. */
  getCrfRevision(revisionId: string): CrfRevision {
    const row = this.db.prepare("SELECT * FROM crf_revisions WHERE id = ?").get(revisionId) as Row | undefined;
    if (!row) throw new Error("CRF revision not found.");
    return {
      id: text(row.id),
      salesOrderId: text(row.sales_order_id),
      revisionNumber: Number(row.revision_number),
      payload: parseJsonSafe<CrfPayload>(text(row.payload_json), {} as CrfPayload),
      payloadHash: text(row.payload_hash),
      createdAt: text(row.created_at),
      supersededAt: row.superseded_at == null ? null : text(row.superseded_at),
    };
  }

  /**
   * Records one approval/rejection decision. Submitters may decide their own
   * request when they hold the needed permission, but there is still no
   * permission-pair bypass: each decision is pinned to exactly one required
   * permission slot when recorded, so one
   * person (or one role) can never fill two slots — this is permission-based
   * rather than role-name-based so a custom role granted the right
   * permission participates correctly. isApprovalSatisfied() requires a
   * distinct user per required slot.
   */
  decideApproval(requestId: string, decision: "APPROVE" | "REJECT", comment: string, actor: ActorContext): SalesOrder {
    this.ensureReady();
    const request = this.db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(requestId) as Row | undefined;
    if (!request) throw new Error("Approval request not found.");
    if (text(request.status) !== "PENDING") throw new Error("This approval request is no longer pending.");
    const entityType = text(request.entity_type) as ApprovalEntityType;
    const salesOrderId = text(request.entity_id);
    const requiredPermissions = entityType === "SALES_ORDER_STAGE"
      ? this.requiredPermissionsForSalesOrderStage(salesOrderId, text(request.target_stage))
      : APPROVAL_PERMISSION_REQUIREMENTS[entityType];
    if (requiredPermissions.length === 0) throw new Error("This approval request no longer has any approver permissions configured.");
    if (!requiredPermissions.some((permission) => actor.permissions?.includes(permission))) {
      throw new Error(`${actor.role} does not hold a permission required to decide this approval.`);
    }
    if (decision === "REJECT" && !text(comment).trim()) {
      throw new Error("A rejection requires a comment explaining why.");
    }
    const currentHash = payloadHash(this.currentSalesOrderPayload(text(request.entity_id)));
    this.host.transaction("recording an approval decision", () => {
      const readDecisions = () => (this.db.prepare(
        "SELECT decided_by_user_id, qualifying_permission, decision FROM approval_decisions WHERE request_id = ?",
      ).all(requestId) as Row[]).map((row) => ({
        decidedByUserId: text(row.decided_by_user_id),
        qualifyingPermission: text(row.qualifying_permission) as Permission | "",
        decision: text(row.decision) as "APPROVE" | "REJECT",
      }));
      // A redundant approval (every slot the actor qualifies for is already
      // claimed by someone else) is still recorded for the audit trail, it
      // just claims no slot and so cannot advance the request on its own.
      const qualifyingPermission = decision === "APPROVE"
        ? pickQualifyingPermission(entityType, actor.permissions, readDecisions(), requiredPermissions)
        : null;
      this.db.prepare(`
        INSERT INTO approval_decisions(
          id, request_id, decided_by_user_id, decided_by_name, decided_by_role,
          decision, comment, payload_hash_at_decision, decided_at, qualifying_permission
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), requestId, actor.userId, actor.displayName, actor.role, decision, text(comment), currentHash, nowIso(), qualifyingPermission ?? "");
      const records = readDecisions();
      if (hasRejection(records)) {
        this.db.prepare("UPDATE approval_requests SET status = 'REJECTED' WHERE id = ?").run(requestId);
      } else if (isApprovalSatisfied(entityType, records, requiredPermissions)) {
        this.db.prepare("UPDATE approval_requests SET status = 'APPROVED' WHERE id = ?").run(requestId);
        if (entityType === "SALES_ORDER_PO") this.setSalesOrderStage(salesOrderId, text(request.target_stage) || "CRF_PENDING", actor);
        else if (entityType === "SALES_ORDER_CRF") this.setSalesOrderStage(salesOrderId, text(request.target_stage) || "IN_FULFILMENT", actor);
        else this.setSalesOrderStage(salesOrderId, text(request.target_stage), actor);
      }
    });
    return this.getSalesOrders().find((entry) => entry.id === salesOrderId)!;
  }

  saveChecklistTemplate(input: SaveChecklistTemplateInput, actor?: ActorContext): ChecklistTemplate {
    this.ensureReady();
    const name = text(input.name);
    if (!name) throw new Error("Checklist template name is required.");
    if (!input.requirements || input.requirements.length === 0) {
      throw new Error("A checklist template needs at least one requirement.");
    }
    const latest = this.db.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM checklist_templates WHERE name = ? COLLATE NOCASE",
    ).get(name) as Row;
    const version = Number(latest.version) + 1;
    const id = randomUUID();
    const timestamp = nowIso();
    this.host.transaction("saving a checklist template", () => {
      this.db.prepare(`
        INSERT INTO checklist_templates(id, name, version, status, created_at) VALUES (?, ?, ?, 'ACTIVE', ?)
      `).run(id, name, version, timestamp);
      this.db.prepare(
        "UPDATE checklist_templates SET status = 'ARCHIVED' WHERE name = ? COLLATE NOCASE AND id <> ?",
      ).run(name, id);
      for (const requirement of input.requirements) {
        this.db.prepare(`
          INSERT INTO checklist_requirements(id, template_id, target_type, target_value, description)
          VALUES (?, ?, ?, ?, ?)
        `).run(randomUUID(), id, requirement.targetType, text(requirement.targetValue), text(requirement.description));
      }
    });
    return this.getChecklistTemplates().find((entry) => entry.id === id)!;
  }

  getChecklistTemplates(): ChecklistTemplate[] {
    const templateRows = this.db.prepare("SELECT * FROM checklist_templates ORDER BY name, version DESC").all() as Row[];
    const requirementRows = this.db.prepare("SELECT * FROM checklist_requirements").all() as Row[];
    return templateRows.map((row) => ({
      id: text(row.id),
      name: text(row.name),
      version: Number(row.version),
      status: text(row.status) as ChecklistTemplate["status"],
      requirements: requirementRows
        .filter((requirement) => text(requirement.template_id) === text(row.id))
        .map((requirement) => ({
          id: text(requirement.id),
          targetType: text(requirement.target_type),
          targetValue: text(requirement.target_value),
          description: text(requirement.description),
        })),
      createdAt: text(row.created_at),
    }));
  }

  /**
   * Evaluates the currently-ACTIVE checklist template against an order's
   * actual fulfilment lines, persisting one result per requirement — pinned
   * to this template version so a later template edit never alters what an
   * already-submitted CRF recorded.
   */
  resolveChecklistForOrder(salesOrderId: string, actor?: ActorContext): ChecklistResult[] {
    this.ensureReady();
    const order = this.getSalesOrders().find((entry) => entry.id === salesOrderId);
    if (!order) throw new Error("Sales Order not found.");
    const template = this.db.prepare("SELECT * FROM checklist_templates WHERE status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1").get() as Row | undefined;
    if (!template) return [];
    const requirements = this.db.prepare("SELECT * FROM checklist_requirements WHERE template_id = ?").all(template.id) as Row[];
    const timestamp = nowIso();
    this.host.transaction("resolving the Sales Order checklist", () => {
      this.db.prepare("DELETE FROM checklist_results WHERE sales_order_id = ?").run(salesOrderId);
      for (const requirement of requirements) {
        const existingWaiver = this.db.prepare(`
          SELECT * FROM checklist_results
          WHERE sales_order_id = ? AND requirement_id = ? AND status = 'WAIVED'
        `).get(salesOrderId, requirement.id) as Row | undefined;
        const satisfied = resolveChecklistRequirement({
          id: text(requirement.id),
          targetType: text(requirement.target_type) as never,
          targetValue: text(requirement.target_value),
        }, order);
        if (satisfied) {
          this.db.prepare(`
            INSERT INTO checklist_results(id, sales_order_id, requirement_id, template_id, status, created_at)
            VALUES (?, ?, ?, ?, 'SATISFIED', ?)
          `).run(randomUUID(), salesOrderId, requirement.id, template.id, timestamp);
        } else if (existingWaiver) {
          this.db.prepare(`
            INSERT INTO checklist_results(
              id, sales_order_id, requirement_id, template_id, status,
              waiver_reason, waiver_actor_user_id, waiver_actor_name, waiver_role, waiver_at, created_at
            ) VALUES (?, ?, ?, ?, 'WAIVED', ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(), salesOrderId, requirement.id, template.id, text(existingWaiver.waiver_reason),
            text(existingWaiver.waiver_actor_user_id), text(existingWaiver.waiver_actor_name),
            text(existingWaiver.waiver_role), text(existingWaiver.waiver_at), timestamp,
          );
        }
        // Neither satisfied nor previously waived: no row, surfaced as UNSATISFIED below.
      }
    });
    return this.getChecklistResultsForOrder(salesOrderId);
  }

  waiveChecklistRequirement(salesOrderId: string, requirementId: string, reason: string, actor: ActorContext): ChecklistResult[] {
    this.ensureReady();
    const trimmedReason = text(reason);
    if (!trimmedReason) throw new Error("A waiver requires a reason.");
    const requirement = this.db.prepare("SELECT * FROM checklist_requirements WHERE id = ?").get(requirementId) as Row | undefined;
    if (!requirement) throw new Error("Checklist requirement not found.");
    const timestamp = nowIso();
    this.host.transaction("waiving a checklist requirement", () => {
      this.db.prepare("DELETE FROM checklist_results WHERE sales_order_id = ? AND requirement_id = ?").run(salesOrderId, requirementId);
      this.db.prepare(`
        INSERT INTO checklist_results(
          id, sales_order_id, requirement_id, template_id, status,
          waiver_reason, waiver_actor_user_id, waiver_actor_name, waiver_role, waiver_at, created_at
        ) VALUES (?, ?, ?, ?, 'WAIVED', ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), salesOrderId, requirementId, requirement.template_id, trimmedReason,
        actor.userId, actor.displayName, actor.role, timestamp, timestamp,
      );
    });
    return this.getChecklistResultsForOrder(salesOrderId);
  }

  getChecklistResultsForOrder(salesOrderId: string): ChecklistResult[] {
    const template = this.db.prepare("SELECT id FROM checklist_templates WHERE status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1").get() as Row | undefined;
    if (!template) return [];
    const requirements = this.db.prepare("SELECT * FROM checklist_requirements WHERE template_id = ?").all(template.id) as Row[];
    const results = this.db.prepare(
      "SELECT * FROM checklist_results WHERE sales_order_id = ?",
    ).all(salesOrderId) as Row[];
    return requirements.map((requirement) => {
      const result = results.find((entry) => text(entry.requirement_id) === text(requirement.id));
      return {
        requirementId: text(requirement.id),
        targetType: text(requirement.target_type),
        targetValue: text(requirement.target_value),
        description: text(requirement.description),
        status: result ? (text(result.status) as ChecklistResult["status"]) : "UNSATISFIED",
        waiverReason: text(result?.waiver_reason),
        waiverActorName: text(result?.waiver_actor_name),
        waiverRole: text(result?.waiver_role),
        waiverAt: text(result?.waiver_at),
      };
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

  private getProductOrderWorkflowStates(): ProductOrderWorkflowState[] {
    return (this.db.prepare(`
      SELECT id, name, color, position, terminal, order_type, stock_group_name, required_permissions_json
      FROM planning_product_order_workflow_states ORDER BY order_type, stock_group_name, position, name
    `).all() as Row[]).map((row) => ({
      id: text(row.id),
      orderType: normalizedOrderType(row.order_type),
      stockGroupName: text(row.stock_group_name),
      name: text(row.name),
      color: text(row.color),
      position: Number(row.position),
      terminal: Boolean(row.terminal),
      requiredPermissions: parseJsonSafe<string[]>(text(row.required_permissions_json), []),
    }));
  }

  private getProductOrderFieldDefinitions(): ProductOrderFieldDefinition[] {
    return (this.db.prepare(`
      SELECT id, field_key, label, field_type, position
      FROM planning_product_order_field_definitions ORDER BY position, label
    `).all() as Row[]).map((row) => ({
      id: text(row.id),
      key: text(row.field_key),
      label: text(row.label),
      type: row.field_type,
      position: Number(row.position),
    }));
  }

  private getProductOrders(): ProductOrder[] {
    const rows = this.db.prepare(`
      SELECT o.*, item.tally_guid AS product_tally_guid,
        COALESCE(NULLIF(item.local_name_override, ''), item.name) AS product_name,
        bom.label AS bom_label, bom.version_number AS bom_version_number,
        workflow.name AS workflow_state_name, workflow.color AS workflow_state_color
      FROM planning_product_orders o
      JOIN tally_stock_items item ON item.id = o.product_item_id
      LEFT JOIN planning_bom_versions bom ON bom.id = o.bom_version_id
      LEFT JOIN planning_product_order_workflow_states workflow ON workflow.id = o.workflow_state_id
      ORDER BY CASE o.order_type WHEN 'PRODUCTION' THEN 0 ELSE 1 END,
        CASE o.status WHEN 'CONFIRMED' THEN 0 WHEN 'DRAFT' THEN 1 ELSE 2 END,
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
    const customFieldStatement = this.db.prepare(`
      SELECT definition.field_key, value.value_json
      FROM planning_product_order_field_values value
      JOIN planning_product_order_field_definitions definition ON definition.id = value.field_id
      WHERE value.product_order_id = ?
      ORDER BY definition.position
    `);
    const stageHistoryStatement = this.db.prepare(`
      SELECT history.*, workflow.name AS state_name
      FROM planning_product_order_stage_history history
      JOIN planning_product_order_workflow_states workflow ON workflow.id = history.workflow_state_id
      WHERE history.product_order_id = ? ORDER BY history.entered_at
    `);
    const activityStatement = this.db.prepare(`
      SELECT id, event_type, actor_name, actor_role, summary, created_at
      FROM planning_product_order_activity
      WHERE product_order_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 100
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
      const orderType = normalizedOrderType(row.order_type);
      let feasibility: ProductOrder["feasibility"] = orderType === "SERVICE" ? "READY" : "BOM_INCOMPLETE";
      if (orderType === "PRODUCTION" && row.bom_version_id && requirements.length > 0) {
        if (requirements.every((line) => line.shortageNow === 0)) feasibility = "READY";
        else if (requirements.every((line) => line.shortageAfterIncoming === 0)) feasibility = "READY_WITH_INCOMING";
        else if (requirements.some((line) => line.shortageAfterIncoming >= line.requiredQuantity)) feasibility = "SHORT_COMPONENTS";
        else feasibility = "AT_RISK";
      }
      const customFields = Object.fromEntries((customFieldStatement.all(row.id) as Row[]).map((field) => {
        try {
          return [text(field.field_key), JSON.parse(text(field.value_json))];
        } catch {
          return [text(field.field_key), text(field.value_json)];
        }
      }));
      const stageHistory = (stageHistoryStatement.all(row.id) as Row[]).map((entry) => {
        const end = entry.exited_at ? new Date(text(entry.exited_at)).valueOf() : Date.now();
        const start = new Date(text(entry.entered_at)).valueOf();
        return {
          id: text(entry.id),
          stateId: text(entry.workflow_state_id),
          stateName: text(entry.state_name),
          enteredAt: text(entry.entered_at),
          exitedAt: entry.exited_at ? text(entry.exited_at) : null,
          durationHours: Math.max(0, (end - start) / 3_600_000),
        };
      });
      const activity = (activityStatement.all(row.id) as Row[]).map((entry) => ({
        id: text(entry.id),
        eventType: entry.event_type,
        actorName: text(entry.actor_name),
        actorRole: text(entry.actor_role),
        summary: text(entry.summary),
        createdAt: text(entry.created_at),
      }));
      return {
        id: text(row.id),
        orderType,
        serialNumber: text(row.serial_number),
        warrantyStatus: orderType === "SERVICE"
          ? warrantyStatusForSerial(text(row.serial_number), text(row.created_at))
          : "NOT_APPLICABLE",
        fileNumber: text(row.file_number),
        organisation: text(row.organisation),
        externalReference: text(row.external_reference),
        purchaseOrderDate: text(row.purchase_order_date),
        lastDispatchDate: text(row.last_dispatch_date),
        productStockItemId: Number(row.product_item_id),
        productTallyGuid: text(row.product_tally_guid),
        productName: text(row.product_name),
        quantity: Number(row.quantity),
        pendingQuantity: row.pending_quantity == null ? null : Number(row.pending_quantity),
        valueIncludingGst: row.value_including_gst == null ? null : Number(row.value_including_gst),
        pendingMaterial: text(row.pending_material),
        rawMaterialToOrder: text(row.raw_material_to_order),
        crfStatus: text(row.crf_status),
        cracStatus: text(row.crac_status),
        taskRemarks: text(row.task_remarks),
        responsiblePerson: text(row.responsible_person),
        followUpDate: text(row.follow_up_date),
        dispatchSchedule: text(row.dispatch_schedule),
        priority: text(row.priority),
        requiredDate: text(row.required_date),
        status: row.status,
        workflowStateId: text(row.workflow_state_id),
        workflowStateName: text(row.workflow_state_name) || "Pending",
        workflowStateColor: text(row.workflow_state_color) || "#6B778C",
        stageHistory,
        activity,
        bomVersionId: row.bom_version_id ? text(row.bom_version_id) : null,
        bomVersionLabel: row.bom_version_id ? `${text(row.bom_label)} (v${row.bom_version_number})` : "No active BOM",
        feasibility,
        notes: text(row.notes),
        customFields,
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
    const groupParents = new Map((this.db.prepare(
      "SELECT name, parent_name FROM tally_stock_groups WHERE active = 1",
    ).all() as Row[]).map((row) => [text(row.name).toLocaleLowerCase(), text(row.parent_name)]));
    const groupSettings = new Map((this.db.prepare(
      "SELECT group_name, catalog_role FROM catalog_group_settings",
    ).all() as Row[]).map((row) => [text(row.group_name).toLocaleLowerCase(), text(row.catalog_role)]));
    // Mirrors stores/database.ts's getState(): nearest explicit ancestor
    // wins, walking from the most specific group up to Primary.
    const resolveGroupRole = (path: string[]): string | null => {
      for (let index = path.length - 1; index >= 0; index -= 1) {
        const role = groupSettings.get(path[index].toLocaleLowerCase());
        if (role) return role;
      }
      return null;
    };
    const splitGroup = (directName: string) => {
      const path: string[] = [];
      let current = directName;
      const visited = new Set<string>();
      for (;;) {
        const key = current.toLocaleLowerCase();
        if (visited.has(key)) break;
        visited.add(key);
        path.unshift(current);
        const parent = groupParents.get(key) ?? "";
        if (!parent || parent.toLocaleLowerCase() === "primary") break;
        current = parent;
      }
      return {
        path,
        primaryGroupName: path[0] ?? "",
        secondaryGroupName: path[1] ?? "",
      };
    };
    const rows = this.db.prepare(`
      SELECT item.id, item.tally_guid,
        COALESCE(NULLIF(item.local_name_override, ''), item.name) AS name,
        item.parent_name, item.source, item.catalog_status, item.catalog_role_override,
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
      LEFT JOIN planning_restock_policies policy ON policy.stock_item_id = item.id
      LEFT JOIN suppliers supplier ON supplier.id = policy.preferred_supplier_id
      LEFT JOIN planning_recommendations recommendation ON recommendation.stock_item_id = item.id
      WHERE item.active = 1
        AND item.catalog_status <> 'DUPLICATE'
      ORDER BY item.name
    `).all() as Row[];
    return rows.map((row) => {
      const groups = splitGroup(text(row.parent_name));
      const itemOverride = text(row.catalog_role_override) || null;
      const explicitRole = itemOverride ?? resolveGroupRole(groups.path);
      if (explicitRole === "IGNORED") return null;
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
        qualifiedName: formatQualifiedItemName(groups.path, text(row.name)),
        groupName: text(row.parent_name),
        groupPath: groups.path,
        primaryGroupName: groups.primaryGroupName,
        secondaryGroupName: groups.secondaryGroupName,
        catalogSource: row.source === "LOCAL" ? "LOCAL" : "TALLY",
        catalogStatus: obsolete ? "OBSOLETE" : "ACTIVE",
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
    }).filter((item): item is RestockPlanningItem => item !== null);
  }

  getState(): PlanningState {
    this.ensureReady();
    const generatedAt = nowIso();
    const items = this.getPlanningItems();
    const boms = this.getBoms();
    const productOrders = this.getProductOrders();
    const productOrderWorkflowStates = this.getProductOrderWorkflowStates();
    const productOrderFieldDefinitions = this.getProductOrderFieldDefinitions();
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
      ordersAtRisk: productOrders.filter((order) => order.orderType === "PRODUCTION" && ["AT_RISK", "SHORT_COMPONENTS", "BOM_INCOMPLETE"].includes(order.feasibility) && order.status === "CONFIRMED").length,
      ordersReady: productOrders.filter((order) => order.orderType === "PRODUCTION" && ["READY", "READY_WITH_INCOMING"].includes(order.feasibility) && order.status === "CONFIRMED").length,
      missingBom: productOrders.filter((order) => order.orderType === "PRODUCTION" && order.feasibility === "BOM_INCOMPLETE" && order.status === "CONFIRMED").length,
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
      productOrderWorkflowStates,
      productOrderFieldDefinitions,
      salesOrderWorkflowStages: this.getSalesOrderWorkflowStages(),
      groups: [...new Set(items.map((item) => item.groupName).filter(Boolean))].sort(),
      primaryGroups: [...new Set(items.map((item) => item.primaryGroupName).filter(Boolean))].sort(),
      secondaryGroups: [...new Set(items.map((item) => item.secondaryGroupName).filter(Boolean))].sort(),
      salesOrders: this.getSalesOrders(),
      checklistTemplates: this.getChecklistTemplates(),
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
