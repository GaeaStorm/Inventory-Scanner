import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ApplicationDatabase } from "../database/application-database";
import type { TallyStoresSnapshot } from "../tally/types";
import type {
  AdjustmentContext,
  AdjustmentInput,
  BulkVendorReceiptInput,
  BulkVendorReceiptResult,
  ConfirmImportInput,
  CreateCatalogGroupInput,
  CreateLocalStockItemInput,
  CreateStockCategoryInput,
  DeleteCatalogGroupInput,
  DeleteStockCategoryInput,
  DeleteStockItemInput,
  ExportBatchInput,
  MaterialOutInput,
  OpeningQuantityInput,
  RenameStockItemInput,
  ReviewDecisionInput,
  SaveBoxInput,
  SetCatalogVisibilityInput,
  SetCatalogStatusInput,
  StoresBackupInfo,
  StoresBackupResult,
  StoresRestoreResult,
  StoresBox,
  StoresDatabaseStatus,
  StoresDataMode,
  StoresFifoAllocation,
  StoresMovement,
  StoresOpeningQuantityAdjustment,
  StoresPurchaseLot,
  StoresPurchaseOrder,
  StoresReviewEntry,
  StoresState,
  StoresStockItem,
  StoresSupplier,
  StoresSyncSummary,
  VendorReceiptInput,
} from "./types";

const SCHEMA_VERSION = 11;
const LEGACY_SUPPLIER_NAME = "Opening Legacy Stock";
const LEGACY_SUPPLIER_GUID = "LOCAL:LEGACY_OPENING";

type Row = Record<string, any>;

function nowIso(): string {
  return new Date().toISOString();
}

function localDayKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface BackupRetentionCandidate {
  path: string;
  mtime: number;
}

/**
 * Keep every backup created today plus only the newest backup from yesterday.
 * Older files are deliberately excluded so scheduled snapshots cannot grow
 * the application-data folder forever.
 */
export function retainedBackupPaths(
  backups: BackupRetentionCandidate[],
  now = new Date(),
): Set<string> {
  const today = localDayKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(now.getDate() - 1);
  const yesterday = localDayKey(yesterdayDate);
  const sorted = [...backups].sort((left, right) => right.mtime - left.mtime);
  const retained = new Set(
    sorted
      .filter((backup) => localDayKey(new Date(backup.mtime)) === today)
      .map((backup) => backup.path),
  );
  const previousDay = sorted.find(
    (backup) => localDayKey(new Date(backup.mtime)) === yesterday,
  );
  if (previousDay) retained.add(previousDay.path);
  return retained;
}

function businessDate(value?: string): string {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.valueOf())) throw new Error("Enter a valid transaction date.");
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function integerQuantity(value: unknown, label = "Quantity"): number {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  return quantity;
}

function adjustmentDirection(value: unknown): AdjustmentInput["direction"] {
  if (value === "RETURN_TO_STOCK" || value === "ADDITIONAL_OUT") return value;
  throw new Error("Choose whether the adjustment returns stock or records an additional issue.");
}

function adjustmentReason(value: unknown): AdjustmentInput["reason"] {
  if (["UNUSED_MATERIAL", "MISCOUNT", "DATA_ENTRY_ERROR", "DAMAGE_OR_LOSS", "OTHER"].includes(String(value))) {
    return value as AdjustmentInput["reason"];
  }
  throw new Error("Choose an adjustment reason.");
}

function nullableNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function payloadHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function sqlValue(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  return String(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function itemIdentity(guid: string, name: string): string {
  return guid || `NAME:${name.toLocaleLowerCase()}`;
}

function supplierIdentity(guid: string, name: string): string {
  return guid || `NAME:${name.toLocaleLowerCase()}`;
}

export class StoresDatabase {
  readonly databasePath: string;
  readonly defaultBackupFolder: string;
  readonly defaultExportFolder: string;
  readonly host: ApplicationDatabase;

  static databasePathFor(userDataDirectory: string): string {
    return path.join(userDataDirectory, "data", "inventory-scanner.sqlite");
  }

  constructor(userDataDirectory: string, host?: ApplicationDatabase) {
    const dataDirectory = path.join(userDataDirectory, "data");
    mkdirSync(dataDirectory, { recursive: true });
    this.databasePath = StoresDatabase.databasePathFor(userDataDirectory);
    this.defaultBackupFolder = path.join(userDataDirectory, "backups");
    this.defaultExportFolder = path.join(userDataDirectory, "exports");
    mkdirSync(this.defaultBackupFolder, { recursive: true });
    mkdirSync(this.defaultExportFolder, { recursive: true });

    this.host = host ?? new ApplicationDatabase(this.databasePath);
    if (this.host.databasePath !== this.databasePath) {
      throw new Error("The Stores module must use the shared application database host.");
    }
    const existingSchemaVersion = this.detectSchemaVersionOnDisk();
    if (existingSchemaVersion > 0 && existingSchemaVersion < SCHEMA_VERSION) {
      this.backupBeforeMigration();
    }
    this.migrate();
    this.ensureDefaultSettings();
  }

  get db(): DatabaseSync {
    return this.host.db;
  }

  close(): void {
    // The Electron composition root owns this connection so future domains,
    // such as Production, can share the same transaction coordinator.
  }

  private ensureDefaultSettings(): void {
    if (!this.getSetting("backup_folder")) this.setSetting("backup_folder", this.defaultBackupFolder);
    if (!this.getSetting("export_folder")) this.setSetting("export_folder", this.defaultExportFolder);
    if (!this.getSetting("application_database_host_id")) {
      this.setSetting("application_database_host_id", randomUUID());
    }
  }

  private detectSchemaVersionOnDisk(): number {
    if (!existsSync(this.databasePath) || statSync(this.databasePath).size === 0) return 0;
    const check = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      const table = check.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      ).get();
      if (!table) return 0;
      const row = check.prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      ).get() as Row | undefined;
      return Number(row?.version ?? 0);
    } finally {
      check.close();
    }
  }

  private validateBackupFile(backupPath: string, quick = false): boolean {
    let check: DatabaseSync | undefined;
    try {
      check = new DatabaseSync(backupPath, { readOnly: true });
      const result = check.prepare(quick ? "PRAGMA quick_check" : "PRAGMA integrity_check").get() as Row | undefined;
      return Object.values(result ?? {}).some((value) => value === "ok");
    } catch {
      return false;
    } finally {
      if (check?.isOpen) check.close();
      // Never remove WAL/SHM files here. This validator may be used against
      // the active database during restore verification; deleting its live
      // sidecars would corrupt the connection.
    }
  }

  private sqliteString(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
  }

  private createVerifiedBackup(source: DatabaseSync, target: string): void {
    const partial = `${target}.partial`;
    for (const candidate of [partial, `${partial}-wal`, `${partial}-shm`]) {
      if (existsSync(candidate)) unlinkSync(candidate);
    }

    try {
      // VACUUM INTO creates a transactionally consistent standalone snapshot,
      // including committed pages that are still present in the WAL file.
      source.exec(`VACUUM INTO ${this.sqliteString(partial)}`);
      if (!this.validateBackupFile(partial)) {
        throw new Error("The SQLite backup failed its integrity check.");
      }
      renameSync(partial, target);
    } catch (error) {
      for (const candidate of [partial, `${partial}-wal`, `${partial}-shm`]) {
        if (existsSync(candidate)) unlinkSync(candidate);
      }
      throw error;
    }
  }

  private pruneBackups(backupFolder: string): void {
    const backups = readdirSync(backupFolder)
      .filter((name) => name.endsWith(".sqlite"))
      .map((name) => ({
        path: path.join(backupFolder, name),
        mtime: statSync(path.join(backupFolder, name)).mtimeMs,
      }));
    const retained = retainedBackupPaths(backups);
    for (const backup of backups) {
      if (!retained.has(backup.path)) unlinkSync(backup.path);
    }
  }

  private backupBeforeMigration(): void {
    if (!existsSync(this.databasePath) || statSync(this.databasePath).size === 0) return;
    const target = path.join(
      this.defaultBackupFolder,
      `pre-migration-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`,
    );
    const source = new DatabaseSync(this.databasePath, {
      timeout: 5_000,
      enableForeignKeyConstraints: false,
    });
    try {
      this.createVerifiedBackup(source, target);
    } catch (error) {
      if (existsSync(target)) unlinkSync(target);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`The automatic pre-migration SQLite backup could not be created: ${message}`);
    } finally {
      if (source.isOpen) source.close();
    }
    this.pruneBackups(this.defaultBackupFolder);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const current = Number(
      (this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as Row | undefined)?.version ?? 0,
    );

    if (current < 1) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE tally_stock_items (
            id INTEGER PRIMARY KEY,
            tally_guid TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            parent_name TEXT NOT NULL DEFAULT '',
            has_bom INTEGER NOT NULL DEFAULT 0 CHECK (has_bom IN (0,1)),
            tally_closing_quantity INTEGER NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
            synced_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE bom_components (
            id INTEGER PRIMARY KEY,
            product_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
            component_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
            bom_name TEXT NOT NULL DEFAULT '',
            quantity INTEGER,
            UNIQUE(product_item_id, component_item_id, bom_name)
          ) STRICT;

          CREATE TABLE suppliers (
            id INTEGER PRIMARY KEY,
            tally_guid TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            synced_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE purchase_orders (
            id INTEGER PRIMARY KEY,
            tally_guid TEXT NOT NULL UNIQUE,
            voucher_number TEXT NOT NULL,
            voucher_date TEXT NOT NULL,
            supplier_id INTEGER REFERENCES suppliers(id),
            status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('OPEN','CLOSED','UNKNOWN')),
            reference TEXT NOT NULL DEFAULT '',
            synced_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE purchase_order_lines (
            id INTEGER PRIMARY KEY,
            purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
            stock_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
            ordered_quantity INTEGER NOT NULL CHECK (ordered_quantity >= 0),
            received_quantity INTEGER NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
            rate REAL,
            value REAL
          ) STRICT;

          CREATE TABLE grns (
            id INTEGER PRIMARY KEY,
            tally_guid TEXT NOT NULL UNIQUE,
            voucher_number TEXT NOT NULL,
            voucher_date TEXT NOT NULL,
            supplier_id INTEGER REFERENCES suppliers(id),
            purchase_order_id INTEGER REFERENCES purchase_orders(id),
            po_number TEXT NOT NULL DEFAULT '',
            tracking_number TEXT NOT NULL DEFAULT '',
            challan_number TEXT NOT NULL DEFAULT '',
            challan_date TEXT NOT NULL DEFAULT '',
            source_type TEXT NOT NULL CHECK (source_type IN ('TALLY_GRN','LOCAL_GRN')),
            synced_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE grn_lines (
            id INTEGER PRIMARY KEY,
            grn_id INTEGER NOT NULL REFERENCES grns(id) ON DELETE CASCADE,
            stock_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            rate REAL,
            value REAL
          ) STRICT;

          CREATE TABLE purchase_lots (
            id INTEGER PRIMARY KEY,
            stock_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
            supplier_id INTEGER REFERENCES suppliers(id),
            grn_line_id INTEGER UNIQUE REFERENCES grn_lines(id),
            source_type TEXT NOT NULL CHECK (source_type IN ('GRN','LOCAL_GRN','LEGACY_OPENING')),
            source_voucher_guid TEXT NOT NULL DEFAULT '',
            source_voucher_date TEXT NOT NULL DEFAULT '',
            po_number TEXT NOT NULL DEFAULT '',
            grn_number TEXT NOT NULL DEFAULT '',
            receipt_date TEXT NOT NULL,
            challan_number TEXT NOT NULL DEFAULT '',
            challan_date TEXT NOT NULL DEFAULT '',
            quantity_received INTEGER NOT NULL CHECK (quantity_received >= 0),
            quantity_remaining INTEGER NOT NULL CHECK (quantity_remaining >= 0),
            rate REAL,
            value REAL,
            legacy_warning INTEGER NOT NULL DEFAULT 0 CHECK (legacy_warning IN (0,1)),
            created_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE boxes (
            box_id TEXT PRIMARY KEY,
            company_guid TEXT NOT NULL DEFAULT '',
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE box_items (
            box_id TEXT NOT NULL REFERENCES boxes(box_id) ON DELETE CASCADE,
            stock_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
            sort_order INTEGER NOT NULL,
            PRIMARY KEY (box_id, stock_item_id),
            UNIQUE (box_id, sort_order)
          ) STRICT;

          CREATE TABLE inventory_movements (
            id TEXT PRIMARY KEY,
            client_transaction_id TEXT NOT NULL UNIQUE,
            workflow TEXT NOT NULL CHECK (workflow IN ('VENDOR_MATERIAL_IN','MATERIAL_OUT','RETURN_UNUSED')),
            event_date TEXT NOT NULL,
            box_id TEXT NOT NULL DEFAULT '',
            stock_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            destination_item_id INTEGER REFERENCES tally_stock_items(id),
            supplier_id INTEGER REFERENCES suppliers(id),
            purchase_order_id INTEGER REFERENCES purchase_orders(id),
            grn_id INTEGER REFERENCES grns(id),
            status TEXT NOT NULL DEFAULT 'PENDING',
            created_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE movement_lines (
            id INTEGER PRIMARY KEY,
            movement_id TEXT NOT NULL REFERENCES inventory_movements(id) ON DELETE CASCADE,
            stock_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            direction TEXT NOT NULL CHECK (direction IN ('IN','OUT'))
          ) STRICT;

          CREATE TABLE fifo_allocations (
            id INTEGER PRIMARY KEY,
            movement_id TEXT NOT NULL REFERENCES inventory_movements(id) ON DELETE CASCADE,
            purchase_lot_id INTEGER NOT NULL REFERENCES purchase_lots(id),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            direction TEXT NOT NULL CHECK (direction IN ('OUT','RESTORE')),
            source_allocation_id INTEGER REFERENCES fifo_allocations(id),
            created_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE material_out_vouchers (
            id TEXT PRIMARY KEY,
            business_date TEXT NOT NULL,
            issued_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
            destination_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
            quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
            status TEXT NOT NULL DEFAULT 'PENDING',
            external_id TEXT NOT NULL UNIQUE,
            tally_voucher_number TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(business_date, issued_item_id, destination_item_id)
          ) STRICT;

          CREATE TABLE material_out_movement_links (
            material_out_voucher_id TEXT NOT NULL REFERENCES material_out_vouchers(id) ON DELETE CASCADE,
            movement_id TEXT NOT NULL UNIQUE REFERENCES inventory_movements(id),
            net_quantity INTEGER NOT NULL,
            PRIMARY KEY(material_out_voucher_id, movement_id)
          ) STRICT;

          CREATE TABLE tally_export_batches (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            approval_timestamp TEXT,
            approved_by TEXT NOT NULL DEFAULT '',
            payload_hash TEXT NOT NULL DEFAULT '',
            generated_xml_filename TEXT NOT NULL DEFAULT '',
            generated_excel_filename TEXT NOT NULL DEFAULT '',
            generated_csv_filename TEXT NOT NULL DEFAULT '',
            import_status TEXT NOT NULL DEFAULT 'GENERATED',
            tally_voucher_number TEXT NOT NULL DEFAULT ''
          ) STRICT;

          CREATE TABLE tally_export_entries (
            id TEXT PRIMARY KEY,
            batch_id TEXT REFERENCES tally_export_batches(id),
            entity_type TEXT NOT NULL CHECK (entity_type IN ('GRN','MATERIAL_OUT','RETURN_EXCEPTION')),
            entity_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'PENDING',
            external_id TEXT NOT NULL UNIQUE,
            validation_json TEXT NOT NULL DEFAULT '[]',
            reviewed_by TEXT NOT NULL DEFAULT '',
            review_note TEXT NOT NULL DEFAULT '',
            reviewed_at TEXT,
            tally_voucher_number TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(entity_type, entity_id)
          ) STRICT;

          CREATE TABLE tally_import_results (
            id INTEGER PRIMARY KEY,
            batch_id TEXT NOT NULL REFERENCES tally_export_batches(id),
            recorded_at TEXT NOT NULL,
            status TEXT NOT NULL,
            tally_voucher_number TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT ''
          ) STRICT;

          CREATE TABLE sync_history (
            id INTEGER PRIMARY KEY,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            status TEXT NOT NULL,
            summary_json TEXT NOT NULL DEFAULT '{}',
            warnings_json TEXT NOT NULL DEFAULT '[]'
          ) STRICT;

          CREATE INDEX idx_purchase_lots_fifo
            ON purchase_lots(stock_item_id, receipt_date, source_voucher_date, id);
          CREATE INDEX idx_movements_date
            ON inventory_movements(event_date, workflow);
          CREATE INDEX idx_export_entries_status
            ON tally_export_entries(status, entity_type);
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, nowIso());
      });
    }

    if (current < 2) {
      this.transaction(() => {
        this.db.exec("ALTER TABLE grns ADD COLUMN client_transaction_id TEXT");
        this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS grns_client_transaction_id_unique ON grns(client_transaction_id) WHERE client_transaction_id IS NOT NULL");
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(2, nowIso());
      });
    }

    if (current < 3) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE inventory_adjustments (
            movement_id TEXT PRIMARY KEY REFERENCES inventory_movements(id) ON DELETE CASCADE,
            material_out_voucher_id TEXT NOT NULL REFERENCES material_out_vouchers(id),
            reference_movement_id TEXT NOT NULL REFERENCES inventory_movements(id),
            direction TEXT NOT NULL CHECK (direction IN ('RETURN_TO_STOCK','ADDITIONAL_OUT')),
            reason TEXT NOT NULL CHECK (reason IN ('UNUSED_MATERIAL','MISCOUNT','DATA_ENTRY_ERROR','DAMAGE_OR_LOSS','OTHER')),
            note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX idx_inventory_adjustments_group
            ON inventory_adjustments(material_out_voucher_id, created_at);
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(3, nowIso());
      });
    }

    if (current < 4) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE idempotency_requests (
            client_transaction_id TEXT PRIMARY KEY,
            operation TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            response_json TEXT NOT NULL,
            completed_at TEXT NOT NULL
          ) STRICT;

          CREATE TABLE opening_quantity_adjustments (
            id TEXT PRIMARY KEY,
            client_transaction_id TEXT NOT NULL UNIQUE,
            stock_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
            previous_available_quantity INTEGER NOT NULL,
            target_available_quantity INTEGER NOT NULL CHECK (target_available_quantity >= 0),
            delta_quantity INTEGER NOT NULL,
            reason TEXT NOT NULL,
            adjusted_by TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
          ) STRICT;

          ALTER TABLE tally_export_batches
            ADD COLUMN export_schema_version TEXT NOT NULL DEFAULT '1.0';
          ALTER TABLE tally_export_batches
            ADD COLUMN xml_adapter_version TEXT NOT NULL DEFAULT 'receipt-note-v1/material-out-pending';

          CREATE INDEX idx_opening_adjustments_item
            ON opening_quantity_adjustments(stock_item_id, created_at);
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(4, nowIso());
      }, "migrating the Local Stores Database to schema 4");
    }

    if (current < 5) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE tally_stock_items
            ADD COLUMN source TEXT NOT NULL DEFAULT 'TALLY'
            CHECK (source IN ('TALLY','LOCAL'));
          CREATE INDEX idx_stock_items_source
            ON tally_stock_items(source, active, name);
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(5, nowIso());
      }, "migrating the Local Stores Database to schema 5");
    }

    if (current < 6) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE tally_stock_items
            ADD COLUMN catalog_status TEXT NOT NULL DEFAULT 'ACTIVE'
            CHECK (catalog_status IN ('ACTIVE','DUPLICATE','OBSOLETE'));
          ALTER TABLE tally_stock_items
            ADD COLUMN duplicate_of_item_id INTEGER REFERENCES tally_stock_items(id);
          ALTER TABLE tally_stock_items
            ADD COLUMN catalog_updated_at TEXT;
          CREATE INDEX idx_stock_items_catalog_status
            ON tally_stock_items(catalog_status, duplicate_of_item_id, active, name);
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(6, nowIso());
      }, "migrating the Local Stores Database to schema 6");
    }

    if (current < 7) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE tally_stock_items
            ADD COLUMN local_name_override TEXT;
          CREATE INDEX idx_stock_items_local_name_override
            ON tally_stock_items(local_name_override COLLATE NOCASE);
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(7, nowIso());
      }, "migrating the Local Stores Database to schema 7");
    }

    if (current < 8) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE grn_lines
            ADD COLUMN rejected_quantity INTEGER NOT NULL DEFAULT 0
            CHECK (rejected_quantity >= 0 AND rejected_quantity <= quantity);
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(8, nowIso());
      }, "adding rejected Material In quantities");
    }

    if (current < 9) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE tally_stock_items
            ADD COLUMN catalog_role_override TEXT
            CHECK (catalog_role_override IS NULL OR catalog_role_override IN ('FINISHED_PRODUCT','COMPONENT','ACCESSORY','PACKAGING','OTHER'));
          ALTER TABLE tally_stock_items
            ADD COLUMN catalog_ignored INTEGER NOT NULL DEFAULT 0
            CHECK (catalog_ignored IN (0,1));
          CREATE TABLE catalog_group_settings (
            group_name TEXT PRIMARY KEY COLLATE NOCASE,
            catalog_role TEXT NOT NULL DEFAULT 'OTHER'
              CHECK (catalog_role IN ('FINISHED_PRODUCT','COMPONENT','ACCESSORY','PACKAGING','OTHER')),
            ignored INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0,1)),
            updated_at TEXT NOT NULL
          ) STRICT;
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(9, nowIso());
      }, "adding catalog roles and ignore settings");
    }

    if (current < 10) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE tally_stock_groups (
            name TEXT PRIMARY KEY COLLATE NOCASE,
            parent_name TEXT NOT NULL DEFAULT '',
            tally_guid TEXT NOT NULL DEFAULT '',
            alter_id TEXT NOT NULL DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
            synced_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX idx_tally_stock_groups_parent
            ON tally_stock_groups(parent_name COLLATE NOCASE, active, name COLLATE NOCASE);
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(10, nowIso());
      }, "adding primary and secondary Tally group hierarchy");
    }

    if (current < 11) {
      this.transaction(() => {
        this.db.exec(`
          ALTER TABLE tally_stock_groups
            ADD COLUMN source TEXT NOT NULL DEFAULT 'TALLY'
            CHECK (source IN ('TALLY','LOCAL'));
          ALTER TABLE tally_stock_items
            ADD COLUMN category_name TEXT NOT NULL DEFAULT '';
          ALTER TABLE tally_stock_items
            ADD COLUMN base_units TEXT NOT NULL DEFAULT 'Nos';
          CREATE TABLE tally_stock_categories (
            name TEXT PRIMARY KEY COLLATE NOCASE,
            parent_name TEXT NOT NULL DEFAULT '',
            tally_guid TEXT NOT NULL DEFAULT '',
            alter_id TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'TALLY'
              CHECK (source IN ('TALLY','LOCAL')),
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
            synced_at TEXT NOT NULL
          ) STRICT;
          CREATE INDEX idx_tally_stock_categories_parent
            ON tally_stock_categories(parent_name COLLATE NOCASE, active, name COLLATE NOCASE);
        `);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(11, nowIso());
      }, "adding local-first Stock Group, Stock Category, and Stock Item masters");
    }
  }

  transaction<T>(work: () => T, operation = "updating inventory"): T {
    return this.host.transaction(operation, work);
  }

  private getSetting<T = unknown>(key: string): T | null {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as Row | undefined;
    return row ? parseJson<T>(row.value_json, null as T) : null;
  }

  private setSetting(key: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, json(value), nowIso());
  }

  runIdempotent<T>(
    clientTransactionId: string,
    operation: string,
    payload: unknown,
    work: () => T,
  ): T {
    const id = text(clientTransactionId);
    if (!id) throw new Error("A stable client transaction ID is required.");
    return this.transaction(() => {
      const hash = payloadHash(payload);
      const existing = this.db.prepare(`
        SELECT operation, payload_hash, response_json
        FROM idempotency_requests WHERE client_transaction_id = ?
      `).get(id) as Row | undefined;
      if (existing) {
        if (text(existing.operation) !== operation || text(existing.payload_hash) !== hash) {
          throw new Error(
            "This transaction ID was already used for different data. Keep the original ID only when retrying the same operation.",
          );
        }
        return parseJson<T>(existing.response_json, null as T);
      }
      const result = work();
      this.db.prepare(`
        INSERT INTO idempotency_requests(
          client_transaction_id, operation, payload_hash, response_json, completed_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(id, operation, hash, json(result), nowIso());
      return result;
    }, `processing ${operation}`);
  }

  getDataMode(): StoresDataMode {
    const configured = this.getSetting<StoresDataMode>("data_mode");
    if (configured === "demo" || configured === "local" || configured === "tally" || configured === "empty") {
      return configured;
    }
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count,
        SUM(CASE WHEN source = 'TALLY' THEN 1 ELSE 0 END) AS tally_count
      FROM tally_stock_items WHERE active = 1
    `).get() as Row;
    return Number(row.count) === 0 ? "empty" : Number(row.tally_count) > 0 ? "tally" : "local";
  }

  setDataMode(mode: StoresDataMode): void {
    this.setSetting("data_mode", mode);
  }

  rememberTallyCompany(snapshot: Pick<TallyStoresSnapshot, "company" | "companyGuid" | "syncedAt">): void {
    this.setSetting("tally_company_guid", snapshot.companyGuid);
    this.setSetting("tally_company_name", snapshot.company);
    this.setSetting("last_tally_sync_at", snapshot.syncedAt);
  }

  resetDemoDataForTallySync(): StoresBackupResult | null {
    if (this.getDataMode() !== "demo") return null;
    const backup = this.backup("before-replacing-demo-data");
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM ops_count_entries;
        DELETE FROM ops_count_items;
        DELETE FROM ops_count_sessions;
        DELETE FROM ops_supplier_fault_resolutions;
        DELETE FROM ops_supplier_returns;
        DELETE FROM ops_customer_returns;
        DELETE FROM ops_scrap_records;
        DELETE FROM ops_tally_reviews;
        DELETE FROM ops_movement_serials;
        DELETE FROM ops_movement_lot_lines;
        DELETE FROM ops_movements;
        DELETE FROM ops_supplier_faults;
        DELETE FROM ops_serials;
        DELETE FROM ops_lot_balances;
        DELETE FROM ops_lots;
        DELETE FROM ops_sync_exceptions;
        DELETE FROM ops_production_executions;
        DELETE FROM ops_idempotency;
        DELETE FROM ops_audit_events;
        DELETE FROM tally_import_results;
        DELETE FROM idempotency_requests;
        DELETE FROM opening_quantity_adjustments;
        DELETE FROM tally_export_entries;
        DELETE FROM tally_export_batches;
        DELETE FROM material_out_movement_links;
        DELETE FROM inventory_adjustments;
        DELETE FROM material_out_vouchers;
        DELETE FROM fifo_allocations;
        DELETE FROM movement_lines;
        DELETE FROM inventory_movements;
        DELETE FROM box_items;
        DELETE FROM boxes;
        DELETE FROM purchase_lots;
        DELETE FROM grn_lines;
        DELETE FROM grns;
        DELETE FROM purchase_order_lines;
        DELETE FROM purchase_orders;
        DELETE FROM bom_components;
        DELETE FROM suppliers;
        DELETE FROM tally_stock_items;
        DELETE FROM tally_stock_categories;
        DELETE FROM tally_stock_groups;
        DELETE FROM catalog_group_settings;
        DELETE FROM sync_history;
        DELETE FROM settings
        WHERE key NOT IN ('backup_folder', 'export_folder', 'material_out_xml_configured', 'application_database_host_id');
      `);
      this.setSetting("data_mode", "empty");
    });
    return backup;
  }

  setBackupFolder(folder: string): void {
    if (!path.isAbsolute(folder)) throw new Error("Backup folder must be an absolute path.");
    mkdirSync(folder, { recursive: true });
    this.setSetting("backup_folder", path.normalize(folder));
  }

  getBackupFolder(): string {
    return this.getSetting<string>("backup_folder") || this.defaultBackupFolder;
  }

  setExportFolder(folder: string): void {
    if (!path.isAbsolute(folder)) throw new Error("Export folder must be an absolute path.");
    mkdirSync(folder, { recursive: true });
    this.setSetting("export_folder", path.normalize(folder));
  }

  getExportFolder(defaultFolder: string): string {
    return this.getSetting<string>("export_folder") || defaultFolder;
  }

  backup(label = "manual"): StoresBackupResult {
    const backupFolder = this.getBackupFolder();
    mkdirSync(backupFolder, { recursive: true });
    const createdAt = nowIso();
    const safeLabel = label.replace(/[^a-z0-9_-]+/gi, "-");
    const backupPath = path.join(
      backupFolder,
      `inventory-scanner-${safeLabel}-${createdAt.replace(/[:.]/g, "-")}.sqlite`,
    );
    this.createVerifiedBackup(this.db, backupPath);
    this.pruneBackups(backupFolder);
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;");
    } catch {
      // The validated snapshot is still usable if optional SQLite housekeeping
      // is temporarily blocked by another request.
    }

    return { path: backupPath, createdAt, valid: true };
  }

  backupIfDue(intervalMs: number, now = new Date()): StoresBackupResult | null {
    const backupFolder = this.getBackupFolder();
    mkdirSync(backupFolder, { recursive: true });
    const latestMtime = readdirSync(backupFolder)
      .filter((name) => name.endsWith(".sqlite"))
      .map((name) => statSync(path.join(backupFolder, name)).mtimeMs)
      .reduce((latest, value) => Math.max(latest, value), 0);
    if (latestMtime > 0 && now.getTime() - latestMtime < intervalMs) {
      this.pruneBackups(backupFolder);
      return null;
    }
    return this.backup("automatic-2-hour");
  }

  private schemaVersionForFile(databasePath: string): number {
    const check = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const table = check.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      ).get();
      if (!table) return 0;
      const row = check.prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      ).get() as Row | undefined;
      return Number(row?.version ?? 0);
    } finally {
      check.close();
    }
  }

  listBackups(): StoresBackupInfo[] {
    const folder = this.getBackupFolder();
    if (!existsSync(folder)) return [];
    const candidates = readdirSync(folder)
      .filter((name) => name.endsWith(".sqlite"))
      .map((fileName) => {
        const backupPath = path.join(folder, fileName);
        return {
          fileName,
          path: backupPath,
          mtime: statSync(backupPath).mtimeMs,
        };
      });
    const retained = retainedBackupPaths(candidates);
    return candidates
      .filter((candidate) => retained.has(candidate.path))
      .map((candidate) => {
        const stats = statSync(candidate.path);
        let valid = false;
        let schemaVersion = 0;
        try {
          valid = this.validateBackupFile(candidate.path, true);
          schemaVersion = this.schemaVersionForFile(candidate.path);
        } catch {
          valid = false;
        }
        return {
          path: candidate.path,
          fileName: candidate.fileName,
          createdAt: stats.mtime.toISOString(),
          sizeBytes: stats.size,
          valid,
          schemaVersion,
        };
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  restoreBackup(backupPathValue: string): StoresRestoreResult {
    const backupPath = path.normalize(backupPathValue);
    if (!path.isAbsolute(backupPath) || !existsSync(backupPath)) {
      throw new Error("Choose an existing SQLite backup file.");
    }
    if (backupPath === this.databasePath) {
      throw new Error("Choose a backup snapshot, not the active SQLite database.");
    }
    const temporary = `${this.databasePath}.restore-${randomUUID()}.partial`;
    const rollback = `${this.databasePath}.pre-restore-${randomUUID()}`;
    copyFileSync(backupPath, temporary);
    if (!this.validateBackupFile(temporary)) {
      unlinkSync(temporary);
      throw new Error("The selected backup failed SQLite integrity validation after copying.");
    }
    const backupSchema = this.schemaVersionForFile(temporary);
    if (backupSchema > SCHEMA_VERSION) {
      unlinkSync(temporary);
      throw new Error(
        `This backup uses schema ${backupSchema}, which is newer than this application supports (${SCHEMA_VERSION}).`,
      );
    }
    const safety = this.backup("before-restore");

    this.host.close();
    for (const sidecar of [`${this.databasePath}-wal`, `${this.databasePath}-shm`]) {
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
    if (existsSync(this.databasePath)) renameSync(this.databasePath, rollback);

    try {
      renameSync(temporary, this.databasePath);
      this.host.open();
      this.migrate();
      this.ensureDefaultSettings();
      if (!this.validateBackupFile(this.databasePath)) {
        throw new Error("The restored database failed its post-restore integrity check.");
      }
      if (existsSync(rollback)) unlinkSync(rollback);
      return {
        restoredFrom: backupPath,
        safetyBackupPath: safety.path,
        restoredAt: nowIso(),
        state: this.getState(),
      };
    } catch (error) {
      this.host.close();
      if (existsSync(this.databasePath)) unlinkSync(this.databasePath);
      if (existsSync(rollback)) renameSync(rollback, this.databasePath);
      this.host.open();
      this.migrate();
      this.ensureDefaultSettings();
      throw error;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private upsertStockItem(item: TallyStoresSnapshot["stockItems"][number], syncedAt: string): number {
    const guid = itemIdentity(item.guid, item.name);
    const closingQuantity = Number.isInteger(item.closingQuantity) ? item.closingQuantity ?? 0 : 0;
    const localByName = this.db.prepare(`
      SELECT id FROM tally_stock_items
      WHERE COALESCE(NULLIF(local_name_override, ''), name) = ? COLLATE NOCASE
        AND source = 'LOCAL'
    `).get(item.name) as Row | undefined;
    if (localByName) {
      // A locally introduced component can be promoted to its real Tally
      // identity later without changing any foreign-key relationships.
      this.db.prepare(`
        UPDATE tally_stock_items SET
          tally_guid = ?, name = ?, parent_name = ?, category_name = ?, has_bom = ?,
          tally_closing_quantity = ?, active = 1, source = 'TALLY',
          local_name_override = NULL, synced_at = ?
        WHERE id = ?
      `).run(guid, item.name, item.parent, item.category, item.hasBom ? 1 : 0, closingQuantity, syncedAt, localByName.id);
      return Number(localByName.id);
    }
    this.db.prepare(`
      INSERT INTO tally_stock_items(
        tally_guid, name, parent_name, category_name, has_bom,
        tally_closing_quantity, active, synced_at, source
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'TALLY')
      ON CONFLICT(tally_guid) DO UPDATE SET
        name = excluded.name,
        parent_name = excluded.parent_name,
        category_name = excluded.category_name,
        has_bom = excluded.has_bom,
        tally_closing_quantity = excluded.tally_closing_quantity,
        active = 1,
        source = 'TALLY',
        synced_at = excluded.synced_at
    `).run(guid, item.name, item.parent, item.category, item.hasBom ? 1 : 0, closingQuantity, syncedAt);
    this.db.prepare(`
      UPDATE tally_stock_items
      SET local_name_override = NULL
      WHERE tally_guid = ?
        AND local_name_override = name COLLATE NOCASE
    `).run(guid);
    const row = this.db.prepare("SELECT id FROM tally_stock_items WHERE tally_guid = ?").get(guid) as Row;
    return Number(row.id);
  }

  createLocalStockItem(input: CreateLocalStockItemInput): StoresStockItem {
    const name = text(input.name);
    if (!name) throw new Error("Local Stock Item name is required.");
    const parentName = text(input.parentName) || "Local Components";
    const categoryName = text(input.categoryName);
    const baseUnits = text(input.baseUnits) || "Nos";
    return this.transaction(() => {
      const parent = this.db.prepare(`
        SELECT name FROM tally_stock_groups WHERE name = ? COLLATE NOCASE AND active = 1
      `).get(parentName) as Row | undefined;
      if (!parent) this.createCatalogGroup({ name: parentName });
      if (categoryName) {
        const category = this.db.prepare(`
          SELECT name FROM tally_stock_categories WHERE name = ? COLLATE NOCASE AND active = 1
        `).get(categoryName) as Row | undefined;
        if (!category) throw new Error("Choose an existing Stock Category.");
      }
      const existing = this.db.prepare(`
        SELECT tally_guid, source FROM tally_stock_items WHERE name = ? COLLATE NOCASE
      `).get(name) as Row | undefined;
      if (!existing) {
        this.db.prepare(`
          INSERT INTO tally_stock_items(
            tally_guid, name, parent_name, has_bom, tally_closing_quantity,
            active, synced_at, source, category_name, base_units
          ) VALUES (?, ?, ?, 0, 0, 1, ?, 'LOCAL', ?, ?)
        `).run(`LOCAL:${randomUUID()}`, name, parentName, nowIso(), categoryName, baseUnits);
      } else {
        if (text(existing.source) !== "LOCAL") {
          throw new Error("A Tally-synchronized Stock Item already uses that name.");
        }
        this.db.prepare(`
          UPDATE tally_stock_items
          SET active = 1, parent_name = ?, category_name = ?, base_units = ?
          WHERE tally_guid = ?
        `).run(parentName, categoryName, baseUnits, existing.tally_guid);
      }
      if (this.getDataMode() === "empty") this.setDataMode("local");
      return this.getState().stockItems.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())!;
    }, "creating a local Stores Catalog item");
  }

  createCatalogGroup(input: CreateCatalogGroupInput): void {
    const name = text(input.name);
    const parentName = text(input.parentName) || "Primary";
    if (!name) throw new Error("Stock Group name is required.");
    if (name.toLocaleLowerCase() === "primary") throw new Error("Primary is reserved by Tally.");
    if (name.toLocaleLowerCase() === parentName.toLocaleLowerCase()) {
      throw new Error("A Stock Group cannot be its own parent.");
    }
    if (parentName.toLocaleLowerCase() !== "primary") {
      let parent = this.db.prepare(`
        SELECT name FROM tally_stock_groups WHERE name = ? COLLATE NOCASE AND active = 1
      `).get(parentName) as Row | undefined;
      if (!parent) {
        const implicitParent = this.db.prepare(`
          SELECT 1 FROM tally_stock_items WHERE parent_name = ? COLLATE NOCASE AND active = 1 LIMIT 1
        `).get(parentName) as Row | undefined;
        if (implicitParent) {
          this.createCatalogGroup({ name: parentName });
          parent = this.db.prepare(`
            SELECT name FROM tally_stock_groups WHERE name = ? COLLATE NOCASE AND active = 1
          `).get(parentName) as Row | undefined;
        }
      }
      if (!parent) throw new Error("Choose an existing parent Stock Group.");
    }
    const existing = this.db.prepare(`
      SELECT source FROM tally_stock_groups WHERE name = ? COLLATE NOCASE
    `).get(name) as Row | undefined;
    if (existing && text(existing.source) !== "LOCAL") {
      throw new Error("That Stock Group already comes from Tally and cannot be redefined locally.");
    }
    let ancestor = parentName;
    const visited = new Set<string>();
    while (ancestor && ancestor.toLocaleLowerCase() !== "primary") {
      const key = ancestor.toLocaleLowerCase();
      if (key === name.toLocaleLowerCase()) {
        throw new Error("This parent would create a circular Stock Group hierarchy.");
      }
      if (visited.has(key)) throw new Error("The existing Stock Group hierarchy contains a cycle.");
      visited.add(key);
      const row = this.db.prepare(`
        SELECT parent_name FROM tally_stock_groups WHERE name = ? COLLATE NOCASE
      `).get(ancestor) as Row | undefined;
      ancestor = text(row?.parent_name);
    }
    this.db.prepare(`
      INSERT INTO tally_stock_groups(name, parent_name, active, synced_at, source)
      VALUES (?, ?, 1, ?, 'LOCAL')
      ON CONFLICT(name) DO UPDATE SET
        parent_name = excluded.parent_name,
        active = 1,
        synced_at = excluded.synced_at
    `).run(name, parentName, nowIso());
    if (this.getDataMode() === "empty") this.setDataMode("local");
  }

  deleteCatalogGroup(input: DeleteCatalogGroupInput): void {
    const name = text(input.name);
    const group = this.db.prepare(`
      SELECT name, source FROM tally_stock_groups WHERE name = ? COLLATE NOCASE AND active = 1
    `).get(name) as Row | undefined;
    if (!group) throw new Error("The selected Stock Group is no longer available.");
    if (text(group.source) !== "LOCAL") {
      throw new Error("A Tally-synchronized Stock Group cannot be deleted locally. Remove it in Tally or stop using it.");
    }
    const child = this.db.prepare(`
      SELECT name FROM tally_stock_groups WHERE parent_name = ? COLLATE NOCASE AND active = 1 LIMIT 1
    `).get(name) as Row | undefined;
    if (child) throw new Error(`Move or delete child Stock Group ${text(child.name)} first.`);
    const item = this.db.prepare(`
      SELECT name FROM tally_stock_items WHERE parent_name = ? COLLATE NOCASE AND active = 1 LIMIT 1
    `).get(name) as Row | undefined;
    if (item) throw new Error(`Move or delete Stock Item ${text(item.name)} first.`);
    this.db.prepare("DELETE FROM catalog_group_settings WHERE group_name = ? COLLATE NOCASE").run(name);
    this.db.prepare("DELETE FROM tally_stock_groups WHERE name = ? COLLATE NOCASE").run(name);
  }

  createStockCategory(input: CreateStockCategoryInput): void {
    const name = text(input.name);
    const parentName = text(input.parentName) || "Primary";
    if (!name) throw new Error("Stock Category name is required.");
    if (name.toLocaleLowerCase() === "primary") throw new Error("Primary is reserved by Tally.");
    if (name.toLocaleLowerCase() === parentName.toLocaleLowerCase()) {
      throw new Error("A Stock Category cannot be its own parent.");
    }
    if (parentName.toLocaleLowerCase() !== "primary") {
      const parent = this.db.prepare(`
        SELECT name FROM tally_stock_categories WHERE name = ? COLLATE NOCASE AND active = 1
      `).get(parentName) as Row | undefined;
      if (!parent) throw new Error("Choose an existing parent Stock Category.");
    }
    const existing = this.db.prepare(`
      SELECT source FROM tally_stock_categories WHERE name = ? COLLATE NOCASE
    `).get(name) as Row | undefined;
    if (existing && text(existing.source) !== "LOCAL") {
      throw new Error("That Stock Category already comes from Tally and cannot be redefined locally.");
    }
    let ancestor = parentName;
    const visited = new Set<string>();
    while (ancestor && ancestor.toLocaleLowerCase() !== "primary") {
      const key = ancestor.toLocaleLowerCase();
      if (key === name.toLocaleLowerCase()) {
        throw new Error("This parent would create a circular Stock Category hierarchy.");
      }
      if (visited.has(key)) throw new Error("The existing Stock Category hierarchy contains a cycle.");
      visited.add(key);
      const row = this.db.prepare(`
        SELECT parent_name FROM tally_stock_categories WHERE name = ? COLLATE NOCASE
      `).get(ancestor) as Row | undefined;
      ancestor = text(row?.parent_name);
    }
    this.db.prepare(`
      INSERT INTO tally_stock_categories(name, parent_name, active, synced_at, source)
      VALUES (?, ?, 1, ?, 'LOCAL')
      ON CONFLICT(name) DO UPDATE SET
        parent_name = excluded.parent_name,
        active = 1,
        synced_at = excluded.synced_at
    `).run(name, parentName, nowIso());
    if (this.getDataMode() === "empty") this.setDataMode("local");
  }

  deleteStockCategory(input: DeleteStockCategoryInput): void {
    const name = text(input.name);
    const category = this.db.prepare(`
      SELECT name, source FROM tally_stock_categories WHERE name = ? COLLATE NOCASE AND active = 1
    `).get(name) as Row | undefined;
    if (!category) throw new Error("The selected Stock Category is no longer available.");
    if (text(category.source) !== "LOCAL") {
      throw new Error("A Tally-synchronized Stock Category cannot be deleted locally. Remove it in Tally or stop using it.");
    }
    const child = this.db.prepare(`
      SELECT name FROM tally_stock_categories WHERE parent_name = ? COLLATE NOCASE AND active = 1 LIMIT 1
    `).get(name) as Row | undefined;
    if (child) throw new Error(`Move or delete child Stock Category ${text(child.name)} first.`);
    const item = this.db.prepare(`
      SELECT name FROM tally_stock_items WHERE category_name = ? COLLATE NOCASE AND active = 1 LIMIT 1
    `).get(name) as Row | undefined;
    if (item) throw new Error(`Move or delete Stock Item ${text(item.name)} first.`);
    this.db.prepare("DELETE FROM tally_stock_categories WHERE name = ? COLLATE NOCASE").run(name);
  }

  deleteStockItem(input: DeleteStockItemInput): void {
    const guid = text(input.tallyItemGuid);
    const item = this.db.prepare(`
      SELECT id, name, source FROM tally_stock_items WHERE tally_guid = ? AND active = 1
    `).get(guid) as Row | undefined;
    if (!item) throw new Error("The selected Stock Item is no longer available.");
    if (text(item.source) !== "LOCAL") {
      throw new Error("A Tally-synchronized Stock Item cannot be deleted locally. Mark it obsolete instead.");
    }
    const tables = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all() as Row[];
    let referenceCount = 0;
    for (const table of tables) {
      const tableName = text(table.name);
      const safeTable = tableName.replaceAll('"', '""');
      const foreignKeys = this.db.prepare(`PRAGMA foreign_key_list("${safeTable}")`).all() as Row[];
      for (const foreignKey of foreignKeys) {
        if (text(foreignKey.table) !== "tally_stock_items") continue;
        const columnName = text(foreignKey.from);
        const safeColumn = columnName.replaceAll('"', '""');
        const row = this.db.prepare(`
          SELECT COUNT(*) AS count FROM "${safeTable}" WHERE "${safeColumn}" = ?
        `).get(item.id) as Row;
        referenceCount += Number(row.count);
      }
    }
    if (referenceCount > 0) {
      throw new Error(`${text(item.name)} is already referenced by inventory or planning records and cannot be deleted. Mark it obsolete instead.`);
    }
    this.db.prepare("DELETE FROM tally_stock_items WHERE id = ?").run(item.id);
  }

  setCatalogStatus(input: SetCatalogStatusInput): void {
    const tallyItemGuid = text(input.tallyItemGuid);
    const status = text(input.status);
    if (!tallyItemGuid) throw new Error("Choose a Stock Item to update.");
    if (!["ACTIVE", "DUPLICATE", "OBSOLETE"].includes(status)) {
      throw new Error("Choose whether the Stock Item is active, duplicate, or obsolete.");
    }

    this.transaction(() => {
      const item = this.db.prepare(`
        SELECT id, name FROM tally_stock_items WHERE tally_guid = ? AND active = 1
      `).get(tallyItemGuid) as Row | undefined;
      if (!item) throw new Error("The selected Stock Item is no longer available.");

      const aliases = Number((this.db.prepare(`
        SELECT COUNT(*) AS count FROM tally_stock_items
        WHERE duplicate_of_item_id = ? AND catalog_status = 'DUPLICATE'
      `).get(item.id) as Row).count);
      if (status !== "ACTIVE" && aliases > 0) {
        throw new Error(
          `${text(item.name)} is the primary item for ${aliases} duplicate entr${aliases === 1 ? "y" : "ies"}. Restore or redirect those duplicates first.`,
        );
      }

      let duplicateOfId: number | null = null;
      if (status === "DUPLICATE") {
        const duplicateOfTallyGuid = text(input.duplicateOfTallyGuid);
        if (!duplicateOfTallyGuid) throw new Error("Choose the primary Stock Item for this duplicate.");
        const primary = this.db.prepare(`
          SELECT id, name, catalog_status FROM tally_stock_items
          WHERE tally_guid = ? AND active = 1
        `).get(duplicateOfTallyGuid) as Row | undefined;
        if (!primary) throw new Error("The selected primary Stock Item is no longer available.");
        if (Number(primary.id) === Number(item.id)) {
          throw new Error("A Stock Item cannot be marked as a duplicate of itself.");
        }
        if (text(primary.catalog_status) !== "ACTIVE") {
          throw new Error("Choose an active, primary Stock Item—not another duplicate or obsolete item.");
        }
        const available = Number((this.db.prepare(`
          SELECT COALESCE(SUM(quantity_remaining), 0) AS quantity
          FROM purchase_lots WHERE stock_item_id = ?
        `).get(item.id) as Row).quantity);
        if (available > 0) {
          throw new Error(
            `${text(item.name)} still has ${available} units in local stock. Reduce its opening count to zero or issue the stock before hiding it as a duplicate.`,
          );
        }
        duplicateOfId = Number(primary.id);
      }

      this.db.prepare(`
        UPDATE tally_stock_items
        SET catalog_status = ?, duplicate_of_item_id = ?, catalog_updated_at = ?
        WHERE id = ?
      `).run(status, duplicateOfId, nowIso(), item.id);
    }, "updating the local Stock Item catalog");
  }

  setCatalogVisibility(input: SetCatalogVisibilityInput): void {
    const groupName = text(input.groupName);
    if (!groupName) throw new Error("Choose a Stock Group.");
    const group = this.db.prepare(`
      SELECT name FROM tally_stock_groups WHERE name = ? COLLATE NOCASE AND active = 1
    `).get(groupName) as Row | undefined;
    if (!group) throw new Error("The selected Stock Group is no longer available.");
    this.db.prepare(`
      INSERT INTO catalog_group_settings(group_name, catalog_role, ignored, updated_at)
      VALUES (?, 'OTHER', ?, ?)
      ON CONFLICT(group_name) DO UPDATE SET
        catalog_role = 'OTHER',
        ignored = excluded.ignored,
        updated_at = excluded.updated_at
    `).run(groupName, input.ignored ? 1 : 0, nowIso());
  }

  renameStockItem(input: RenameStockItemInput): void {
    const tallyItemGuid = text(input.tallyItemGuid);
    const requestedName = text(input.name);
    if (!tallyItemGuid) throw new Error("Choose a Stock Item to rename.");
    if (!requestedName) throw new Error("Enter a new Stock Item name.");

    this.transaction(() => {
      const item = this.db.prepare(`
        SELECT id, name FROM tally_stock_items WHERE tally_guid = ? AND active = 1
      `).get(tallyItemGuid) as Row | undefined;
      if (!item) throw new Error("The selected Stock Item is no longer available.");
      const conflict = this.db.prepare(`
        SELECT id FROM tally_stock_items
        WHERE id <> ? AND active = 1
          AND (
            name = ? COLLATE NOCASE
            OR COALESCE(NULLIF(local_name_override, ''), name) = ? COLLATE NOCASE
          )
      `).get(item.id, requestedName, requestedName) as Row | undefined;
      if (conflict) throw new Error("Another active Stock Item already uses that local name.");
      const override = requestedName.toLocaleLowerCase() === text(item.name).toLocaleLowerCase()
        ? null
        : requestedName;
      this.db.prepare(`
        UPDATE tally_stock_items
        SET local_name_override = ?, catalog_updated_at = ?
        WHERE id = ?
      `).run(override, nowIso(), item.id);
    }, "renaming a local Stock Item");
  }

  private upsertSupplier(name: string, guid: string, syncedAt: string): number {
    const identity = supplierIdentity(guid, name);
    const existingByName = this.db.prepare(`
      SELECT id, tally_guid FROM suppliers WHERE name = ? COLLATE NOCASE
    `).get(name) as Row | undefined;
    if (existingByName && text(existingByName.tally_guid) !== identity) {
      // Supplier names are unique locally. Reuse the existing row when its
      // identity changes so linked POs, GRNs, and lots keep the same FK.
      const identityOwner = this.db.prepare(
        "SELECT id FROM suppliers WHERE tally_guid = ?",
      ).get(identity) as Row | undefined;
      if (!identityOwner || Number(identityOwner.id) === Number(existingByName.id)) {
        this.db.prepare(`
          UPDATE suppliers SET tally_guid = ?, name = ?, synced_at = ? WHERE id = ?
        `).run(identity, name, syncedAt, existingByName.id);
        return Number(existingByName.id);
      }
    }
    this.db.prepare(`
      INSERT INTO suppliers(tally_guid, name, synced_at) VALUES (?, ?, ?)
      ON CONFLICT(tally_guid) DO UPDATE SET name = excluded.name, synced_at = excluded.synced_at
    `).run(identity, name, syncedAt);
    const row = this.db.prepare("SELECT id FROM suppliers WHERE tally_guid = ?").get(identity) as Row;
    return Number(row.id);
  }

  applyTallySnapshot(snapshot: TallyStoresSnapshot): StoresSyncSummary {
    const startedAt = nowIso();
    const warnings = [...snapshot.warnings];
    let summary!: StoresSyncSummary;

    this.transaction(() => {
      const historyInsert = this.db.prepare(
        "INSERT INTO sync_history(started_at, status, summary_json, warnings_json) VALUES (?, 'RUNNING', '{}', '[]')",
      ).run(startedAt);
      const historyId = Number(historyInsert.lastInsertRowid);

      this.db.exec("UPDATE tally_stock_items SET active = 0 WHERE source = 'TALLY'");
      this.db.exec("UPDATE tally_stock_groups SET active = 0 WHERE source = 'TALLY'");
      for (const group of snapshot.stockGroups) {
        this.db.prepare(`
          INSERT INTO tally_stock_groups(
            name, parent_name, tally_guid, alter_id, active, synced_at, source
          ) VALUES (?, ?, ?, ?, 1, ?, 'TALLY')
          ON CONFLICT(name) DO UPDATE SET
            parent_name = excluded.parent_name,
            tally_guid = excluded.tally_guid,
            alter_id = excluded.alter_id,
            active = 1,
            source = 'TALLY',
            synced_at = excluded.synced_at
        `).run(group.name, group.parent, group.guid, group.alterId, snapshot.syncedAt);
      }
      this.db.exec("UPDATE tally_stock_categories SET active = 0 WHERE source = 'TALLY'");
      for (const category of snapshot.stockCategories) {
        this.db.prepare(`
          INSERT INTO tally_stock_categories(
            name, parent_name, tally_guid, alter_id, active, synced_at, source
          ) VALUES (?, ?, ?, ?, 1, ?, 'TALLY')
          ON CONFLICT(name) DO UPDATE SET
            parent_name = excluded.parent_name,
            tally_guid = excluded.tally_guid,
            alter_id = excluded.alter_id,
            active = 1,
            source = 'TALLY',
            synced_at = excluded.synced_at
        `).run(category.name, category.parent, category.guid, category.alterId, snapshot.syncedAt);
      }
      const itemIdByGuid = new Map<string, number>();
      const itemIdByName = new Map<string, number>();
      for (const item of snapshot.stockItems) {
        const id = this.upsertStockItem(item, snapshot.syncedAt);
        itemIdByGuid.set(itemIdentity(item.guid, item.name), id);
        itemIdByName.set(item.name.toLocaleLowerCase(), id);
      }

      this.db.exec("DELETE FROM bom_components");
      for (const component of snapshot.bomComponents) {
        const productId = itemIdByGuid.get(itemIdentity(component.productGuid, component.productName)) ?? itemIdByName.get(component.productName.toLocaleLowerCase());
        const componentId = itemIdByGuid.get(itemIdentity(component.componentGuid, component.componentName)) ?? itemIdByName.get(component.componentName.toLocaleLowerCase());
        if (!productId || !componentId) continue;
        const quantity = component.quantityNumber;
        this.db.prepare(`
          INSERT OR IGNORE INTO bom_components(product_item_id, component_item_id, bom_name, quantity)
          VALUES (?, ?, ?, ?)
        `).run(productId, componentId, component.bomName, Number.isInteger(quantity) ? quantity : null);
      }

      const supplierIdByGuid = new Map<string, number>();
      const supplierIdByName = new Map<string, number>();
      for (const supplier of snapshot.suppliers) {
        const id = this.upsertSupplier(supplier.name, supplier.guid, snapshot.syncedAt);
        supplierIdByGuid.set(supplierIdentity(supplier.guid, supplier.name), id);
        supplierIdByName.set(supplier.name.toLocaleLowerCase(), id);
      }
      const legacySupplierId = this.upsertSupplier(LEGACY_SUPPLIER_NAME, LEGACY_SUPPLIER_GUID, snapshot.syncedAt);

      const poIdByNumber = new Map<string, number>();
      for (const order of snapshot.purchaseOrders) {
        const supplierId = supplierIdByGuid.get(supplierIdentity(order.supplierGuid, order.supplierName)) ?? supplierIdByName.get(order.supplierName.toLocaleLowerCase()) ?? null;
        const guid = order.guid || `PO:${order.voucherDate}:${order.voucherNumber}`;
        this.db.prepare(`
          INSERT INTO purchase_orders(tally_guid, voucher_number, voucher_date, supplier_id, status, reference, synced_at)
          VALUES (?, ?, ?, ?, 'UNKNOWN', ?, ?)
          ON CONFLICT(tally_guid) DO UPDATE SET
            voucher_number = excluded.voucher_number,
            voucher_date = excluded.voucher_date,
            supplier_id = excluded.supplier_id,
            reference = excluded.reference,
            synced_at = excluded.synced_at
        `).run(guid, order.voucherNumber, order.voucherDate, supplierId, sqlValue(order.reference), snapshot.syncedAt);
        const poRow = this.db.prepare("SELECT id FROM purchase_orders WHERE tally_guid = ?").get(guid) as Row;
        const poId = Number(poRow.id);
        poIdByNumber.set(order.voucherNumber.toLocaleLowerCase(), poId);
        this.db.prepare("DELETE FROM purchase_order_lines WHERE purchase_order_id = ?").run(poId);
        for (const line of order.lines) {
          const stockItemId = itemIdByGuid.get(itemIdentity(line.itemGuid, line.itemName)) ?? itemIdByName.get(line.itemName.toLocaleLowerCase());
          if (!stockItemId || !Number.isInteger(line.quantity)) {
            warnings.push(`Purchase Order ${order.voucherNumber}: skipped ${line.itemName || "unnamed item"} because the quantity is not a whole count or the item is unmapped.`);
            continue;
          }
          this.db.prepare(`
            INSERT INTO purchase_order_lines(purchase_order_id, stock_item_id, ordered_quantity, received_quantity, rate, value)
            VALUES (?, ?, ?, 0, ?, ?)
          `).run(poId, stockItemId, line.quantity, sqlValue(line.rate), sqlValue(line.value));
        }
      }

      const cutoverCompleted = this.getSetting<boolean>("fifo_cutover_completed") === true;
      let importedGrns = 0;
      let newlyCreatedLots = 0;
      for (const grn of snapshot.grns) {
        const supplierId = supplierIdByGuid.get(supplierIdentity(grn.supplierGuid, grn.supplierName)) ?? supplierIdByName.get(grn.supplierName.toLocaleLowerCase()) ?? null;
        const poId = poIdByNumber.get(grn.poNumber.toLocaleLowerCase()) ?? null;
        const guid = grn.guid || `GRN:${grn.voucherDate}:${grn.voucherNumber}`;
        const existing = this.db.prepare("SELECT id FROM grns WHERE tally_guid = ?").get(guid) as Row | undefined;
        this.db.prepare(`
          INSERT INTO grns(tally_guid, voucher_number, voucher_date, supplier_id, purchase_order_id, po_number, tracking_number, challan_number, challan_date, source_type, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'TALLY_GRN', ?)
          ON CONFLICT(tally_guid) DO UPDATE SET
            voucher_number = excluded.voucher_number,
            voucher_date = excluded.voucher_date,
            supplier_id = excluded.supplier_id,
            purchase_order_id = excluded.purchase_order_id,
            po_number = excluded.po_number,
            tracking_number = excluded.tracking_number,
            challan_number = excluded.challan_number,
            challan_date = excluded.challan_date,
            synced_at = excluded.synced_at
        `).run(guid, grn.voucherNumber, grn.voucherDate, supplierId, poId, sqlValue(grn.poNumber), sqlValue(grn.trackingNumber), sqlValue(grn.challanNumber), sqlValue(grn.challanDate), snapshot.syncedAt);
        const grnRow = this.db.prepare("SELECT id FROM grns WHERE tally_guid = ?").get(guid) as Row;
        const grnId = Number(grnRow.id);
        if (!existing) importedGrns += 1;

        if (!existing) {
          for (const line of grn.lines) {
            const stockItemId = itemIdByGuid.get(itemIdentity(line.itemGuid, line.itemName)) ?? itemIdByName.get(line.itemName.toLocaleLowerCase());
            if (!stockItemId || !Number.isInteger(line.quantity) || (line.quantity ?? 0) <= 0) {
              warnings.push(`GRN ${grn.voucherNumber}: skipped ${line.itemName || "unnamed item"} because the quantity is not a positive whole count or the item is unmapped.`);
              continue;
            }
            const insert = this.db.prepare(`
              INSERT INTO grn_lines(grn_id, stock_item_id, quantity, rate, value) VALUES (?, ?, ?, ?, ?)
            `).run(grnId, stockItemId, line.quantity, sqlValue(line.rate), sqlValue(line.value));
            const grnLineId = Number(insert.lastInsertRowid);
            const initialRemaining = cutoverCompleted ? 0 : line.quantity;
            this.db.prepare(`
              INSERT INTO purchase_lots(stock_item_id, supplier_id, grn_line_id, source_type, source_voucher_guid, source_voucher_date, po_number, grn_number, receipt_date, challan_number, challan_date, quantity_received, quantity_remaining, rate, value, legacy_warning, created_at)
              VALUES (?, ?, ?, 'GRN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            `).run(stockItemId, supplierId, grnLineId, guid, grn.voucherDate, grn.poNumber, grn.voucherNumber, grn.voucherDate, grn.challanNumber, grn.challanDate, line.quantity, initialRemaining, sqlValue(line.rate), sqlValue(line.value), nowIso());
            newlyCreatedLots += 1;
          }
        }
      }

      this.db.exec(`
        UPDATE purchase_order_lines
        SET received_quantity = COALESCE((
          SELECT SUM(gl.quantity)
          FROM grn_lines gl
          JOIN grns g ON g.id = gl.grn_id
          WHERE g.purchase_order_id = purchase_order_lines.purchase_order_id
            AND gl.stock_item_id = purchase_order_lines.stock_item_id
        ), 0)
      `);
      this.db.exec(`
        UPDATE purchase_orders
        SET status = CASE WHEN EXISTS (
          SELECT 1 FROM purchase_order_lines pol
          WHERE pol.purchase_order_id = purchase_orders.id
            AND pol.received_quantity < pol.ordered_quantity
        ) THEN 'OPEN' ELSE 'CLOSED' END
      `);

      let openingLegacyItems = 0;
      if (cutoverCompleted && importedGrns > 0) {
        const movementCount = Number((this.db.prepare("SELECT COUNT(*) AS count FROM inventory_movements").get() as Row).count);
        if (movementCount === 0) {
          for (const item of snapshot.stockItems) {
            const stockItemId = itemIdByGuid.get(itemIdentity(item.guid, item.name));
            if (!stockItemId) continue;
            const tallyQuantity = Number.isInteger(item.closingQuantity) ? Math.max(0, item.closingQuantity ?? 0) : 0;
            this.db.prepare("UPDATE purchase_lots SET quantity_remaining = 0 WHERE stock_item_id = ? AND source_type = 'GRN'").run(stockItemId);
            this.db.prepare("DELETE FROM purchase_lots WHERE stock_item_id = ? AND source_type = 'LEGACY_OPENING'").run(stockItemId);
            let remaining = tallyQuantity;
            const lots = this.db.prepare(`
              SELECT id, quantity_received FROM purchase_lots
              WHERE stock_item_id = ? AND source_type = 'GRN'
              ORDER BY receipt_date DESC, source_voucher_date DESC, id DESC
            `).all(stockItemId) as Row[];
            for (const lot of lots) {
              if (remaining <= 0) break;
              const allocated = Math.min(remaining, Number(lot.quantity_received));
              this.db.prepare("UPDATE purchase_lots SET quantity_remaining = ? WHERE id = ?").run(allocated, lot.id);
              remaining -= allocated;
            }
            if (remaining > 0) {
              this.db.prepare(`
                INSERT INTO purchase_lots(stock_item_id, supplier_id, source_type, source_voucher_guid, source_voucher_date, grn_number, receipt_date, quantity_received, quantity_remaining, legacy_warning, created_at)
                VALUES (?, ?, 'LEGACY_OPENING', 'LOCAL:LEGACY_OPENING', ?, 'Opening Legacy Stock', ?, ?, ?, 1, ?)
              `).run(stockItemId, legacySupplierId, businessDate(), businessDate(), remaining, remaining, nowIso());
            }
          }
          warnings.push(`Historical Receipt Notes were discovered after the original cutover. Supplier-lot attribution was rebuilt without changing current available quantities.`);
        } else {
          warnings.push(`${importedGrns} newly discovered historical GRNs were retained with zero available quantity because local movements already exist. Review the Opening Legacy Stock report before manually re-attributing those lots.`);
        }
      }

      if (!cutoverCompleted) {
        const movementCount = Number((this.db.prepare("SELECT COUNT(*) AS count FROM inventory_movements").get() as Row).count);
        if (movementCount > 0) {
          throw new Error("FIFO cutover cannot be reconstructed after local movements exist. Restore a pre-movement backup or complete the cutover first.");
        }
        this.db.exec("UPDATE purchase_lots SET quantity_remaining = 0 WHERE source_type = 'GRN'");
        this.db.exec("DELETE FROM purchase_lots WHERE source_type = 'LEGACY_OPENING'");

        for (const item of snapshot.stockItems) {
          const stockItemId = itemIdByGuid.get(itemIdentity(item.guid, item.name));
          if (!stockItemId) continue;
          const tallyQuantity = Number.isInteger(item.closingQuantity) ? Math.max(0, item.closingQuantity ?? 0) : 0;
          let remaining = tallyQuantity;
          const lots = this.db.prepare(`
            SELECT id, quantity_received FROM purchase_lots
            WHERE stock_item_id = ? AND source_type = 'GRN'
            ORDER BY receipt_date DESC, source_voucher_date DESC, id DESC
          `).all(stockItemId) as Row[];
          for (const lot of lots) {
            if (remaining <= 0) break;
            const allocated = Math.min(remaining, Number(lot.quantity_received));
            this.db.prepare("UPDATE purchase_lots SET quantity_remaining = ? WHERE id = ?").run(allocated, lot.id);
            remaining -= allocated;
          }
          if (remaining > 0) {
            this.db.prepare(`
              INSERT INTO purchase_lots(stock_item_id, supplier_id, source_type, source_voucher_guid, source_voucher_date, grn_number, receipt_date, quantity_received, quantity_remaining, legacy_warning, created_at)
              VALUES (?, ?, 'LEGACY_OPENING', 'LOCAL:LEGACY_OPENING', ?, 'Opening Legacy Stock', ?, ?, ?, 1, ?)
            `).run(stockItemId, legacySupplierId, businessDate(), businessDate(), remaining, remaining, nowIso());
            openingLegacyItems += 1;
          }
        }
        this.setSetting("fifo_cutover_completed", true);
        this.setSetting("fifo_cutover_at", nowIso());
      }

      this.setSetting("tally_company_guid", snapshot.companyGuid);
      this.setSetting("tally_company_name", snapshot.company);
      this.setSetting("last_tally_sync_at", snapshot.syncedAt);

      summary = {
        syncedAt: snapshot.syncedAt,
        stockItemsImported: snapshot.stockItems.length,
        suppliersImported: snapshot.suppliers.length,
        openPurchaseOrdersImported: Number((this.db.prepare("SELECT COUNT(*) AS count FROM purchase_orders WHERE status = 'OPEN'").get() as Row).count),
        historicalGrnsImported: importedGrns,
        purchaseLotsReconstructed: Number((this.db.prepare("SELECT COUNT(*) AS count FROM purchase_lots").get() as Row).count),
        openingLegacyItems: Number((this.db.prepare("SELECT COUNT(DISTINCT stock_item_id) AS count FROM purchase_lots WHERE source_type = 'LEGACY_OPENING' AND quantity_remaining > 0").get() as Row).count),
        historicalVouchersScanned: snapshot.historyScan?.vouchersScanned ?? 0,
        inventoryVouchersScanned: snapshot.historyScan?.inventoryVouchersScanned ?? 0,
        receiptNotesDetected: snapshot.historyScan?.receiptNotesFound ?? snapshot.grns.length,
        receiptNoteTypeNames: snapshot.historyScan?.receiptNoteTypeNames ?? [],
        warnings,
      };
      this.db.prepare(`
        UPDATE sync_history SET completed_at = ?, status = 'SUCCESS', summary_json = ?, warnings_json = ? WHERE id = ?
      `).run(nowIso(), json(summary), json(warnings), historyId);
      this.db.exec(`
        DELETE FROM sync_history
        WHERE id NOT IN (SELECT id FROM sync_history ORDER BY id DESC LIMIT 100)
      `);
    });

    return summary;
  }

  saveBox(input: SaveBoxInput): StoresBox {
    const boxId = text(input.boxId);
    if (!boxId) throw new Error("Box ID is required.");
    const itemGuids = [...new Set(input.tallyItemGuids.map(text).filter(Boolean))];
    if (itemGuids.length < 1 || itemGuids.length > 5) {
      throw new Error("A box must contain between one and five distinct Tally Stock Items.");
    }

    return this.transaction(() => {
      const existing = this.db.prepare("SELECT revision, created_at FROM boxes WHERE box_id = ?").get(boxId) as Row | undefined;
      if (existing && input.expectedRevision && Number(existing.revision) !== input.expectedRevision) {
        throw new Error("This box was changed elsewhere. Refresh it before saving again.");
      }
      const ids = itemGuids.map((guid) => {
        return this.itemId(guid);
      });
      const revision = existing ? Number(existing.revision) + 1 : 1;
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO boxes(box_id, company_guid, revision, active, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
        ON CONFLICT(box_id) DO UPDATE SET company_guid = excluded.company_guid, revision = excluded.revision, active = 1, updated_at = excluded.updated_at
      `).run(boxId, text(input.companyId), revision, sqlValue(existing?.created_at ?? timestamp), timestamp);
      this.db.prepare("DELETE FROM box_items WHERE box_id = ?").run(boxId);
      ids.forEach((id, index) => {
        this.db.prepare("INSERT INTO box_items(box_id, stock_item_id, sort_order) VALUES (?, ?, ?)").run(boxId, id, index);
      });
      return this.getBox(boxId)!;
    });
  }

  deleteBox(boxId: string, expectedRevision?: number): void {
    const normalizedBoxId = text(boxId);
    if (!normalizedBoxId) throw new Error("Box ID is required.");

    this.transaction(() => {
      const existing = this.db.prepare("SELECT revision FROM boxes WHERE box_id = ? AND active = 1").get(normalizedBoxId) as Row | undefined;
      if (!existing) throw new Error("This box no longer exists.");
      if (expectedRevision != null && Number(existing.revision) !== expectedRevision) {
        throw new Error("This box was changed elsewhere. Refresh it before deleting.");
      }
      this.db.prepare(`
        UPDATE boxes
        SET active = 0, revision = revision + 1, updated_at = ?
        WHERE box_id = ?
      `).run(nowIso(), normalizedBoxId);
    });
  }

  getBox(boxId: string): StoresBox | null {
    const row = this.db.prepare("SELECT * FROM boxes WHERE box_id = ? AND active = 1").get(boxId) as Row | undefined;
    if (!row) return null;
    const items = this.db.prepare(`
      SELECT tsi.id AS stock_item_id, tsi.tally_guid,
        COALESCE(NULLIF(tsi.local_name_override, ''), tsi.name) AS name, bi.sort_order
      FROM box_items bi JOIN tally_stock_items tsi ON tsi.id = bi.stock_item_id
      WHERE bi.box_id = ? ORDER BY bi.sort_order
    `).all(boxId) as Row[];
    return {
      boxId: text(row.box_id),
      companyId: text(row.company_guid),
      revision: Number(row.revision),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
      items: items.map((item) => ({
        stockItemId: Number(item.stock_item_id),
        tallyItemGuid: text(item.tally_guid),
        itemName: text(item.name),
        sortOrder: Number(item.sort_order),
      })),
    };
  }

  private itemId(guid: string): number {
    const row = this.db.prepare(`
      SELECT item.id, item.name, item.catalog_status,
        COALESCE((SELECT SUM(quantity_remaining) FROM purchase_lots WHERE stock_item_id = item.id), 0) AS local_available
      FROM tally_stock_items item
      WHERE item.tally_guid = ? AND item.active = 1
    `).get(guid) as Row | undefined;
    if (!row) throw new Error("The selected Tally Stock Item is not available in the synchronized Stores Catalog.");
    if (text(row.catalog_status) === "DUPLICATE") {
      throw new Error(`${text(row.name)} is marked as a duplicate and is not available for new operations.`);
    }
    if (text(row.catalog_status) === "OBSOLETE" && Number(row.local_available) <= 0) {
      throw new Error(`${text(row.name)} is obsolete and has no remaining local stock.`);
    }
    return Number(row.id);
  }

  private ensureBoxContains(boxId: string, stockItemId: number): void {
    if (!boxId) return;
    const row = this.db.prepare("SELECT 1 AS ok FROM box_items WHERE box_id = ? AND stock_item_id = ?").get(boxId, stockItemId);
    if (!row) throw new Error("The selected item is not currently assigned to this box.");
  }

  private movementsForGrn(grnId: number): StoresMovement[] {
    const rows = this.db.prepare(`
      SELECT m.*, item.tally_guid,
        COALESCE(NULLIF(item.local_name_override, ''), item.name) AS item_name,
        COALESCE(NULLIF(destination.local_name_override, ''), destination.name) AS destination_name,
        supplier.name AS supplier_name,
        po.voucher_number AS po_number,
        grn.challan_number
      FROM inventory_movements m
      JOIN tally_stock_items item ON item.id = m.stock_item_id
      LEFT JOIN tally_stock_items destination ON destination.id = m.destination_item_id
      LEFT JOIN suppliers supplier ON supplier.id = m.supplier_id
      LEFT JOIN purchase_orders po ON po.id = m.purchase_order_id
      LEFT JOIN grns grn ON grn.id = m.grn_id
      WHERE m.grn_id = ?
      ORDER BY m.created_at, item.name
    `).all(grnId) as Row[];
    return rows.map((row) => this.mapMovement(row));
  }

  recordBulkVendorReceipt(input: BulkVendorReceiptInput): BulkVendorReceiptResult {
    const clientTransactionId = text(input.clientTransactionId);
    if (!clientTransactionId) throw new Error("A stable receipt transaction ID is required.");
    const challanNumber = text(input.challanNumber);
    if (!challanNumber) throw new Error("Supplier challan number is required.");
    const challanDate = businessDate(input.challanDate);
    const eventDate = businessDate(input.receiptDate);
    const normalizedLines = (Array.isArray(input.lines) ? input.lines : [])
      .map((line) => ({ ...line, tallyItemGuid: text(line.tallyItemGuid), quantity: integerQuantity(line.quantity) }))
      .filter((line) => line.tallyItemGuid);
    const duplicateGuids = normalizedLines.filter((line, index) =>
      normalizedLines.findIndex((candidate) => candidate.tallyItemGuid === line.tallyItemGuid) !== index,
    );
    if (normalizedLines.length === 0) throw new Error("Add at least one received Stock Item.");
    if (duplicateGuids.length > 0) throw new Error("Each Stock Item can appear only once in a bulk receipt.");

    return this.transaction(() => {
      const existing = this.db.prepare(
        "SELECT id, voucher_number FROM grns WHERE client_transaction_id = ?",
      ).get(clientTransactionId) as Row | undefined;
      if (existing) {
        return {
          grnNumber: text(existing.voucher_number),
          movements: this.movementsForGrn(Number(existing.id)),
        };
      }

      const supplier = this.db.prepare("SELECT id, name FROM suppliers WHERE id = ?").get(input.supplierId) as Row | undefined;
      if (!supplier) throw new Error("Select a synchronized supplier.");

      let poNumber = "";
      const poId = input.purchaseOrderId ?? null;
      let purchaseOrder: Row | undefined;
      if (poId) {
        purchaseOrder = this.db.prepare(
          "SELECT id, voucher_number, supplier_id FROM purchase_orders WHERE id = ? AND status = 'OPEN'",
        ).get(poId) as Row | undefined;
        if (!purchaseOrder) throw new Error("The selected open Purchase Order is no longer available.");
        if (Number(purchaseOrder.supplier_id) !== Number(supplier.id)) {
          throw new Error("The Purchase Order belongs to a different supplier.");
        }
        poNumber = text(purchaseOrder.voucher_number);
      } else if (!input.nonPoException) {
        throw new Error("Choose a Purchase Order, or mark this as a non-PO exception for review.");
      }

      const resolvedLines = normalizedLines.map((line) => {
        const rejectedQuantity = Number(line.rejectedQuantity ?? 0);
        if (!Number.isInteger(rejectedQuantity) || rejectedQuantity < 0 || rejectedQuantity > line.quantity) {
          throw new Error("Rejected quantity must be a whole number between zero and the received quantity.");
        }
        const acceptedQuantity = line.quantity - rejectedQuantity;
        const stockItemId = this.itemId(line.tallyItemGuid);
        let poLine: Row | undefined;
        if (poId) {
          poLine = this.db.prepare(`
            SELECT id, ordered_quantity, received_quantity, rate, value
            FROM purchase_order_lines
            WHERE purchase_order_id = ? AND stock_item_id = ?
          `).get(poId, stockItemId) as Row | undefined;
          if (!poLine && line.discrepancyType !== "WRONG_ITEM") {
            throw new Error("One of the selected Stock Items is not present on that Purchase Order. Mark it as Wrong item received to record the discrepancy.");
          }
          const outstanding = poLine
            ? Math.max(0, Number(poLine.ordered_quantity) - Number(poLine.received_quantity))
            : 0;
          if (poLine && acceptedQuantity > outstanding
            && line.discrepancyType !== "EXCESS_DELIVERY" && !input.nonPoException) {
            throw new Error(`Receipt quantity for one item exceeds the Purchase Order outstanding quantity of ${outstanding}. Mark it as Excess delivery to continue.`);
          }
        }
        return { ...line, acceptedQuantity, rejectedQuantity, stockItemId, poLine };
      });

      const localGrnGuid = `LOCAL-GRN-${randomUUID()}`;
      const grnNumber = `GRN-${eventDate.replaceAll("-", "")}-${localGrnGuid.slice(-8).toUpperCase()}`;
      const timestamp = nowIso();
      const grnInsert = this.db.prepare(`
        INSERT INTO grns(client_transaction_id, tally_guid, voucher_number, voucher_date, supplier_id, purchase_order_id, po_number, challan_number, challan_date, source_type, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'LOCAL_GRN', ?)
      `).run(clientTransactionId, localGrnGuid, grnNumber, eventDate, supplier.id, sqlValue(poId), poNumber, challanNumber, challanDate, timestamp);
      const grnId = Number(grnInsert.lastInsertRowid);
      const movements: StoresMovement[] = [];

      resolvedLines.forEach((line, index) => {
        const rate = nullableNumber(line.poLine?.rate);
        const grnValue = rate === null ? null : rate * line.quantity;
        const acceptedValue = rate === null ? null : rate * line.acceptedQuantity;
        const acceptedQuantity = line.acceptedQuantity;
        const lineInsert = this.db.prepare(
          "INSERT INTO grn_lines(grn_id, stock_item_id, quantity, rejected_quantity, rate, value) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(grnId, line.stockItemId, line.quantity, line.rejectedQuantity, sqlValue(rate), sqlValue(grnValue));
        const grnLineId = Number(lineInsert.lastInsertRowid);
        this.db.prepare(`
          INSERT INTO purchase_lots(stock_item_id, supplier_id, grn_line_id, source_type, source_voucher_guid, source_voucher_date, po_number, grn_number, receipt_date, challan_number, challan_date, quantity_received, quantity_remaining, rate, value, created_at)
          VALUES (?, ?, ?, 'LOCAL_GRN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(line.stockItemId, supplier.id, grnLineId, localGrnGuid, eventDate, poNumber, grnNumber, eventDate, challanNumber, challanDate, acceptedQuantity, acceptedQuantity, sqlValue(rate), sqlValue(acceptedValue), timestamp);

        const movementId = `MOV-${randomUUID()}`;
        this.db.prepare(`
          INSERT INTO inventory_movements(id, client_transaction_id, workflow, event_date, box_id, stock_item_id, quantity, supplier_id, purchase_order_id, grn_id, status, created_at)
          VALUES (?, ?, 'VENDOR_MATERIAL_IN', ?, '', ?, ?, ?, ?, ?, 'PENDING', ?)
        `).run(movementId, `${clientTransactionId}:${index + 1}`, eventDate, line.stockItemId, line.quantity, supplier.id, sqlValue(poId), grnId, timestamp);
        this.db.prepare(
          "INSERT INTO movement_lines(movement_id, stock_item_id, quantity, direction) VALUES (?, ?, ?, 'IN')",
        ).run(movementId, line.stockItemId, line.quantity);
        movements.push(this.getMovement(movementId)!);

        if (poId && line.poLine) {
          this.db.prepare(`
            UPDATE purchase_order_lines
            SET received_quantity = received_quantity + ?
            WHERE purchase_order_id = ? AND stock_item_id = ?
          `).run(acceptedQuantity, poId, line.stockItemId);
        }
      });

      if (poId) {
        this.db.prepare(`
          UPDATE purchase_orders
          SET status = CASE WHEN EXISTS (
            SELECT 1 FROM purchase_order_lines
            WHERE purchase_order_id = ? AND received_quantity < ordered_quantity
          ) THEN 'OPEN' ELSE 'CLOSED' END
          WHERE id = ?
        `).run(poId, poId);
      }

      const entryId = `EXP-${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO tally_export_entries(id, entity_type, entity_id, status, external_id, validation_json, created_at, updated_at)
        VALUES (?, 'GRN', ?, 'PENDING', ?, ?, ?, ?)
      `).run(
        entryId,
        String(grnId),
        `INVSCAN-GRN-${grnId}`,
        json(input.nonPoException ? ["Non-PO receipt requires Chief of Staff review."] : []),
        timestamp,
        timestamp,
      );

      return { grnNumber, movements };
    });
  }

  recordVendorReceipt(input: VendorReceiptInput): StoresMovement {
    const quantity = integerQuantity(input.quantity);
    const challanNumber = text(input.challanNumber);
    if (!challanNumber) throw new Error("Supplier challan number is required.");
    const challanDate = businessDate(input.challanDate);
    const eventDate = businessDate(input.receiptDate);

    return this.transaction(() => {
      const duplicate = this.movementByClientId(input.clientTransactionId);
      if (duplicate) return duplicate;
      const stockItemId = this.itemId(input.tallyItemGuid);
      this.ensureBoxContains(input.boxId, stockItemId);
      const supplier = this.db.prepare("SELECT id, name FROM suppliers WHERE id = ?").get(input.supplierId) as Row | undefined;
      if (!supplier) throw new Error("Select a synchronized supplier.");

      let poNumber = "";
      let poId: number | null = input.purchaseOrderId ?? null;
      if (poId) {
        const po = this.db.prepare("SELECT id, voucher_number, supplier_id FROM purchase_orders WHERE id = ?").get(poId) as Row | undefined;
        if (!po) throw new Error("The selected Purchase Order is no longer available.");
        if (Number(po.supplier_id) !== Number(supplier.id)) throw new Error("The Purchase Order belongs to a different supplier.");
        const line = this.db.prepare("SELECT id, ordered_quantity, received_quantity FROM purchase_order_lines WHERE purchase_order_id = ? AND stock_item_id = ?").get(poId, stockItemId) as Row | undefined;
        if (!line) throw new Error("The selected item is not present on that Purchase Order.");
        const outstanding = Number(line.ordered_quantity) - Number(line.received_quantity);
        if (quantity > outstanding) throw new Error(`Receipt quantity exceeds the Purchase Order outstanding quantity of ${outstanding}.`);
        poNumber = text(po.voucher_number);
      } else if (!input.nonPoException) {
        throw new Error("Choose a Purchase Order, or explicitly mark this as a non-PO exception for review.");
      }

      const movementId = `MOV-${randomUUID()}`;
      const localGrnGuid = `LOCAL-GRN-${randomUUID()}`;
      const grnNumber = `GRN-${eventDate.replaceAll("-", "")}-${movementId.slice(-8).toUpperCase()}`;
      const timestamp = nowIso();
      const grnInsert = this.db.prepare(`
        INSERT INTO grns(tally_guid, voucher_number, voucher_date, supplier_id, purchase_order_id, po_number, challan_number, challan_date, source_type, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'LOCAL_GRN', ?)
      `).run(localGrnGuid, grnNumber, eventDate, supplier.id, sqlValue(poId), poNumber, challanNumber, challanDate, timestamp);
      const grnId = Number(grnInsert.lastInsertRowid);
      const poLine = poId
        ? (this.db.prepare("SELECT rate, value FROM purchase_order_lines WHERE purchase_order_id = ? AND stock_item_id = ?").get(poId, stockItemId) as Row | undefined)
        : undefined;
      const rate = nullableNumber(poLine?.rate);
      const value = rate === null ? null : rate * quantity;
      const lineInsert = this.db.prepare("INSERT INTO grn_lines(grn_id, stock_item_id, quantity, rate, value) VALUES (?, ?, ?, ?, ?)").run(grnId, stockItemId, quantity, sqlValue(rate), sqlValue(value));
      const grnLineId = Number(lineInsert.lastInsertRowid);
      this.db.prepare(`
        INSERT INTO purchase_lots(stock_item_id, supplier_id, grn_line_id, source_type, source_voucher_guid, source_voucher_date, po_number, grn_number, receipt_date, challan_number, challan_date, quantity_received, quantity_remaining, rate, value, created_at)
        VALUES (?, ?, ?, 'LOCAL_GRN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(stockItemId, supplier.id, grnLineId, localGrnGuid, eventDate, poNumber, grnNumber, eventDate, challanNumber, challanDate, quantity, quantity, sqlValue(rate), sqlValue(value), timestamp);
      this.db.prepare(`
        INSERT INTO inventory_movements(id, client_transaction_id, workflow, event_date, box_id, stock_item_id, quantity, supplier_id, purchase_order_id, grn_id, status, created_at)
        VALUES (?, ?, 'VENDOR_MATERIAL_IN', ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
      `).run(movementId, input.clientTransactionId, eventDate, text(input.boxId), stockItemId, quantity, supplier.id, sqlValue(poId), grnId, timestamp);
      this.db.prepare("INSERT INTO movement_lines(movement_id, stock_item_id, quantity, direction) VALUES (?, ?, ?, 'IN')").run(movementId, stockItemId, quantity);
      if (poId) {
        this.db.prepare("UPDATE purchase_order_lines SET received_quantity = received_quantity + ? WHERE purchase_order_id = ? AND stock_item_id = ?").run(quantity, poId, stockItemId);
        this.db.prepare(`UPDATE purchase_orders SET status = CASE WHEN EXISTS (SELECT 1 FROM purchase_order_lines WHERE purchase_order_id = ? AND received_quantity < ordered_quantity) THEN 'OPEN' ELSE 'CLOSED' END WHERE id = ?`).run(poId, poId);
      }
      const entryId = `EXP-${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO tally_export_entries(id, entity_type, entity_id, status, external_id, validation_json, created_at, updated_at)
        VALUES (?, 'GRN', ?, 'PENDING', ?, ?, ?, ?)
      `).run(entryId, String(grnId), `INVSCAN-GRN-${grnId}`, json(input.nonPoException ? ["Non-PO receipt requires Chief of Staff review."] : []), timestamp, timestamp);
      return this.getMovement(movementId)!;
    });
  }

  recordMaterialInCorrection(input: AdjustmentInput): StoresMovement {
    const quantity = integerQuantity(input.quantity);
    const eventDate = businessDate(input.eventDate);
    return this.transaction(() => {
      const duplicate = this.movementByClientId(input.clientTransactionId);
      if (duplicate) return duplicate;
      const stockItemId = this.itemId(input.tallyItemGuid);
      this.ensureBoxContains(input.boxId, stockItemId);
      const timestamp = nowIso();
      const supplierId = this.upsertSupplier(
        "Inventory Material In",
        "LOCAL-INVENTORY-MATERIAL-IN",
        timestamp,
      );
      const movementId = `MOV-${randomUUID()}`;
      const localGrnGuid = `LOCAL-GRN-${randomUUID()}`;
      const grnNumber = `MIN-${eventDate.replaceAll("-", "")}-${movementId.slice(-8).toUpperCase()}`;
      const grnInsert = this.db.prepare(`
        INSERT INTO grns(
          client_transaction_id, tally_guid, voucher_number, voucher_date,
          supplier_id, po_number, challan_number, challan_date, source_type, synced_at
        ) VALUES (?, ?, ?, ?, ?, '', ?, ?, 'LOCAL_GRN', ?)
      `).run(input.clientTransactionId, localGrnGuid, grnNumber, eventDate, supplierId, text(input.note), eventDate, timestamp);
      const grnId = Number(grnInsert.lastInsertRowid);
      const lineInsert = this.db.prepare(`
        INSERT INTO grn_lines(grn_id, stock_item_id, quantity, rejected_quantity, rate, value)
        VALUES (?, ?, ?, 0, NULL, NULL)
      `).run(grnId, stockItemId, quantity);
      const grnLineId = Number(lineInsert.lastInsertRowid);
      this.db.prepare(`
        INSERT INTO purchase_lots(
          stock_item_id, supplier_id, grn_line_id, source_type, source_voucher_guid,
          source_voucher_date, grn_number, receipt_date, challan_number, challan_date,
          quantity_received, quantity_remaining, created_at
        ) VALUES (?, ?, ?, 'LOCAL_GRN', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(stockItemId, supplierId, grnLineId, localGrnGuid, eventDate, grnNumber, eventDate, text(input.note), eventDate, quantity, quantity, timestamp);
      this.db.prepare(`
        INSERT INTO inventory_movements(
          id, client_transaction_id, workflow, event_date, box_id,
          stock_item_id, quantity, supplier_id, grn_id, status, created_at
        ) VALUES (?, ?, 'VENDOR_MATERIAL_IN', ?, ?, ?, ?, ?, ?, 'PENDING', ?)
      `).run(movementId, input.clientTransactionId, eventDate, text(input.boxId), stockItemId, quantity, supplierId, grnId, timestamp);
      this.db.prepare(`
        INSERT INTO movement_lines(movement_id, stock_item_id, quantity, direction)
        VALUES (?, ?, ?, 'IN')
      `).run(movementId, stockItemId, quantity);
      this.db.prepare(`
        INSERT INTO tally_export_entries(
          id, entity_type, entity_id, status, external_id, validation_json, created_at, updated_at
        ) VALUES (?, 'GRN', ?, 'PENDING', ?, '[]', ?, ?)
      `).run(`EXP-${randomUUID()}`, String(grnId), `INVSCAN-MATERIAL-IN-${grnId}`, timestamp, timestamp);
      return this.getMovement(movementId)!;
    });
  }

  recordMaterialOut(input: MaterialOutInput): StoresMovement {
    const quantity = integerQuantity(input.quantity);
    const eventDate = businessDate(input.eventDate);
    return this.transaction(() => {
      const duplicate = this.movementByClientId(input.clientTransactionId);
      if (duplicate) return duplicate;
      const stockItemId = this.itemId(input.tallyItemGuid);
      const purpose = input.purpose ?? "PRODUCTION";
      if (!["PRODUCTION", "SERVICING", "CUSTOMER_EXTRAS"].includes(purpose)) {
        throw new Error("Choose Production, Servicing, or Customer Extras for Material Out.");
      }
      const destination = purpose === "PRODUCTION"
        ? this.issueDestination(input.destinationTallyItemGuid, "Production")
        : this.issueDestination(undefined, purpose === "SERVICING" ? "Servicing" : "Customer Extras");
      const destinationItemId = destination.id;
      this.ensureBoxContains(input.boxId, stockItemId);

      const available = Number((this.db.prepare("SELECT COALESCE(SUM(quantity_remaining), 0) AS quantity FROM purchase_lots WHERE stock_item_id = ?").get(stockItemId) as Row).quantity);
      const reserved = this.reservedQuantity(stockItemId);
      const ownReservation = text(input.productOrderId) ? this.reservedQuantity(stockItemId, text(input.productOrderId)) : 0;
      const allowed = available - reserved + ownReservation;
      if (available < quantity) throw new Error(`Insufficient local stock. ${available} available; ${quantity} requested.`);
      if (allowed < quantity) {
        const protectedQuantity = reserved - ownReservation;
        throw new Error(`Only ${Math.max(0, allowed)} units are free to issue. ${protectedQuantity} unit${protectedQuantity === 1 ? " is" : "s are"} protected for other production orders.`);
      }

      const movementId = `MOV-${randomUUID()}`;
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO inventory_movements(id, client_transaction_id, workflow, event_date, box_id, stock_item_id, quantity, destination_item_id, status, created_at)
        VALUES (?, ?, 'MATERIAL_OUT', ?, ?, ?, ?, ?, 'PENDING', ?)
      `).run(movementId, input.clientTransactionId, eventDate, text(input.boxId), stockItemId, quantity, destinationItemId, timestamp);
      this.db.prepare("INSERT INTO movement_lines(movement_id, stock_item_id, quantity, direction) VALUES (?, ?, ?, 'OUT')").run(movementId, stockItemId, quantity);

      let remaining = quantity;
      const lots = this.db.prepare(`
        SELECT id, quantity_remaining FROM purchase_lots
        WHERE stock_item_id = ? AND quantity_remaining > 0
        ORDER BY receipt_date ASC, source_voucher_date ASC, id ASC
      `).all(stockItemId) as Row[];
      for (const lot of lots) {
        if (remaining <= 0) break;
        const allocated = Math.min(remaining, Number(lot.quantity_remaining));
        this.db.prepare("UPDATE purchase_lots SET quantity_remaining = quantity_remaining - ? WHERE id = ?").run(allocated, lot.id);
        this.db.prepare("INSERT INTO fifo_allocations(movement_id, purchase_lot_id, quantity, direction, created_at) VALUES (?, ?, ?, 'OUT', ?)").run(movementId, lot.id, allocated, timestamp);
        remaining -= allocated;
      }
      if (remaining !== 0) throw new Error("FIFO allocation failed despite the availability check.");

      const existingGroup = this.db.prepare("SELECT id FROM material_out_vouchers WHERE business_date = ? AND issued_item_id = ? AND destination_item_id = ?").get(eventDate, stockItemId, destinationItemId) as Row | undefined;
      const groupId = existingGroup ? text(existingGroup.id) : `MOUT-${randomUUID()}`;
      const externalId = `INVSCAN-MOUT-${eventDate}-${stockItemId}-${destinationItemId}`;
      this.db.prepare(`
        INSERT INTO material_out_vouchers(id, business_date, issued_item_id, destination_item_id, quantity, status, external_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
        ON CONFLICT(business_date, issued_item_id, destination_item_id) DO UPDATE SET
          quantity = material_out_vouchers.quantity + excluded.quantity,
          status = 'PENDING',
          updated_at = excluded.updated_at
      `).run(groupId, eventDate, stockItemId, destinationItemId, quantity, externalId, timestamp, timestamp);
      this.db.prepare("INSERT INTO material_out_movement_links(material_out_voucher_id, movement_id, net_quantity) VALUES (?, ?, ?)").run(groupId, movementId, quantity);
      this.db.prepare(`
        INSERT INTO tally_export_entries(id, entity_type, entity_id, status, external_id, validation_json, created_at, updated_at)
        VALUES (?, 'MATERIAL_OUT', ?, 'PENDING', ?, ?, ?, ?)
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET status = 'PENDING', batch_id = NULL, reviewed_by = '', reviewed_at = NULL, updated_at = excluded.updated_at
      `).run(`EXP-${randomUUID()}`, groupId, externalId, json([]), timestamp, timestamp);
      return this.getMovement(movementId)!;
    });
  }

  private issueDestination(tallyItemGuid: string | undefined, label: string): { id: number; tallyGuid: string } {
    if (tallyItemGuid) return { id: this.itemId(tallyItemGuid), tallyGuid: tallyItemGuid };
    if (label === "Production") throw new Error("Destination Product is required for Production Material Out.");
    const guid = `SYSTEM:MATERIAL_OUT:${label.toLocaleUpperCase().replaceAll(" ", "_")}`;
    const existing = this.db.prepare("SELECT id FROM tally_stock_items WHERE tally_guid = ?").get(guid) as Row | undefined;
    if (existing) return { id: Number(existing.id), tallyGuid: guid };
    const inserted = this.db.prepare(`
      INSERT INTO tally_stock_items(
        tally_guid, name, parent_name, has_bom, tally_closing_quantity,
        active, synced_at, source, catalog_ignored
      ) VALUES (?, ?, 'System destinations', 0, 0, 1, ?, 'LOCAL', 1)
    `).run(guid, label, nowIso());
    return { id: Number(inserted.lastInsertRowid), tallyGuid: guid };
  }

  private reservedQuantity(stockItemId: number, productOrderId?: string): number {
    if (productOrderId) {
      return Number((this.db.prepare(`
        SELECT COALESCE(SUM(reserved_quantity), 0) AS quantity
        FROM planning_reservations
        WHERE component_item_id = ? AND product_order_id = ? AND status = 'ACTIVE'
      `).get(stockItemId, productOrderId) as Row).quantity);
    }
    return Number((this.db.prepare(`
      SELECT COALESCE(SUM(reserved_quantity), 0) AS quantity
      FROM planning_reservations
      WHERE component_item_id = ? AND status = 'ACTIVE'
    `).get(stockItemId) as Row).quantity);
  }

  setOpeningQuantity(input: OpeningQuantityInput): StoresOpeningQuantityAdjustment {
    const clientTransactionId = text(input.clientTransactionId);
    if (!clientTransactionId) throw new Error("A stable opening-quantity transaction ID is required.");
    const targetQuantity = Number(input.targetQuantity);
    if (!Number.isInteger(targetQuantity) || targetQuantity < 0) {
      throw new Error("Opening quantity must be a whole number of zero or more.");
    }
    const reason = text(input.reason);
    if (!reason) throw new Error("Explain why the opening quantity is being adjusted.");
    const adjustedBy = text(input.adjustedBy);

    return this.runIdempotent(
      clientTransactionId,
      "OPENING_QUANTITY",
      { ...input, clientTransactionId, targetQuantity, reason, adjustedBy },
      () => {
        const stockItemId = this.itemId(input.tallyItemGuid);
        const totals = this.db.prepare(`
          SELECT
            COALESCE(SUM(quantity_remaining), 0) AS current_total,
            COALESCE(SUM(CASE WHEN source_type <> 'LEGACY_OPENING' THEN quantity_remaining ELSE 0 END), 0) AS non_legacy_total,
            COALESCE(SUM(CASE WHEN source_type = 'LEGACY_OPENING' THEN quantity_remaining ELSE 0 END), 0) AS legacy_total
          FROM purchase_lots WHERE stock_item_id = ?
        `).get(stockItemId) as Row;
        const previous = Number(totals.current_total);
        const nonLegacy = Number(totals.non_legacy_total);
        const currentLegacy = Number(totals.legacy_total);
        if (targetQuantity < nonLegacy) {
          throw new Error(
            `This item has ${nonLegacy} units linked to GRNs or local receipts. Opening quantity cannot be reduced below that value; correct the source receipt instead.`,
          );
        }

        const desiredLegacy = targetQuantity - nonLegacy;
        const legacyDelta = desiredLegacy - currentLegacy;
        const timestamp = nowIso();
        if (legacyDelta > 0) {
          const supplierId = this.upsertSupplier(
            LEGACY_SUPPLIER_NAME,
            LEGACY_SUPPLIER_GUID,
            timestamp,
          );
          this.db.prepare(`
            INSERT INTO purchase_lots(
              stock_item_id, supplier_id, source_type, source_voucher_guid, source_voucher_date,
              grn_number, receipt_date, quantity_received, quantity_remaining, legacy_warning, created_at
            ) VALUES (?, ?, 'LEGACY_OPENING', ?, ?, ?, ?, ?, ?, 1, ?)
          `).run(
            stockItemId,
            supplierId,
            `MANUAL-OPENING-${clientTransactionId}`,
            businessDate(),
            `Opening adjustment ${timestamp.slice(0, 10)}`,
            businessDate(),
            legacyDelta,
            legacyDelta,
            timestamp,
          );
        } else if (legacyDelta < 0) {
          let remaining = Math.abs(legacyDelta);
          const lots = this.db.prepare(`
            SELECT id, quantity_remaining FROM purchase_lots
            WHERE stock_item_id = ? AND source_type = 'LEGACY_OPENING' AND quantity_remaining > 0
            ORDER BY receipt_date DESC, id DESC
          `).all(stockItemId) as Row[];
          for (const lot of lots) {
            if (remaining <= 0) break;
            const reduction = Math.min(remaining, Number(lot.quantity_remaining));
            this.db.prepare(
              "UPDATE purchase_lots SET quantity_remaining = quantity_remaining - ? WHERE id = ?",
            ).run(reduction, lot.id);
            remaining -= reduction;
          }
          if (remaining !== 0) throw new Error("Opening-stock reduction could not be completed safely.");
        }

        const item = this.db.prepare(
          "SELECT tally_guid, name FROM tally_stock_items WHERE id = ?",
        ).get(stockItemId) as Row;
        const adjustment: StoresOpeningQuantityAdjustment = {
          id: `OPEN-${randomUUID()}`,
          tallyItemGuid: text(item.tally_guid),
          itemName: text(item.name),
          previousAvailableQuantity: previous,
          targetAvailableQuantity: targetQuantity,
          deltaQuantity: targetQuantity - previous,
          reason,
          adjustedBy,
          createdAt: timestamp,
        };
        this.db.prepare(`
          INSERT INTO opening_quantity_adjustments(
            id, client_transaction_id, stock_item_id, previous_available_quantity,
            target_available_quantity, delta_quantity, reason, adjusted_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          adjustment.id,
          clientTransactionId,
          stockItemId,
          previous,
          targetQuantity,
          adjustment.deltaQuantity,
          reason,
          adjustedBy,
          timestamp,
        );
        return adjustment;
      },
    );
  }

  getAdjustmentContext(
    tallyItemGuid: string,
    destinationTallyItemGuid: string,
    eventDateValue?: string,
  ): AdjustmentContext | null {
    const eventDate = businessDate(eventDateValue);
    const stockItemId = this.itemId(tallyItemGuid);
    const destinationItemId = this.itemId(destinationTallyItemGuid);
    return this.adjustmentContextByIds(stockItemId, destinationItemId, eventDate);
  }

  private adjustmentContextByIds(
    stockItemId: number,
    destinationItemId: number,
    eventDate: string,
  ): AdjustmentContext | null {
    const group = this.db.prepare(`
      SELECT mov.*,
        COALESCE(NULLIF(issued.local_name_override, ''), issued.name) AS issued_name,
        COALESCE(NULLIF(destination.local_name_override, ''), destination.name) AS destination_name
      FROM material_out_vouchers mov
      JOIN tally_stock_items issued ON issued.id = mov.issued_item_id
      JOIN tally_stock_items destination ON destination.id = mov.destination_item_id
      WHERE mov.business_date = ? AND mov.issued_item_id = ? AND mov.destination_item_id = ?
    `).get(eventDate, stockItemId, destinationItemId) as Row | undefined;
    if (!group) return null;

    const latest = this.db.prepare(`
      SELECT m.id, m.quantity, m.created_at
      FROM material_out_movement_links ml
      JOIN inventory_movements m ON m.id = ml.movement_id
      WHERE ml.material_out_voucher_id = ? AND ml.net_quantity > 0
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    `).get(group.id) as Row | undefined;
    if (!latest) return null;

    return {
      materialOutVoucherId: text(group.id),
      eventDate,
      issuedItemName: text(group.issued_name),
      destinationName: text(group.destination_name),
      pendingQuantity: Number(group.quantity),
      latestMovementId: text(latest.id),
      latestMovementQuantity: Number(latest.quantity),
      latestMovementCreatedAt: text(latest.created_at),
      status: text(group.status) as AdjustmentContext["status"],
      tallyVoucherNumber: text(group.tally_voucher_number),
    };
  }

  recordAdjustment(input: AdjustmentInput): StoresMovement {
    const quantity = integerQuantity(input.quantity);
    const eventDate = businessDate(input.eventDate);
    const direction = adjustmentDirection(input.direction);
    const reason = adjustmentReason(input.reason);
    const note = text(input.note);
    if (reason === "OTHER" && !note) {
      throw new Error("Describe the adjustment when the reason is Other.");
    }

    return this.transaction(() => {
      const duplicate = this.movementByClientId(input.clientTransactionId);
      if (duplicate) return duplicate;

      const stockItemId = this.itemId(input.tallyItemGuid);
      const destinationTallyItemGuid = text(input.destinationTallyItemGuid);
      if (!destinationTallyItemGuid) throw new Error("Destination Product is required for adjustments to an existing Material Out.");
      const destinationItemId = this.itemId(destinationTallyItemGuid);
      this.ensureBoxContains(input.boxId, stockItemId);
      const context = this.adjustmentContextByIds(stockItemId, destinationItemId, eventDate);
      if (!context) {
        throw new Error("No matching same-day Material Out exists for this item and destination.");
      }

      if (["EXPORTED", "CONFIRMED"].includes(context.status)) {
        const movementId = this.insertAdjustmentException(
          input,
          stockItemId,
          destinationItemId,
          quantity,
          eventDate,
          context,
          direction,
          reason,
          note,
        );
        return this.getMovement(movementId)!;
      }

      if (direction === "RETURN_TO_STOCK" && quantity > context.pendingQuantity) {
        throw new Error(
          `The return-to-stock adjustment cannot exceed the current same-day issued quantity of ${context.pendingQuantity}.`,
        );
      }

      if (direction === "ADDITIONAL_OUT") {
        const available = Number((this.db.prepare(
          "SELECT COALESCE(SUM(quantity_remaining), 0) AS quantity FROM purchase_lots WHERE stock_item_id = ?",
        ).get(stockItemId) as Row).quantity);
        if (available < quantity) {
          throw new Error(`Insufficient local stock. ${available} available; ${quantity} requested.`);
        }
      }

      const movementId = `MOV-${randomUUID()}`;
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO inventory_movements(
          id, client_transaction_id, workflow, event_date, box_id,
          stock_item_id, quantity, destination_item_id, status, created_at
        ) VALUES (?, ?, 'RETURN_UNUSED', ?, ?, ?, ?, ?, 'PENDING', ?)
      `).run(
        movementId,
        input.clientTransactionId,
        eventDate,
        text(input.boxId),
        stockItemId,
        quantity,
        destinationItemId,
        timestamp,
      );
      this.db.prepare(`
        INSERT INTO inventory_adjustments(
          movement_id, material_out_voucher_id, reference_movement_id,
          direction, reason, note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        movementId,
        context.materialOutVoucherId,
        context.latestMovementId,
        direction,
        reason,
        note,
        timestamp,
      );
      this.db.prepare(`
        INSERT INTO movement_lines(movement_id, stock_item_id, quantity, direction)
        VALUES (?, ?, ?, ?)
      `).run(
        movementId,
        stockItemId,
        quantity,
        direction === "RETURN_TO_STOCK" ? "IN" : "OUT",
      );

      if (direction === "RETURN_TO_STOCK") {
        let remaining = quantity;
        const allocations = this.db.prepare(`
          SELECT fa.id, fa.purchase_lot_id, fa.quantity,
            COALESCE((
              SELECT SUM(r.quantity) FROM fifo_allocations r
              WHERE r.source_allocation_id = fa.id AND r.direction = 'RESTORE'
            ), 0) AS restored
          FROM fifo_allocations fa
          JOIN material_out_movement_links ml ON ml.movement_id = fa.movement_id
          JOIN inventory_movements source_movement ON source_movement.id = fa.movement_id
          WHERE ml.material_out_voucher_id = ? AND fa.direction = 'OUT'
          ORDER BY source_movement.created_at DESC, fa.id DESC
        `).all(context.materialOutVoucherId) as Row[];
        for (const allocation of allocations) {
          if (remaining <= 0) break;
          const reversible = Number(allocation.quantity) - Number(allocation.restored);
          if (reversible <= 0) continue;
          const restored = Math.min(remaining, reversible);
          this.db.prepare(
            "UPDATE purchase_lots SET quantity_remaining = quantity_remaining + ? WHERE id = ?",
          ).run(restored, allocation.purchase_lot_id);
          this.db.prepare(`
            INSERT INTO fifo_allocations(
              movement_id, purchase_lot_id, quantity, direction,
              source_allocation_id, created_at
            ) VALUES (?, ?, ?, 'RESTORE', ?, ?)
          `).run(movementId, allocation.purchase_lot_id, restored, allocation.id, timestamp);
          remaining -= restored;
        }
        if (remaining !== 0) {
          throw new Error("The original FIFO allocations could not be fully reversed.");
        }
      } else {
        let remaining = quantity;
        const lots = this.db.prepare(`
          SELECT id, quantity_remaining FROM purchase_lots
          WHERE stock_item_id = ? AND quantity_remaining > 0
          ORDER BY receipt_date ASC, source_voucher_date ASC, id ASC
        `).all(stockItemId) as Row[];
        for (const lot of lots) {
          if (remaining <= 0) break;
          const allocated = Math.min(remaining, Number(lot.quantity_remaining));
          this.db.prepare(
            "UPDATE purchase_lots SET quantity_remaining = quantity_remaining - ? WHERE id = ?",
          ).run(allocated, lot.id);
          this.db.prepare(`
            INSERT INTO fifo_allocations(
              movement_id, purchase_lot_id, quantity, direction, created_at
            ) VALUES (?, ?, ?, 'OUT', ?)
          `).run(movementId, lot.id, allocated, timestamp);
          remaining -= allocated;
        }
        if (remaining !== 0) {
          throw new Error("FIFO allocation failed despite the availability check.");
        }
      }

      const netQuantity = direction === "RETURN_TO_STOCK" ? -quantity : quantity;
      this.db.prepare(`
        UPDATE material_out_vouchers
        SET quantity = quantity + ?, status = 'PENDING', updated_at = ?
        WHERE id = ?
      `).run(netQuantity, timestamp, context.materialOutVoucherId);
      this.db.prepare(`
        INSERT INTO material_out_movement_links(
          material_out_voucher_id, movement_id, net_quantity
        ) VALUES (?, ?, ?)
      `).run(context.materialOutVoucherId, movementId, netQuantity);
      this.db.prepare(`
        UPDATE tally_export_entries
        SET status = 'PENDING', batch_id = NULL, reviewed_by = '',
          reviewed_at = NULL, updated_at = ?
        WHERE entity_type = 'MATERIAL_OUT' AND entity_id = ?
      `).run(timestamp, context.materialOutVoucherId);
      return this.getMovement(movementId)!;
    });
  }

  private insertAdjustmentException(
    input: AdjustmentInput,
    stockItemId: number,
    destinationItemId: number,
    quantity: number,
    eventDate: string,
    context: AdjustmentContext,
    direction: AdjustmentInput["direction"],
    reason: AdjustmentInput["reason"],
    note: string,
  ): string {
    const movementId = `MOV-${randomUUID()}`;
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO inventory_movements(
        id, client_transaction_id, workflow, event_date, box_id,
        stock_item_id, quantity, destination_item_id, status, created_at
      ) VALUES (?, ?, 'RETURN_UNUSED', ?, ?, ?, ?, ?, 'EXCEPTION', ?)
    `).run(
      movementId,
      input.clientTransactionId,
      eventDate,
      text(input.boxId),
      stockItemId,
      quantity,
      destinationItemId,
      timestamp,
    );
    this.db.prepare(`
      INSERT INTO inventory_adjustments(
        movement_id, material_out_voucher_id, reference_movement_id,
        direction, reason, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      movementId,
      context.materialOutVoucherId,
      context.latestMovementId,
      direction,
      reason,
      note,
      timestamp,
    );
    this.db.prepare(`
      INSERT INTO movement_lines(movement_id, stock_item_id, quantity, direction)
      VALUES (?, ?, ?, ?)
    `).run(
      movementId,
      stockItemId,
      quantity,
      direction === "RETURN_TO_STOCK" ? "IN" : "OUT",
    );
    this.db.prepare(`
      INSERT INTO tally_export_entries(
        id, entity_type, entity_id, status, external_id,
        validation_json, created_at, updated_at
      ) VALUES (?, 'RETURN_EXCEPTION', ?, 'EXCEPTION', ?, ?, ?, ?)
    `).run(
      `EXP-${randomUUID()}`,
      movementId,
      `INVSCAN-ADJUSTMENT-${movementId}`,
      json([
        `The matching Material Out was already ${context.status.toLocaleLowerCase()}${
          context.tallyVoucherNumber ? ` as ${context.tallyVoucherNumber}` : ""
        }. Chief of Staff correction is required.`,
      ]),
      timestamp,
      timestamp,
    );
    return movementId;
  }

  review(input: ReviewDecisionInput): void {
    const reviewedBy = text(input.reviewedBy);
    if (!reviewedBy) throw new Error("Reviewer name is required.");
    this.transaction(() => {
      const entry = this.db.prepare("SELECT entity_type, entity_id, status FROM tally_export_entries WHERE id = ?").get(input.entryId) as Row | undefined;
      if (!entry) throw new Error("Review entry was not found.");
      if (["EXPORTED", "CONFIRMED"].includes(text(entry.status))) throw new Error("An exported entry cannot be changed without a correction workflow.");
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE tally_export_entries SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = ?, updated_at = ? WHERE id = ?
      `).run(input.status, reviewedBy, text(input.note), timestamp, timestamp, input.entryId);
      if (entry.entity_type === "MATERIAL_OUT") {
        this.db.prepare("UPDATE material_out_vouchers SET status = ?, updated_at = ? WHERE id = ?").run(input.status, timestamp, entry.entity_id);
      }
    });
  }

  private movementByClientId(clientId: string): StoresMovement | null {
    const row = this.db.prepare("SELECT id FROM inventory_movements WHERE client_transaction_id = ?").get(clientId) as Row | undefined;
    return row ? this.getMovement(text(row.id)) : null;
  }

  private getMovement(id: string): StoresMovement | null {
    const row = this.db.prepare(`
      SELECT m.*, item.tally_guid,
        COALESCE(NULLIF(item.local_name_override, ''), item.name) AS item_name,
        COALESCE(NULLIF(destination.local_name_override, ''), destination.name) AS destination_name,
        supplier.name AS supplier_name,
        po.voucher_number AS po_number,
        grn.challan_number
      FROM inventory_movements m
      JOIN tally_stock_items item ON item.id = m.stock_item_id
      LEFT JOIN tally_stock_items destination ON destination.id = m.destination_item_id
      LEFT JOIN suppliers supplier ON supplier.id = m.supplier_id
      LEFT JOIN purchase_orders po ON po.id = m.purchase_order_id
      LEFT JOIN grns grn ON grn.id = m.grn_id
      WHERE m.id = ?
    `).get(id) as Row | undefined;
    if (!row) return null;
    return this.mapMovement(row);
  }

  private mapMovement(row: Row): StoresMovement {
    const adjustment = this.db.prepare(`
      SELECT direction, reason, note, reference_movement_id
      FROM inventory_adjustments WHERE movement_id = ?
    `).get(row.id) as Row | undefined;
    const isLegacyReturn = text(row.workflow) === "RETURN_UNUSED" && !adjustment;
    return {
      id: text(row.id),
      workflow: adjustment || isLegacyReturn
        ? "ADJUSTMENT"
        : text(row.workflow) as StoresMovement["workflow"],
      eventDate: text(row.event_date),
      boxId: text(row.box_id),
      itemName: text(row.item_name),
      tallyItemGuid: text(row.tally_guid),
      quantity: Number(row.quantity),
      destinationName: text(row.destination_name),
      supplierName: text(row.supplier_name),
      poNumber: text(row.po_number),
      challanNumber: text(row.challan_number),
      status: text(row.status) as StoresMovement["status"],
      createdAt: text(row.created_at),
      adjustmentDirection: adjustment
        ? text(adjustment.direction) as StoresMovement["adjustmentDirection"]
        : isLegacyReturn ? "RETURN_TO_STOCK" : null,
      adjustmentReason: adjustment
        ? text(adjustment.reason) as StoresMovement["adjustmentReason"]
        : isLegacyReturn ? "UNUSED_MATERIAL" : null,
      adjustmentNote: adjustment ? text(adjustment.note) : "",
      referenceMovementId: adjustment ? text(adjustment.reference_movement_id) : "",
      operatorName: text(row.operator_name),
      operatorRole: text(row.operator_role),
      productOrderId: text(row.product_order_id),
      stockCondition: text(row.stock_condition),
      batchNumber: text(row.batch_number),
      serialNumbers: parseJson<string[]>(row.serials_json, []),
    };
  }

  databaseStatus(): StoresDatabaseStatus {
    const integrityRow = this.db.prepare("PRAGMA integrity_check").get() as Row | undefined;
    const integrity = Object.values(integrityRow ?? {}).some((value) => value === "ok") ? "ok" : "error";
    const backupFolder = this.getBackupFolder();
    const latest = existsSync(backupFolder)
      ? readdirSync(backupFolder)
          .filter((name) => name.endsWith(".sqlite"))
          .map((name) => ({ path: path.join(backupFolder, name), mtime: statSync(path.join(backupFolder, name)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)[0]?.path ?? null
      : null;
    return {
      path: this.databasePath,
      schemaVersion: SCHEMA_VERSION,
      sizeBytes: existsSync(this.databasePath) ? statSync(this.databasePath).size : 0,
      integrity,
      backupFolder,
      exportFolder: this.getExportFolder(this.defaultExportFolder),
      latestBackup: latest,
      hostId: this.getSetting<string>("application_database_host_id") || "",
      writerMode: "AUTHORITATIVE_HOST",
      backups: this.listBackups(),
    };
  }

  getState(): StoresState {
    const groupRows = this.db.prepare(`
      SELECT name, parent_name, source
      FROM tally_stock_groups WHERE active = 1 ORDER BY name COLLATE NOCASE
    `).all() as Row[];
    const groupParents = new Map(groupRows.map((row) => [text(row.name).toLocaleLowerCase(), {
      name: text(row.name),
      parentName: text(row.parent_name),
      source: text(row.source) === "LOCAL" ? "LOCAL" as const : "TALLY" as const,
    }]));
    const groupSettings = new Map((this.db.prepare(`
      SELECT group_name, ignored FROM catalog_group_settings
    `).all() as Row[]).map((row) => [text(row.group_name).toLocaleLowerCase(), {
      ignored: Number(row.ignored) === 1,
    }]));
    const masterPath = (
      directName: string,
      parents: Map<string, { name: string; parentName: string }>,
    ): string[] => {
      const direct = text(directName);
      if (!direct) return [];
      const result: string[] = [];
      let current = direct;
      const visited = new Set<string>();
      for (;;) {
        const key = current.toLocaleLowerCase();
        if (visited.has(key)) break;
        visited.add(key);
        result.unshift(parents.get(key)?.name ?? current);
        const parent = parents.get(key)?.parentName ?? "";
        if (!parent || parent.toLocaleLowerCase() === "primary") break;
        current = parent;
      }
      return result;
    };
    const splitGroup = (directName: string) => {
      const path = masterPath(directName, groupParents);
      return {
        path,
        primaryGroupName: path[0] ?? "",
        secondaryGroupName: path[1] ?? "",
      };
    };
    const stockRows = this.db.prepare(`
      SELECT tsi.*, primary_item.tally_guid AS duplicate_of_tally_guid,
        COALESCE(NULLIF(primary_item.local_name_override, ''), primary_item.name) AS duplicate_of_name,
        COALESCE((SELECT SUM(pl.quantity_remaining) FROM purchase_lots pl WHERE pl.stock_item_id = tsi.id), 0) AS local_available,
        COALESCE((SELECT SUM(balance.quantity) FROM ops_lot_balances balance JOIN ops_lots lot ON lot.id = balance.lot_id WHERE lot.stock_item_id = tsi.id AND balance.condition = 'PENDING_INSPECTION'), 0) AS local_pending,
        COALESCE((SELECT SUM(balance.quantity) FROM ops_lot_balances balance JOIN ops_lots lot ON lot.id = balance.lot_id WHERE lot.stock_item_id = tsi.id AND balance.condition = 'FAULTY'), 0) AS local_faulty,
        COALESCE((SELECT SUM(balance.quantity) FROM ops_lot_balances balance JOIN ops_lots lot ON lot.id = balance.lot_id WHERE lot.stock_item_id = tsi.id AND lot.expiry_date <> '' AND date(lot.expiry_date) < date('now')), 0) AS expired_quantity,
        COALESCE((SELECT SUM(balance.quantity) FROM ops_lot_balances balance JOIN ops_lots lot ON lot.id = balance.lot_id WHERE lot.stock_item_id = tsi.id AND lot.expiry_date <> '' AND date(lot.expiry_date) BETWEEN date('now') AND date('now', '+30 days')), 0) AS expiring_quantity,
        COALESCE((SELECT COUNT(*) FROM ops_serials serial WHERE serial.stock_item_id = tsi.id AND serial.active = 1 AND serial.condition IN ('AVAILABLE','PENDING_INSPECTION','FAULTY')), 0) AS serialized_quantity
      FROM tally_stock_items tsi
      LEFT JOIN tally_stock_items primary_item ON primary_item.id = tsi.duplicate_of_item_id
      WHERE tsi.active = 1
        OR EXISTS (SELECT 1 FROM purchase_lots pl WHERE pl.stock_item_id = tsi.id AND pl.quantity_remaining > 0)
        OR EXISTS (SELECT 1 FROM ops_lot_balances balance JOIN ops_lots lot ON lot.id = balance.lot_id WHERE lot.stock_item_id = tsi.id AND balance.quantity > 0)
      ORDER BY COALESCE(NULLIF(tsi.local_name_override, ''), tsi.name)
    `).all() as Row[];
    const planningTablesAvailable = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN ('planning_bom_versions', 'planning_product_orders')
    `).get() as Row).count) === 2;
    const productItemIds = new Set<number>(planningTablesAvailable
      ? (this.db.prepare(`
          SELECT product_item_id AS id FROM planning_bom_versions
          UNION
          SELECT product_item_id AS id FROM planning_product_orders
        `).all() as Row[]).map((row) => Number(row.id))
      : []);
    const stockItems: StoresStockItem[] = stockRows.map((row) => {
      const groups = splitGroup(text(row.parent_name));
      const pathSettings = groups.path
        .map((name) => groupSettings.get(name.toLocaleLowerCase()))
        .filter((value) => value !== undefined);
      const itemIgnored = Number(row.catalog_ignored) === 1;
      const groupIgnored = pathSettings.some((settings) => settings?.ignored);
      return {
      id: Number(row.id),
      tallyGuid: text(row.tally_guid),
      tallyName: text(row.name),
      name: text(row.local_name_override) || text(row.name),
      parentName: text(row.parent_name),
      groupPath: groups.path,
      categoryName: text(row.category_name),
      baseUnits: text(row.base_units) || "Nos",
      primaryGroupName: groups.primaryGroupName,
      secondaryGroupName: groups.secondaryGroupName,
      hasBom: Number(row.has_bom) === 1,
      tallyClosingQuantity: Number(row.tally_closing_quantity),
      localAvailableQuantity: Number(row.local_available),
      localPendingInspectionQuantity: Number(row.local_pending),
      localFaultyQuantity: Number(row.local_faulty),
      expiredQuantity: Number(row.expired_quantity),
      expiringSoonQuantity: Number(row.expiring_quantity),
      serializedQuantity: Number(row.serialized_quantity),
      active: Number(row.active) === 1,
      source: text(row.source) === "LOCAL" ? "LOCAL" : "TALLY",
      catalogStatus: ["DUPLICATE", "OBSOLETE"].includes(text(row.catalog_status))
        ? text(row.catalog_status) as StoresStockItem["catalogStatus"]
        : "ACTIVE",
      isProduct: Number(row.has_bom) === 1 || productItemIds.has(Number(row.id)),
      itemIgnored,
      groupIgnored,
      ignored: itemIgnored || groupIgnored,
      duplicateOfTallyGuid: row.duplicate_of_tally_guid == null ? null : text(row.duplicate_of_tally_guid),
      duplicateOfName: row.duplicate_of_name == null ? null : text(row.duplicate_of_name),
    }});

    const suppliers: StoresSupplier[] = (this.db.prepare("SELECT id, tally_guid, name FROM suppliers WHERE name <> ? ORDER BY name").all(LEGACY_SUPPLIER_NAME) as Row[]).map((row) => ({
      id: Number(row.id), tallyGuid: text(row.tally_guid), name: text(row.name),
    }));
    const knownGroupNames = new Set(groupRows.map((row) => text(row.name)));
    for (const item of stockItems) {
      if (item.parentName) knownGroupNames.add(item.parentName);
    }
    const catalogGroups = [...knownGroupNames].map((name) => {
      const split = splitGroup(name);
      const settings = groupSettings.get(name.toLocaleLowerCase());
      return {
        name,
        parentName: groupParents.get(name.toLocaleLowerCase())?.parentName ?? "",
        primaryName: split.primaryGroupName || name,
        type: split.path.length <= 1 ? "PRIMARY" as const : "SECONDARY" as const,
        level: Math.max(1, split.path.length),
        path: split.path,
        source: groupParents.get(name.toLocaleLowerCase())?.source ?? "TALLY",
        ignored: Boolean(settings?.ignored || split.path.some((part) => groupSettings.get(part.toLocaleLowerCase())?.ignored)),
        itemCount: stockItems.filter((item) =>
          item.groupPath.some((part) => part.toLocaleLowerCase() === name.toLocaleLowerCase())
        ).length,
      };
    }).sort((left, right) => left.path.join("\u0000").localeCompare(right.path.join("\u0000")));

    const categoryRows = this.db.prepare(`
      SELECT name, parent_name, source
      FROM tally_stock_categories WHERE active = 1 ORDER BY name COLLATE NOCASE
    `).all() as Row[];
    const categoryParents = new Map(categoryRows.map((row) => [text(row.name).toLocaleLowerCase(), {
      name: text(row.name),
      parentName: text(row.parent_name),
    }]));
    const stockCategories = categoryRows.map((row) => {
      const name = text(row.name);
      const categoryPath = masterPath(name, categoryParents);
      return {
        name,
        parentName: text(row.parent_name),
        level: Math.max(1, categoryPath.length),
        path: categoryPath,
        source: text(row.source) === "LOCAL" ? "LOCAL" as const : "TALLY" as const,
        itemCount: stockItems.filter((item) =>
          item.categoryName.toLocaleLowerCase() === name.toLocaleLowerCase()
        ).length,
      };
    }).sort((left, right) => left.path.join("\u0000").localeCompare(right.path.join("\u0000")));

    const purchaseOrders: StoresPurchaseOrder[] = (this.db.prepare(`
      SELECT po.*, supplier.name AS supplier_name FROM purchase_orders po
      LEFT JOIN suppliers supplier ON supplier.id = po.supplier_id
      WHERE po.status <> 'CLOSED'
        AND EXISTS (
          SELECT 1 FROM purchase_order_lines line
          WHERE line.purchase_order_id = po.id
            AND line.ordered_quantity > line.received_quantity
        )
      ORDER BY po.voucher_date DESC, po.voucher_number
    `).all() as Row[]).map((row) => {
      const lines = this.db.prepare(`
        SELECT pol.*, COALESCE(NULLIF(item.local_name_override, ''), item.name) AS item_name, item.tally_guid
        FROM purchase_order_lines pol JOIN tally_stock_items item ON item.id = pol.stock_item_id
        WHERE pol.purchase_order_id = ? ORDER BY item.name
      `).all(row.id) as Row[];
      return {
        id: Number(row.id),
        tallyGuid: text(row.tally_guid),
        voucherNumber: text(row.voucher_number),
        voucherDate: text(row.voucher_date),
        supplierId: row.supplier_id === null ? null : Number(row.supplier_id),
        supplierName: text(row.supplier_name),
        status: text(row.status) as StoresPurchaseOrder["status"],
        lines: lines.map((line) => ({
          id: Number(line.id),
          stockItemId: Number(line.stock_item_id),
          itemName: text(line.item_name),
          tallyItemGuid: text(line.tally_guid),
          orderedQuantity: Number(line.ordered_quantity),
          acceptedQuantity: Number(line.received_quantity),
          receivedQuantity: Number(line.received_quantity),
          outstandingQuantity: Math.max(0, Number(line.ordered_quantity) - Number(line.received_quantity)),
          rate: nullableNumber(line.rate),
          value: nullableNumber(line.value),
        })),
      };
    });

    const boxes = (this.db.prepare("SELECT box_id FROM boxes WHERE active = 1 ORDER BY updated_at DESC LIMIT 200").all() as Row[])
      .map((row) => this.getBox(text(row.box_id)))
      .filter((value): value is StoresBox => value !== null);

    const purchaseLots: StoresPurchaseLot[] = (this.db.prepare(`
      SELECT pl.*, COALESCE(NULLIF(item.local_name_override, ''), item.name) AS item_name,
        item.tally_guid, supplier.name AS supplier_name, lot.id AS ops_lot_id,
        COALESCE(lot.batch_number, '') AS batch_number,
        COALESCE(lot.manufacturing_date, '') AS manufacturing_date,
        COALESCE(lot.expiry_date, '') AS expiry_date,
        COALESCE(lot.supplier_lot_reference, '') AS supplier_lot_reference,
        COALESCE(lot.traceability_notes, '') AS traceability_notes,
        COALESCE((SELECT quantity FROM ops_lot_balances WHERE lot_id = lot.id AND condition = 'PENDING_INSPECTION'), 0) AS pending_quantity,
        COALESCE((SELECT quantity FROM ops_lot_balances WHERE lot_id = lot.id AND condition = 'FAULTY'), 0) AS faulty_quantity,
        COALESCE((SELECT json_group_array(serial_number) FROM ops_serials WHERE lot_id = lot.id AND active = 1 AND condition IN ('AVAILABLE','PENDING_INSPECTION','FAULTY')), '[]') AS serials_json
      FROM purchase_lots pl
      JOIN tally_stock_items item ON item.id = pl.stock_item_id
      LEFT JOIN suppliers supplier ON supplier.id = pl.supplier_id
      LEFT JOIN ops_lots lot ON lot.purchase_lot_id = pl.id
      WHERE pl.quantity_remaining > 0
        OR COALESCE((SELECT SUM(quantity) FROM ops_lot_balances WHERE lot_id = lot.id AND condition IN ('PENDING_INSPECTION','FAULTY')), 0) > 0
      ORDER BY item.name, pl.receipt_date, pl.id LIMIT 1000
    `).all() as Row[]).map((row) => ({
      id: Number(row.id),
      itemName: text(row.item_name),
      tallyItemGuid: text(row.tally_guid),
      supplierName: text(row.supplier_name),
      sourceType: text(row.source_type) as StoresPurchaseLot["sourceType"],
      poNumber: text(row.po_number),
      grnNumber: text(row.grn_number),
      receiptDate: text(row.receipt_date),
      challanNumber: text(row.challan_number),
      quantityReceived: Number(row.quantity_received),
      quantityRemaining: Number(row.quantity_remaining),
      pendingInspectionQuantity: Number(row.pending_quantity),
      faultyQuantity: Number(row.faulty_quantity),
      batchNumber: text(row.batch_number),
      serialNumbers: parseJson<string[]>(row.serials_json, []),
      manufacturingDate: text(row.manufacturing_date),
      expiryDate: text(row.expiry_date),
      supplierLotReference: text(row.supplier_lot_reference),
      traceabilityNotes: text(row.traceability_notes),
      rate: nullableNumber(row.rate),
      value: nullableNumber(row.value),
      legacyWarning: Number(row.legacy_warning) === 1,
    }));

    const recentMovements = (this.db.prepare(`
      SELECT m.*, item.tally_guid,
        COALESCE(NULLIF(item.local_name_override, ''), item.name) AS item_name,
        COALESCE(NULLIF(destination.local_name_override, ''), destination.name) AS destination_name,
        supplier.name AS supplier_name,
        po.voucher_number AS po_number, grn.challan_number,
        ops.operator_name, ops.operator_role, ops.product_order_id,
        COALESCE(ops.target_condition, ops.source_condition, '') AS stock_condition,
        COALESCE((SELECT GROUP_CONCAT(DISTINCT lot.batch_number) FROM ops_movement_lot_lines line JOIN ops_lots lot ON lot.id = line.lot_id WHERE line.movement_id = ops.id AND lot.batch_number <> ''), '') AS batch_number,
        COALESCE((SELECT json_group_array(serial_number) FROM ops_movement_serials WHERE movement_id = ops.id), '[]') AS serials_json
      FROM inventory_movements m
      JOIN tally_stock_items item ON item.id = m.stock_item_id
      LEFT JOIN tally_stock_items destination ON destination.id = m.destination_item_id
      LEFT JOIN suppliers supplier ON supplier.id = m.supplier_id
      LEFT JOIN purchase_orders po ON po.id = m.purchase_order_id
      LEFT JOIN grns grn ON grn.id = m.grn_id
      LEFT JOIN ops_movements ops ON ops.legacy_movement_id = m.id
      ORDER BY m.created_at DESC LIMIT 250
    `).all() as Row[]).map((row) => this.mapMovement(row));

    const reviewEntries = this.reviewEntries();
    const openingQuantityAdjustments: StoresOpeningQuantityAdjustment[] = (this.db.prepare(`
      SELECT adjustment.*, item.tally_guid,
        COALESCE(NULLIF(item.local_name_override, ''), item.name) AS item_name
      FROM opening_quantity_adjustments adjustment
      JOIN tally_stock_items item ON item.id = adjustment.stock_item_id
      ORDER BY adjustment.created_at DESC LIMIT 100
    `).all() as Row[]).map((row) => ({
      id: text(row.id),
      tallyItemGuid: text(row.tally_guid),
      itemName: text(row.item_name),
      previousAvailableQuantity: Number(row.previous_available_quantity),
      targetAvailableQuantity: Number(row.target_available_quantity),
      deltaQuantity: Number(row.delta_quantity),
      reason: text(row.reason),
      adjustedBy: text(row.adjusted_by),
      createdAt: text(row.created_at),
    }));
    const emptySync: StoresSyncSummary = {
      syncedAt: null,
      stockItemsImported: 0,
      suppliersImported: 0,
      openPurchaseOrdersImported: 0,
      historicalGrnsImported: 0,
      purchaseLotsReconstructed: 0,
      openingLegacyItems: 0,
      historicalVouchersScanned: 0,
      inventoryVouchersScanned: 0,
      receiptNotesDetected: 0,
      receiptNoteTypeNames: [],
      warnings: [],
    };
    const lastSyncRow = this.db.prepare("SELECT summary_json FROM sync_history WHERE status = 'SUCCESS' ORDER BY id DESC LIMIT 1").get() as Row | undefined;
    const parsedSync = lastSyncRow
      ? parseJson<Partial<StoresSyncSummary>>(lastSyncRow.summary_json, {})
      : {};
    const sync: StoresSyncSummary = {
      ...emptySync,
      ...parsedSync,
      receiptNoteTypeNames: parsedSync.receiptNoteTypeNames ?? [],
      warnings: parsedSync.warnings ?? [],
    };

    return {
      database: this.databaseStatus(),
      dataMode: this.getDataMode(),
      companyGuid: this.getSetting<string>("tally_company_guid") || "",
      companyName: this.getSetting<string>("tally_company_name") || "",
      sync,
      stockItems,
      suppliers,
      purchaseOrders,
      boxes,
      purchaseLots,
      recentMovements,
      reviewEntries,
      openingQuantityAdjustments,
      catalogGroups,
      stockCategories,
      exportSchemaVersion: "1.0",
      materialOutXmlConfigured: this.getSetting<boolean>("material_out_xml_configured") === true,
    };
  }

  private reviewEntries(): StoresReviewEntry[] {
    const entries = this.db.prepare("SELECT * FROM tally_export_entries ORDER BY created_at DESC LIMIT 500").all() as Row[];
    return entries.map((entry) => {
      if (entry.entity_type === "GRN") {
        const row = this.db.prepare(`
          SELECT g.*, supplier.name AS supplier_name,
            COALESCE((SELECT SUM(quantity) FROM grn_lines WHERE grn_id = g.id), 0) AS quantity,
            COALESCE((SELECT GROUP_CONCAT(COALESCE(NULLIF(item.local_name_override, ''), item.name) || ' × ' || gl.quantity, ', ') FROM grn_lines gl JOIN tally_stock_items item ON item.id = gl.stock_item_id WHERE gl.grn_id = g.id), '') AS items
          FROM grns g LEFT JOIN suppliers supplier ON supplier.id = g.supplier_id WHERE g.id = ?
        `).get(Number(entry.entity_id)) as Row;
        return {
          id: text(entry.id), entityType: "GRN", entityId: text(entry.entity_id), status: text(entry.status) as StoresReviewEntry["status"], externalId: text(entry.external_id),
          eventDate: text(row.voucher_date), title: `GRN ${text(row.voucher_number)} — ${text(row.items)}`, supplierName: text(row.supplier_name), poNumber: text(row.po_number), challanNumber: text(row.challan_number), issuedItemName: "", destinationName: "", quantity: Number(row.quantity), fifoSummary: "", validationMessages: parseJson<string[]>(entry.validation_json, []), contributingTransactions: 1, tallyVoucherNumber: text(entry.tally_voucher_number),
        };
      }
      if (entry.entity_type === "MATERIAL_OUT") {
        const row = this.db.prepare(`
          SELECT mov.*,
            COALESCE(NULLIF(issued.local_name_override, ''), issued.name) AS issued_name,
            COALESCE(NULLIF(destination.local_name_override, ''), destination.name) AS destination_name,
            (SELECT COUNT(*) FROM material_out_movement_links WHERE material_out_voucher_id = mov.id) AS transaction_count
          FROM material_out_vouchers mov
          JOIN tally_stock_items issued ON issued.id = mov.issued_item_id
          JOIN tally_stock_items destination ON destination.id = mov.destination_item_id
          WHERE mov.id = ?
        `).get(entry.entity_id) as Row;
        const fifo = this.db.prepare(`
          SELECT supplier.name AS supplier_name, SUM(CASE WHEN fa.direction = 'OUT' THEN fa.quantity ELSE -fa.quantity END) AS quantity
          FROM fifo_allocations fa
          JOIN material_out_movement_links ml ON ml.movement_id = fa.movement_id
          JOIN purchase_lots pl ON pl.id = fa.purchase_lot_id
          LEFT JOIN suppliers supplier ON supplier.id = pl.supplier_id
          WHERE ml.material_out_voucher_id = ?
          GROUP BY supplier.name HAVING quantity > 0 ORDER BY supplier.name
        `).all(entry.entity_id) as Row[];
        return {
          id: text(entry.id), entityType: "MATERIAL_OUT", entityId: text(entry.entity_id), status: text(entry.status) as StoresReviewEntry["status"], externalId: text(entry.external_id), eventDate: text(row.business_date), title: `${text(row.issued_name)} → ${text(row.destination_name)}`, supplierName: "", poNumber: "", challanNumber: "", issuedItemName: text(row.issued_name), destinationName: text(row.destination_name), quantity: Number(row.quantity), fifoSummary: fifo.map((part) => `${text(part.supplier_name)}: ${part.quantity}`).join("; "), validationMessages: parseJson<string[]>(entry.validation_json, []), contributingTransactions: Number(row.transaction_count), tallyVoucherNumber: text(entry.tally_voucher_number),
        };
      }
      const movement = this.getMovement(text(entry.entity_id));
      const effect = movement?.adjustmentDirection === "ADDITIONAL_OUT"
        ? "additional issue"
        : "return to stock";
      return {
        id: text(entry.id), entityType: "ADJUSTMENT_EXCEPTION", entityId: text(entry.entity_id), status: text(entry.status) as StoresReviewEntry["status"], externalId: text(entry.external_id), eventDate: movement?.eventDate ?? "", title: `Adjustment exception (${effect}) — ${movement?.itemName ?? "Unknown item"}`, supplierName: "", poNumber: "", challanNumber: "", issuedItemName: movement?.itemName ?? "", destinationName: movement?.destinationName ?? "", quantity: movement?.quantity ?? 0, fifoSummary: "", validationMessages: parseJson<string[]>(entry.validation_json, []), contributingTransactions: 1, tallyVoucherNumber: text(entry.tally_voucher_number),
      };
    });
  }

  confirmImport(input: ConfirmImportInput): void {
    const recordedBy = text(input.recordedBy);
    const tallyVoucherNumber = text(input.tallyVoucherNumber);
    if (!recordedBy) throw new Error("Recorder name is required.");
    if (!tallyVoucherNumber) throw new Error("Enter the Tally voucher number or import reference.");

    this.transaction(() => {
      const entry = this.db.prepare(`
        SELECT id, batch_id, entity_type, entity_id, status
        FROM tally_export_entries WHERE id = ?
      `).get(input.entryId) as Row | undefined;
      if (!entry) throw new Error("Export entry was not found.");
      if (text(entry.status) !== "EXPORTED") {
        throw new Error("Only an exported entry can be marked as imported.");
      }
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE tally_export_entries
        SET status = 'CONFIRMED', tally_voucher_number = ?, review_note = ?, updated_at = ?
        WHERE id = ?
      `).run(tallyVoucherNumber, text(input.note), timestamp, input.entryId);

      if (entry.entity_type === "MATERIAL_OUT") {
        this.db.prepare(`
          UPDATE material_out_vouchers
          SET status = 'CONFIRMED', tally_voucher_number = ?, updated_at = ?
          WHERE id = ?
        `).run(tallyVoucherNumber, timestamp, entry.entity_id);
      }

      if (entry.batch_id) {
        this.db.prepare(`
          INSERT INTO tally_import_results(batch_id, recorded_at, status, tally_voucher_number, note)
          VALUES (?, ?, 'CONFIRMED', ?, ?)
        `).run(entry.batch_id, timestamp, tallyVoucherNumber, `${recordedBy}: ${text(input.note)}`.trim());
        const remaining = Number((this.db.prepare(`
          SELECT COUNT(*) AS count FROM tally_export_entries
          WHERE batch_id = ? AND status = 'EXPORTED'
        `).get(entry.batch_id) as Row).count);
        if (remaining === 0) {
          this.db.prepare(`
            UPDATE tally_export_batches SET import_status = 'CONFIRMED' WHERE id = ?
          `).run(entry.batch_id);
        }
      }
    });
  }

  approvedEntries(): StoresReviewEntry[] {
    return this.reviewEntries().filter((entry) => entry.status === "APPROVED");
  }

  exportRows(entryIds: string[]): {
    review: StoresReviewEntry[];
    allocations: StoresFifoAllocation[];
    movements: StoresMovement[];
    legacyLots: StoresPurchaseLot[];
  } {
    const review = this.reviewEntries().filter((entry) => entryIds.includes(entry.id));
    const groupIds = review.filter((entry) => entry.entityType === "MATERIAL_OUT").map((entry) => entry.entityId);
    const grnIds = review.filter((entry) => entry.entityType === "GRN").map((entry) => Number(entry.entityId));
    const placeholders = groupIds.map(() => "?").join(",") || "NULL";
    const movementRows = groupIds.length
      ? (this.db.prepare(`
          SELECT m.*, item.tally_guid,
            COALESCE(NULLIF(item.local_name_override, ''), item.name) AS item_name,
            COALESCE(NULLIF(destination.local_name_override, ''), destination.name) AS destination_name,
            supplier.name AS supplier_name, po.voucher_number AS po_number, grn.challan_number
          FROM inventory_movements m
          JOIN material_out_movement_links ml ON ml.movement_id = m.id
          JOIN tally_stock_items item ON item.id = m.stock_item_id
          LEFT JOIN tally_stock_items destination ON destination.id = m.destination_item_id
          LEFT JOIN suppliers supplier ON supplier.id = m.supplier_id
          LEFT JOIN purchase_orders po ON po.id = m.purchase_order_id
          LEFT JOIN grns grn ON grn.id = m.grn_id
          WHERE ml.material_out_voucher_id IN (${placeholders}) ORDER BY m.created_at
        `).all(...groupIds) as Row[])
      : [];
    const grnMovementRows = grnIds.length
      ? (this.db.prepare(`
          SELECT m.*, item.tally_guid,
            COALESCE(NULLIF(item.local_name_override, ''), item.name) AS item_name,
            COALESCE(NULLIF(destination.local_name_override, ''), destination.name) AS destination_name,
            supplier.name AS supplier_name, po.voucher_number AS po_number, grn.challan_number
          FROM inventory_movements m
          JOIN tally_stock_items item ON item.id = m.stock_item_id
          LEFT JOIN tally_stock_items destination ON destination.id = m.destination_item_id
          LEFT JOIN suppliers supplier ON supplier.id = m.supplier_id
          LEFT JOIN purchase_orders po ON po.id = m.purchase_order_id
          LEFT JOIN grns grn ON grn.id = m.grn_id
          WHERE m.grn_id IN (${grnIds.map(() => "?").join(",")}) ORDER BY m.created_at
        `).all(...grnIds) as Row[])
      : [];
    const movements = [...movementRows, ...grnMovementRows].map((row) => this.mapMovement(row));
    const movementIds = movements.map((movement) => movement.id);
    const allocationRows = movementIds.length
      ? (this.db.prepare(`
          SELECT fa.*, COALESCE(NULLIF(item.local_name_override, ''), item.name) AS item_name,
            supplier.name AS supplier_name, pl.grn_number, pl.receipt_date
          FROM fifo_allocations fa
          JOIN purchase_lots pl ON pl.id = fa.purchase_lot_id
          JOIN tally_stock_items item ON item.id = pl.stock_item_id
          LEFT JOIN suppliers supplier ON supplier.id = pl.supplier_id
          WHERE fa.movement_id IN (${movementIds.map(() => "?").join(",")}) ORDER BY fa.id
        `).all(...movementIds) as Row[])
      : [];
    const allocations: StoresFifoAllocation[] = allocationRows.map((row) => ({
      id: Number(row.id), movementId: text(row.movement_id), purchaseLotId: Number(row.purchase_lot_id), itemName: text(row.item_name), supplierName: text(row.supplier_name), grnNumber: text(row.grn_number), receiptDate: text(row.receipt_date), quantity: Number(row.quantity), direction: text(row.direction) as StoresFifoAllocation["direction"],
    }));
    const legacyLots = this.getState().purchaseLots.filter((lot) => lot.legacyWarning);
    return { review, allocations, movements, legacyLots };
  }

  createBatchRecord(
    input: ExportBatchInput,
    entryIds: string[],
    requestedBatchId?: string,
    exportSchemaVersion = "1.0",
    xmlAdapterVersion = "receipt-note-v1/material-out-pending",
  ): string {
    const batchId = requestedBatchId || `BATCH-${randomUUID()}`;
    const timestamp = nowIso();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO tally_export_batches(
          id, created_at, approval_timestamp, approved_by, export_schema_version, xml_adapter_version
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        batchId, timestamp, timestamp, text(input.reviewedBy), exportSchemaVersion, xmlAdapterVersion,
      );
      const update = this.db.prepare("UPDATE tally_export_entries SET batch_id = ?, status = 'EXPORTED', updated_at = ? WHERE id = ? AND status = 'APPROVED'");
      for (const entryId of entryIds) update.run(batchId, timestamp, entryId);
      this.db.prepare(`UPDATE material_out_vouchers SET status = 'EXPORTED', updated_at = ? WHERE id IN (SELECT entity_id FROM tally_export_entries WHERE batch_id = ? AND entity_type = 'MATERIAL_OUT')`).run(timestamp, batchId);
    });
    return batchId;
  }

  finishBatch(batchId: string, files: { excelPath: string; csvPath: string | null; xmlPath: string; payloadHash: string }): void {
    this.db.prepare(`
      UPDATE tally_export_batches SET payload_hash = ?, generated_xml_filename = ?, generated_excel_filename = ?, generated_csv_filename = ? WHERE id = ?
    `).run(files.payloadHash, files.xmlPath, files.excelPath, files.csvPath ?? "", batchId);
  }
}
