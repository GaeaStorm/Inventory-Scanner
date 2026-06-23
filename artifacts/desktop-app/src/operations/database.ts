import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ApplicationDatabase, ApplicationDatabaseMigration } from "../database/application-database";
import type {
  ActorContext,
  AuthSession,
  AuthState,
  AuthUser,
  BootstrapAdminInput,
  ConditionBalance,
  ConditionTransitionInput,
  CreateCountSessionInput,
  CreateFaultInput,
  CustomerReturnInput,
  FaultResolution,
  FinalizeCountInput,
  ForgotCredentialInput,
  LoginInput,
  ManualTallyReview,
  MovementLotLine,
  MovementType,
  OnHandCondition,
  OperationsMovement,
  OperationsState,
  Permission,
  ProductionCompletionInput,
  ProductionExecution,
  ProductionReturnInput,
  ReceiveCustomerReturnInput,
  RecordCountEntryInput,
  ResetCredentialInput,
  ResolveFaultInput,
  ReverseMovementInput,
  SaveUserInput,
  ScrapInput,
  StockCondition,
  StockCountDetail,
  StockCountLine,
  StockCountSessionSummary,
  SupplierFaultRecord,
  SupplierFaultResolutionEntry,
  SupplierFaultSummary,
  SupplierReturnInput,
  SyncExceptionRecord,
  UpdateSupplierReturnInput,
  TraceabilityInput,
  UserRole,
} from "./types";
import { permissionsForRole, requirePermission } from "./permissions";

const MODULE_NAME = "operations";
const SESSION_HOURS = 12;
const EXPIRING_SOON_DAYS = 30;
const SHARED_PHONE_USER_ID = "SYSTEM:SHARED_PHONE";

type Row = Record<string, any>;

let lastTimestamp = 0;

function nowIso(): string {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  return new Date(lastTimestamp).toISOString();
}

function dateOnly(value?: string): string {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.valueOf())) throw new Error("Enter a valid date.");
  return date.toISOString().slice(0, 10);
}

function optionalDate(value?: string): string {
  if (!value) return "";
  return dateOnly(value);
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function whole(value: unknown, label: string, allowZero = false): number {
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be ${allowZero ? "zero or a positive" : "a positive"} whole number.`);
  }
  return parsed;
}

function supplierFollowUpStatus(value: unknown): "PENDING" | "EXPECTED" | "RECEIVED" | "NOT_EXPECTED" {
  const status = text(value).toLocaleUpperCase() || "PENDING";
  if (!["PENDING", "EXPECTED", "RECEIVED", "NOT_EXPECTED"].includes(status)) {
    throw new Error("Supplier-return follow-up status must be Pending, Expected, Received, or Not expected.");
  }
  return status as "PENDING" | "EXPECTED" | "RECEIVED" | "NOT_EXPECTED";
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function normalizeSerials(values: unknown): string[] {
  const serials = Array.isArray(values)
    ? values.map((entry) => text(entry)).filter(Boolean)
    : [];
  const normalized = [...new Set(serials.map((entry) => entry.toLocaleUpperCase()))];
  if (normalized.length !== serials.length) throw new Error("Serial numbers must be unique within the transaction.");
  return serials;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function payloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function credentialRules(credential: string, type: "PASSWORD" | "PIN"): void {
  if (type === "PIN") {
    if (!/^\d{4,12}$/.test(credential)) throw new Error("A PIN must contain 4 to 12 digits.");
    return;
  }
  if (credential.length < 8) throw new Error("A password must contain at least 8 characters.");
}

function emailAddress(value: unknown): string {
  const email = text(value).toLocaleLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
  return email;
}

function hashCredential(credential: string, type: "PASSWORD" | "PIN"): { salt: string; hash: string } {
  credentialRules(credential, type);
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(credential, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyCredential(credential: string, salt: string, expectedHash: string): boolean {
  try {
    const actual = scryptSync(credential, salt, 64);
    const expected = Buffer.from(expectedHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function onHand(condition: StockCondition): condition is OnHandCondition {
  return condition === "AVAILABLE" || condition === "PENDING_INSPECTION" || condition === "FAULTY";
}

function movementDelta(movement: Row, condition: string): number {
  let delta = 0;
  if (movement.source_condition === condition) delta -= Number(movement.quantity);
  if (movement.target_condition === condition) delta += Number(movement.quantity);
  return delta;
}

const migrations: ApplicationDatabaseMigration[] = [
  {
    version: 1,
    description: "Add authenticated inventory operations, stock conditions, traceability, counts, returns, faults, production, reversals, and synchronization exceptions",
    up(database: DatabaseSync) {
      database.exec(`
        CREATE TABLE ops_users (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          credential_hash TEXT NOT NULL,
          credential_salt TEXT NOT NULL,
          credential_type TEXT NOT NULL CHECK (credential_type IN ('PASSWORD','PIN')),
          role TEXT NOT NULL CHECK (role IN ('STORE','ACCOUNTS','PRODUCTION','SALES','ADMIN')),
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
          must_reset_credential INTEGER NOT NULL DEFAULT 0 CHECK (must_reset_credential IN (0,1)),
          last_login TEXT,
          audit_identity TEXT NOT NULL UNIQUE,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ops_sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES ops_users(id) ON DELETE CASCADE,
          device_label TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ops_idempotency (
          client_transaction_id TEXT PRIMARY KEY,
          operation TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          completed_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ops_audit_events (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          actor_user_id TEXT REFERENCES ops_users(id),
          actor_name TEXT NOT NULL,
          actor_role TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          detail_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ops_lots (
          id TEXT PRIMARY KEY,
          purchase_lot_id INTEGER NOT NULL UNIQUE REFERENCES purchase_lots(id) ON DELETE CASCADE,
          stock_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
          supplier_id INTEGER REFERENCES suppliers(id),
          purchase_order_id INTEGER REFERENCES purchase_orders(id),
          receipt_grn_id INTEGER REFERENCES grns(id),
          product_order_id TEXT,
          source_type TEXT NOT NULL,
          source_reference TEXT NOT NULL DEFAULT '',
          batch_number TEXT NOT NULL DEFAULT '',
          manufacturing_date TEXT NOT NULL DEFAULT '',
          expiry_date TEXT NOT NULL DEFAULT '',
          supplier_lot_reference TEXT NOT NULL DEFAULT '',
          traceability_notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ops_lot_balances (
          lot_id TEXT NOT NULL REFERENCES ops_lots(id) ON DELETE CASCADE,
          condition TEXT NOT NULL CHECK (condition IN ('AVAILABLE','PENDING_INSPECTION','FAULTY')),
          quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
          updated_at TEXT NOT NULL,
          PRIMARY KEY(lot_id, condition)
        ) STRICT;

        CREATE TABLE ops_serials (
          serial_number TEXT PRIMARY KEY COLLATE NOCASE,
          lot_id TEXT NOT NULL REFERENCES ops_lots(id) ON DELETE CASCADE,
          stock_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
          condition TEXT NOT NULL CHECK (condition IN ('AVAILABLE','PENDING_INSPECTION','FAULTY','ISSUED','SCRAPPED','RETURNED_TO_SUPPLIER')),
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ops_movements (
          id TEXT PRIMARY KEY,
          client_transaction_id TEXT NOT NULL UNIQUE,
          movement_type TEXT NOT NULL,
          event_date TEXT NOT NULL,
          event_timestamp TEXT NOT NULL,
          stock_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
          item_name_snapshot TEXT NOT NULL,
          item_group_snapshot TEXT NOT NULL DEFAULT '',
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          source_condition TEXT CHECK (source_condition IS NULL OR source_condition IN ('AVAILABLE','PENDING_INSPECTION','FAULTY','SCRAPPED','RETURNED_TO_SUPPLIER')),
          target_condition TEXT CHECK (target_condition IS NULL OR target_condition IN ('AVAILABLE','PENDING_INSPECTION','FAULTY','SCRAPPED','RETURNED_TO_SUPPLIER')),
          supplier_id INTEGER REFERENCES suppliers(id),
          supplier_name_snapshot TEXT NOT NULL DEFAULT '',
          purchase_order_id INTEGER REFERENCES purchase_orders(id),
          purchase_order_reference TEXT NOT NULL DEFAULT '',
          receipt_reference TEXT NOT NULL DEFAULT '',
          product_order_id TEXT NOT NULL DEFAULT '',
          product_name_snapshot TEXT NOT NULL DEFAULT '',
          fault_id TEXT NOT NULL DEFAULT '',
          legacy_movement_id TEXT NOT NULL DEFAULT '',
          reference_movement_id TEXT NOT NULL DEFAULT '',
          reversal_of_movement_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'APPLIED' CHECK (status IN ('APPLIED','REVERSED','EXCEPTION','MANUAL_REVIEW')),
          notes TEXT NOT NULL DEFAULT '',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          operator_user_id TEXT NOT NULL REFERENCES ops_users(id),
          operator_name TEXT NOT NULL,
          operator_role TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ops_movement_lot_lines (
          id INTEGER PRIMARY KEY,
          movement_id TEXT NOT NULL REFERENCES ops_movements(id) ON DELETE CASCADE,
          lot_id TEXT NOT NULL REFERENCES ops_lots(id),
          purchase_lot_id INTEGER NOT NULL REFERENCES purchase_lots(id),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          source_condition TEXT,
          target_condition TEXT,
          UNIQUE(movement_id, lot_id, source_condition, target_condition)
        ) STRICT;

        CREATE TABLE ops_movement_serials (
          movement_id TEXT NOT NULL REFERENCES ops_movements(id) ON DELETE CASCADE,
          serial_number TEXT NOT NULL REFERENCES ops_serials(serial_number),
          PRIMARY KEY(movement_id, serial_number)
        ) STRICT;

        CREATE TABLE ops_receipt_inspections (
          id TEXT PRIMARY KEY,
          grn_line_id INTEGER NOT NULL UNIQUE REFERENCES grn_lines(id) ON DELETE CASCADE,
          lot_id TEXT NOT NULL REFERENCES ops_lots(id),
          total_received INTEGER NOT NULL CHECK (total_received > 0),
          expected_quantity INTEGER CHECK (expected_quantity IS NULL OR expected_quantity >= 0),
          available_quantity INTEGER NOT NULL CHECK (available_quantity >= 0),
          pending_quantity INTEGER NOT NULL CHECK (pending_quantity >= 0),
          faulty_quantity INTEGER NOT NULL CHECK (faulty_quantity >= 0),
          discrepancy_type TEXT NOT NULL DEFAULT '',
          wrong_item_guid TEXT NOT NULL DEFAULT '',
          fault_reason TEXT NOT NULL DEFAULT '',
          recorded_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          CHECK (available_quantity + pending_quantity + faulty_quantity = total_received)
        ) STRICT;

        CREATE TABLE ops_supplier_faults (
          id TEXT PRIMARY KEY,
          supplier_id INTEGER REFERENCES suppliers(id),
          supplier_name_snapshot TEXT NOT NULL DEFAULT '',
          stock_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
          item_name_snapshot TEXT NOT NULL,
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          purchase_lot_id INTEGER REFERENCES purchase_lots(id),
          lot_id TEXT REFERENCES ops_lots(id),
          receipt_reference TEXT NOT NULL DEFAULT '',
          purchase_order_reference TEXT NOT NULL DEFAULT '',
          challan_reference TEXT NOT NULL DEFAULT '',
          batch_number TEXT NOT NULL DEFAULT '',
          serials_json TEXT NOT NULL DEFAULT '[]',
          date_discovered TEXT NOT NULL,
          discovered_by_user_id TEXT NOT NULL REFERENCES ops_users(id),
          discovered_by_name TEXT NOT NULL,
          discovery_point TEXT NOT NULL CHECK (discovery_point IN ('AT_RECEIPT','IN_STORES','DURING_PRODUCTION','AFTER_PRODUCTION_RETURN','AFTER_CUSTOMER_RETURN')),
          fault_reason TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PARTIALLY_RESOLVED','RESOLVED','CLOSED')),
          current_resolution TEXT NOT NULL DEFAULT 'PENDING',
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ops_supplier_fault_resolutions (
          id TEXT PRIMARY KEY,
          client_transaction_id TEXT NOT NULL UNIQUE,
          fault_id TEXT NOT NULL REFERENCES ops_supplier_faults(id) ON DELETE CASCADE,
          resolution TEXT NOT NULL,
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          reference TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          recorded_by_user_id TEXT NOT NULL REFERENCES ops_users(id),
          recorded_by_name TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ops_count_sessions (
          id TEXT PRIMARY KEY,
          client_transaction_id TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('FULL','CYCLE')),
          status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','COUNTING','FINALIZED','CANCELLED')),
          snapshot_at TEXT NOT NULL,
          started_by_user_id TEXT NOT NULL REFERENCES ops_users(id),
          started_by_name TEXT NOT NULL,
          finalized_by_user_id TEXT REFERENCES ops_users(id),
          finalized_by_name TEXT NOT NULL DEFAULT '',
          finalized_at TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ops_count_items (
          session_id TEXT NOT NULL REFERENCES ops_count_sessions(id) ON DELETE CASCADE,
          stock_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
          condition TEXT NOT NULL CHECK (condition IN ('AVAILABLE','FAULTY')),
          snapshot_expected INTEGER NOT NULL CHECK (snapshot_expected >= 0),
          PRIMARY KEY(session_id, stock_item_id, condition)
        ) STRICT;

        CREATE TABLE ops_count_entries (
          id TEXT PRIMARY KEY,
          client_transaction_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL REFERENCES ops_count_sessions(id) ON DELETE CASCADE,
          stock_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
          condition TEXT NOT NULL CHECK (condition IN ('AVAILABLE','FAULTY')),
          counted_quantity INTEGER NOT NULL CHECK (counted_quantity >= 0),
          reason TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          counted_by_user_id TEXT NOT NULL REFERENCES ops_users(id),
          counted_by_name TEXT NOT NULL,
          counted_at TEXT NOT NULL,
          UNIQUE(session_id, stock_item_id, condition, sequence)
        ) STRICT;

        CREATE TABLE ops_supplier_returns (
          id TEXT PRIMARY KEY,
          client_transaction_id TEXT NOT NULL UNIQUE,
          movement_id TEXT NOT NULL REFERENCES ops_movements(id),
          fault_id TEXT NOT NULL DEFAULT '',
          supplier_id INTEGER REFERENCES suppliers(id),
          supplier_name_snapshot TEXT NOT NULL DEFAULT '',
          supplier_return_reference TEXT NOT NULL,
          return_date TEXT NOT NULL,
          replacement_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (replacement_status IN ('PENDING','EXPECTED','RECEIVED','NOT_EXPECTED')),
          credit_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (credit_status IN ('PENDING','EXPECTED','RECEIVED','NOT_EXPECTED')),
          notes TEXT NOT NULL DEFAULT '',
          recorded_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ops_customer_returns (
          id TEXT PRIMARY KEY,
          client_transaction_id TEXT NOT NULL UNIQUE,
          external_reference TEXT NOT NULL,
          stock_item_id INTEGER NOT NULL REFERENCES tally_stock_items(id),
          item_name_snapshot TEXT NOT NULL,
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          status TEXT NOT NULL DEFAULT 'AWAITING_STORE_RECEIPT' CHECK (status IN ('AWAITING_STORE_RECEIPT','RECEIVED','CANCELLED')),
          initiated_by_user_id TEXT NOT NULL REFERENCES ops_users(id),
          initiated_by_name TEXT NOT NULL,
          received_by_user_id TEXT REFERENCES ops_users(id),
          received_by_name TEXT NOT NULL DEFAULT '',
          received_condition TEXT NOT NULL DEFAULT '',
          movement_id TEXT NOT NULL DEFAULT '',
          traceability_json TEXT NOT NULL DEFAULT '{}',
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          received_at TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ops_scrap_records (
          id TEXT PRIMARY KEY,
          client_transaction_id TEXT NOT NULL UNIQUE,
          movement_id TEXT NOT NULL REFERENCES ops_movements(id),
          product_order_id TEXT NOT NULL DEFAULT '',
          fault_id TEXT NOT NULL DEFAULT '',
          reason TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          recorded_by TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ops_production_executions (
          product_order_id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','RELEASED','IN_PROGRESS','CANCELLED','CLOSED')),
          notes TEXT NOT NULL DEFAULT '',
          released_by_user_id TEXT REFERENCES ops_users(id),
          released_by_name TEXT NOT NULL DEFAULT '',
          released_at TEXT,
          closed_by_user_id TEXT REFERENCES ops_users(id),
          closed_by_name TEXT NOT NULL DEFAULT '',
          closed_at TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ops_sync_exceptions (
          id TEXT PRIMARY KEY,
          client_transaction_id TEXT NOT NULL UNIQUE,
          device_id TEXT NOT NULL,
          operator_name TEXT NOT NULL DEFAULT '',
          local_timestamp TEXT NOT NULL,
          server_timestamp TEXT NOT NULL,
          operation_type TEXT NOT NULL,
          stock_item_id INTEGER REFERENCES tally_stock_items(id),
          item_name_snapshot TEXT NOT NULL DEFAULT '',
          requested_quantity INTEGER NOT NULL DEFAULT 0 CHECK (requested_quantity >= 0),
          product_order_id TEXT NOT NULL DEFAULT '',
          reason TEXT NOT NULL,
          available_quantity INTEGER NOT NULL DEFAULT 0 CHECK (available_quantity >= 0),
          status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','CANCELLED','REPLACED')),
          resolution_action TEXT NOT NULL DEFAULT '',
          resolution_notes TEXT NOT NULL DEFAULT '',
          resolved_by_user_id TEXT REFERENCES ops_users(id),
          resolved_by_name TEXT NOT NULL DEFAULT '',
          resolved_at TEXT,
          original_payload_json TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE ops_tally_reviews (
          id TEXT PRIMARY KEY,
          movement_id TEXT NOT NULL UNIQUE REFERENCES ops_movements(id),
          movement_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','PROCESSED','REVERSED','FAILED')),
          review_reason TEXT NOT NULL,
          tally_voucher_reference TEXT NOT NULL DEFAULT '',
          reviewed_by_user_id TEXT REFERENCES ops_users(id),
          reviewed_by_name TEXT NOT NULL DEFAULT '',
          reviewed_at TEXT,
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX idx_ops_balances_condition ON ops_lot_balances(condition, quantity);
        CREATE INDEX idx_ops_lots_item ON ops_lots(stock_item_id, expiry_date, purchase_lot_id);
        CREATE INDEX idx_ops_movements_item_date ON ops_movements(stock_item_id, event_timestamp, movement_type);
        CREATE INDEX idx_ops_movements_product_order ON ops_movements(product_order_id, event_timestamp);
        CREATE INDEX idx_ops_faults_supplier_item ON ops_supplier_faults(supplier_id, stock_item_id, status, date_discovered);
        CREATE INDEX idx_ops_counts_status ON ops_count_sessions(status, snapshot_at);
        CREATE INDEX idx_ops_sync_status ON ops_sync_exceptions(status, server_timestamp);
        CREATE INDEX idx_ops_serials_item_condition ON ops_serials(stock_item_id, condition, active);
      `);
    },
  },
  {
    version: 2,
    description: "Add condition-balance integrity triggers and audit indexes",
    up(database: DatabaseSync) {
      database.exec(`
        CREATE TRIGGER ops_balance_available_sync_insert
        AFTER INSERT ON ops_lot_balances
        WHEN NEW.condition = 'AVAILABLE'
        BEGIN
          UPDATE purchase_lots SET quantity_remaining = NEW.quantity
          WHERE id = (SELECT purchase_lot_id FROM ops_lots WHERE id = NEW.lot_id);
        END;

        CREATE TRIGGER ops_balance_available_sync_update
        AFTER UPDATE OF quantity ON ops_lot_balances
        WHEN NEW.condition = 'AVAILABLE'
        BEGIN
          UPDATE purchase_lots SET quantity_remaining = NEW.quantity
          WHERE id = (SELECT purchase_lot_id FROM ops_lots WHERE id = NEW.lot_id);
        END;

        CREATE INDEX idx_ops_audit_entity ON ops_audit_events(entity_type, entity_id, created_at);
        CREATE INDEX idx_ops_tally_status ON ops_tally_reviews(status, created_at);
      `);
    },
  },
  {
    version: 3,
    description: "Add optimistic status tracking for supplier-return replacement and credit follow-up",
    up(database: DatabaseSync) {
      database.exec(`
        ALTER TABLE ops_supplier_returns ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
        ALTER TABLE ops_supplier_returns ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
        UPDATE ops_supplier_returns SET updated_at = created_at WHERE updated_at = '';
      `);
    },
  },
  {
    version: 4,
    description: "Require a recovery email for every desktop user account",
    up(database: DatabaseSync) {
      database.exec(`
        ALTER TABLE ops_users ADD COLUMN email TEXT NOT NULL DEFAULT '';
        ALTER TABLE ops_users ADD COLUMN email_required INTEGER NOT NULL DEFAULT 1 CHECK (email_required IN (0,1));
        UPDATE ops_users SET email_required = 0 WHERE id = '${SHARED_PHONE_USER_ID}';
        CREATE UNIQUE INDEX idx_ops_users_email_unique
          ON ops_users(email COLLATE NOCASE) WHERE email <> '';
      `);
    },
  },
];

export class OperationsDatabase {
  readonly host: ApplicationDatabase;
  readonly moduleVersion: number;

  constructor(host: ApplicationDatabase, beforeMigration?: () => void) {
    this.host = host;
    this.moduleVersion = this.host.migrateModule(MODULE_NAME, migrations, beforeMigration);
    this.pruneExpiredSessions();
  }

  get db(): DatabaseSync {
    return this.host.db;
  }

  private transaction<T>(operation: string, work: () => T): T {
    return this.host.transaction(operation, work);
  }

  private runIdempotent<T>(clientTransactionId: string, operation: string, payload: unknown, work: () => T): T {
    const id = text(clientTransactionId);
    if (!id) throw new Error("A stable client transaction ID is required.");
    return this.transaction(`processing ${operation}`, () => {
      const hash = payloadHash(payload);
      const existing = this.db.prepare(
        "SELECT operation, payload_hash, response_json FROM ops_idempotency WHERE client_transaction_id = ?",
      ).get(id) as Row | undefined;
      if (existing) {
        if (text(existing.operation) !== operation || text(existing.payload_hash) !== hash) {
          throw new Error("This transaction ID was already used for different data.");
        }
        return parseJson<T>(existing.response_json, null as T);
      }
      const result = work();
      this.db.prepare(`
        INSERT INTO ops_idempotency(client_transaction_id, operation, payload_hash, response_json, completed_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, operation, hash, json(result), nowIso());
      return result;
    });
  }

  private audit(actor: ActorContext, eventType: string, entityType: string, entityId: string, detail: unknown): void {
    this.db.prepare(`
      INSERT INTO ops_audit_events(id, event_type, actor_user_id, actor_name, actor_role, entity_type, entity_id, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), eventType, actor.userId, actor.displayName, actor.role, entityType, entityId, json(detail), nowIso());
  }

  private pruneExpiredSessions(): void {
    this.db.prepare("DELETE FROM ops_sessions WHERE expires_at <= ?").run(nowIso());
  }

  private mapUser(row: Row): AuthUser {
    return {
      userId: text(row.id),
      username: text(row.username),
      displayName: text(row.display_name),
      email: text(row.email),
      needsEmail: Number(row.email_required) === 1 || !text(row.email),
      auditIdentity: text(row.audit_identity),
      role: text(row.role) as UserRole,
      active: Number(row.active) === 1,
      credentialType: text(row.credential_type) as AuthUser["credentialType"],
      mustResetCredential: Number(row.must_reset_credential) === 1,
      lastLogin: row.last_login ? text(row.last_login) : null,
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    };
  }

  listUsers(): AuthUser[] {
    return (this.db.prepare("SELECT * FROM ops_users WHERE id <> ? ORDER BY active DESC, display_name COLLATE NOCASE").all(SHARED_PHONE_USER_ID) as Row[])
      .map((row) => this.mapUser(row));
  }

  authState(actor?: ActorContext | null): AuthState {
    const currentUser = actor
      ? this.listUsers().find((user) => user.userId === actor.userId) ?? null
      : null;
    return {
      needsBootstrap: Number((this.db.prepare("SELECT COUNT(*) AS count FROM ops_users WHERE id <> ?").get(SHARED_PHONE_USER_ID) as Row).count) === 0,
      currentUser,
      permissions: currentUser ? permissionsForRole(currentUser.role) : [],
      users: currentUser?.role === "ADMIN" ? this.listUsers() : [],
    };
  }

  bootstrapAdmin(input: BootstrapAdminInput): AuthSession {
    return this.transaction("creating the first administrator", () => {
      const count = Number((this.db.prepare("SELECT COUNT(*) AS count FROM ops_users").get() as Row).count);
      if (count !== 0) throw new Error("The initial administrator has already been created.");
      const displayName = text(input.displayName);
      const username = text(input.username);
      const email = emailAddress(input.email);
      const credential = String(input.credential ?? "");
      const credentialType = input.credentialType === "PIN" ? "PIN" : "PASSWORD";
      if (!displayName || !username) throw new Error("Display name and username are required.");
      const hashed = hashCredential(credential, credentialType);
      const userId = randomUUID();
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO ops_users(
          id, display_name, username, credential_hash, credential_salt, credential_type,
          role, active, must_reset_credential, audit_identity, email, email_required, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'ADMIN', 1, 0, ?, ?, 0, ?, ?)
      `).run(userId, displayName, username, hashed.hash, hashed.salt, credentialType, `ADMIN:${username}`, email, timestamp, timestamp);
      const actor: ActorContext = { userId, username, displayName, auditIdentity: `ADMIN:${username}`, role: "ADMIN" };
      this.audit(actor, "BOOTSTRAP_ADMIN", "USER", userId, { username });
      return this.createSession(userId, text(input.username) ? "Initial desktop" : "");
    });
  }

  private createSession(userId: string, deviceLabel: string): AuthSession {
    const row = this.db.prepare("SELECT * FROM ops_users WHERE id = ? AND active = 1").get(userId) as Row | undefined;
    if (!row) throw new Error("The user account is inactive or unavailable.");
    const token = randomBytes(32).toString("base64url");
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO ops_sessions(token_hash, user_id, device_label, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(hashToken(token), userId, deviceLabel, createdAt, expiresAt, createdAt);
    this.db.prepare("UPDATE ops_users SET last_login = ?, updated_at = ? WHERE id = ?").run(createdAt, createdAt, userId);
    const user = this.mapUser({ ...row, last_login: createdAt, updated_at: createdAt });
    return { token, expiresAt, user, permissions: permissionsForRole(user.role) };
  }

  login(input: LoginInput): AuthSession {
    return this.transaction("signing in", () => {
      const username = text(input.username);
      const row = this.db.prepare("SELECT * FROM ops_users WHERE username = ? COLLATE NOCASE").get(username) as Row | undefined;
      if (!row || Number(row.active) !== 1 || !verifyCredential(String(input.credential ?? ""), text(row.credential_salt), text(row.credential_hash))) {
        throw new Error("Invalid username or credential.");
      }
      return this.createSession(text(row.id), text(input.deviceLabel));
    });
  }

  forgotCredential(input: ForgotCredentialInput): void {
    const username = text(input.username);
    const email = emailAddress(input.email);
    const credentialType = input.credentialType === "PIN" ? "PIN" : "PASSWORD";
    const hashed = hashCredential(String(input.credential ?? ""), credentialType);
    this.transaction("resetting a forgotten credential", () => {
      const row = this.db.prepare(
        "SELECT id FROM ops_users WHERE username = ? COLLATE NOCASE AND email = ? COLLATE NOCASE AND active = 1 AND id <> ?",
      ).get(username, email, SHARED_PHONE_USER_ID) as Row | undefined;
      if (!row) throw new Error("The username and email address do not match an active account.");
      this.db.prepare(`
        UPDATE ops_users SET credential_hash = ?, credential_salt = ?, credential_type = ?,
          must_reset_credential = 0, version = version + 1, updated_at = ? WHERE id = ?
      `).run(hashed.hash, hashed.salt, credentialType, nowIso(), row.id);
      this.db.prepare("DELETE FROM ops_sessions WHERE user_id = ?").run(row.id);
    });
  }

  sharedPhoneActor(): ActorContext {
    const realUserCount = Number((this.db.prepare(
      "SELECT COUNT(*) AS count FROM ops_users WHERE id <> ?",
    ).get(SHARED_PHONE_USER_ID) as Row).count);
    if (realUserCount === 0) {
      throw new Error("Finish desktop administrator setup before connecting a phone scanner.");
    }
    let row = this.db.prepare("SELECT * FROM ops_users WHERE id = ?").get(SHARED_PHONE_USER_ID) as Row | undefined;
    if (!row) {
      const timestamp = nowIso();
      const hashed = hashCredential(randomBytes(32).toString("hex"), "PASSWORD");
      this.db.prepare(`
        INSERT INTO ops_users(
          id, display_name, username, credential_hash, credential_salt, credential_type,
          role, active, must_reset_credential, audit_identity, email, email_required, created_at, updated_at
        ) VALUES (?, 'Phone scanner', '__shared_phone__', ?, ?, 'PASSWORD', 'STORE', 1, 0, 'PHONE:SHARED', '', 0, ?, ?)
      `).run(SHARED_PHONE_USER_ID, hashed.hash, hashed.salt, timestamp, timestamp);
      row = this.db.prepare("SELECT * FROM ops_users WHERE id = ?").get(SHARED_PHONE_USER_ID) as Row;
    }
    return {
      userId: text(row.id),
      username: text(row.username),
      displayName: text(row.display_name),
      auditIdentity: text(row.audit_identity),
      role: "STORE",
    };
  }

  actorForToken(token: string): ActorContext | null {
    const tokenValue = text(token);
    if (!tokenValue) return null;
    const timestamp = nowIso();
    const row = this.db.prepare(`
      SELECT user.* FROM ops_sessions session
      JOIN ops_users user ON user.id = session.user_id
      WHERE session.token_hash = ? AND session.expires_at > ? AND user.active = 1
    `).get(hashToken(tokenValue), timestamp) as Row | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE ops_sessions SET last_seen_at = ? WHERE token_hash = ?").run(timestamp, hashToken(tokenValue));
    return {
      userId: text(row.id),
      username: text(row.username),
      displayName: text(row.display_name),
      auditIdentity: text(row.audit_identity),
      role: text(row.role) as UserRole,
    };
  }

  resume(token: string): AuthSession {
    const actor = this.actorForToken(token);
    if (!actor) throw new Error("The saved session has expired. Sign in again.");
    const user = this.listUsers().find((entry) => entry.userId === actor.userId)!;
    const session = this.db.prepare("SELECT expires_at FROM ops_sessions WHERE token_hash = ?").get(hashToken(token)) as Row;
    return { token, expiresAt: text(session.expires_at), user, permissions: permissionsForRole(user.role) };
  }

  logout(token: string): void {
    this.db.prepare("DELETE FROM ops_sessions WHERE token_hash = ?").run(hashToken(text(token)));
  }

  saveUser(input: SaveUserInput, actor: ActorContext): AuthUser {
    requirePermission(actor, "AUTH_MANAGE_USERS");
    return this.transaction("saving a local user", () => {
      const id = text(input.id) || randomUUID();
      const displayName = text(input.displayName);
      const username = text(input.username);
      const email = emailAddress(input.email);
      const role = input.role;
      if (!displayName || !username) throw new Error("Display name and username are required.");
      if (!["STORE", "ACCOUNTS", "PRODUCTION", "SALES", "ADMIN"].includes(role)) throw new Error("Choose a valid role.");
      const existing = this.db.prepare("SELECT * FROM ops_users WHERE id = ?").get(id) as Row | undefined;
      const timestamp = nowIso();
      if (!existing) {
        const credential = String(input.credential ?? "");
        if (!credential) throw new Error("A credential is required for a new user.");
        const credentialType = input.credentialType === "PIN" ? "PIN" : "PASSWORD";
        const hashed = hashCredential(credential, credentialType);
        this.db.prepare(`
          INSERT INTO ops_users(
            id, display_name, username, credential_hash, credential_salt, credential_type,
            role, active, must_reset_credential, audit_identity, email, email_required, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `).run(
          id, displayName, username, hashed.hash, hashed.salt, credentialType, role,
          input.active === false ? 0 : 1, input.mustResetCredential ? 1 : 0,
          text(input.auditIdentity) || `${role}:${username}`, email, timestamp, timestamp,
        );
      } else {
        if (input.expectedVersion != null && Number(existing.version) !== Number(input.expectedVersion)) {
          throw new Error("This user changed after it was opened. Refresh and try again.");
        }
        if (text(existing.id) === actor.userId && input.active === false) throw new Error("You cannot deactivate your own signed-in account.");
        this.db.prepare(`
          UPDATE ops_users SET display_name = ?, username = ?, role = ?, active = ?,
            must_reset_credential = ?, audit_identity = ?, email = ?, email_required = 0,
            version = version + 1, updated_at = ?
          WHERE id = ?
        `).run(
          displayName, username, role, input.active === false ? 0 : 1,
          input.mustResetCredential ? 1 : 0, text(input.auditIdentity) || `${role}:${username}`,
          email, timestamp, id,
        );
      }
      this.audit(actor, existing ? "USER_UPDATED" : "USER_CREATED", "USER", id, { username, role, active: input.active !== false });
      return this.listUsers().find((entry) => entry.userId === id)!;
    });
  }

  updateOwnEmail(input: { email: string }, actor: ActorContext): AuthUser {
    const email = emailAddress(input.email);
    this.transaction("saving an account recovery email", () => {
      this.db.prepare(`
        UPDATE ops_users SET email = ?, email_required = 0, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(email, nowIso(), actor.userId);
      this.audit(actor, "USER_EMAIL_UPDATED", "USER", actor.userId, { email });
    });
    return this.listUsers().find((user) => user.userId === actor.userId)!;
  }

  resetCredential(input: ResetCredentialInput, actor: ActorContext): void {
    requirePermission(actor, "AUTH_MANAGE_USERS");
    const credentialType = input.credentialType === "PIN" ? "PIN" : "PASSWORD";
    const hashed = hashCredential(String(input.credential ?? ""), credentialType);
    this.transaction("resetting a user credential", () => {
      const result = this.db.prepare(`
        UPDATE ops_users SET credential_hash = ?, credential_salt = ?, credential_type = ?,
          must_reset_credential = 1, version = version + 1, updated_at = ? WHERE id = ?
      `).run(hashed.hash, hashed.salt, credentialType, nowIso(), text(input.userId));
      if (Number(result.changes) !== 1) throw new Error("User not found.");
      this.db.prepare("DELETE FROM ops_sessions WHERE user_id = ?").run(text(input.userId));
      this.audit(actor, "CREDENTIAL_RESET", "USER", text(input.userId), { credentialType });
    });
  }

  private stockItem(tallyItemGuid: string): Row {
    const row = this.db.prepare(`
      SELECT id, tally_guid, COALESCE(NULLIF(local_name_override, ''), name) AS name, parent_name
      FROM tally_stock_items WHERE tally_guid = ?
    `).get(text(tallyItemGuid)) as Row | undefined;
    if (!row) throw new Error("The selected Stock Item is not available.");
    return row;
  }

  private stockItemById(stockItemId: number): Row {
    const row = this.db.prepare(`
      SELECT id, tally_guid, COALESCE(NULLIF(local_name_override, ''), name) AS name, parent_name
      FROM tally_stock_items WHERE id = ?
    `).get(stockItemId) as Row | undefined;
    if (!row) throw new Error("Stock Item not found.");
    return row;
  }

  private supplierRow(supplierId: number | null | undefined): Row | null {
    if (supplierId == null) return null;
    return (this.db.prepare("SELECT id, name FROM suppliers WHERE id = ?").get(supplierId) as Row | undefined) ?? null;
  }

  private purchaseLotRow(purchaseLotId: number): Row {
    const row = this.db.prepare(`
      SELECT pl.*, item.tally_guid,
        COALESCE(NULLIF(item.local_name_override, ''), item.name) AS item_name,
        item.parent_name AS item_group,
        supplier.name AS supplier_name,
        g.purchase_order_id, g.id AS grn_id
      FROM purchase_lots pl
      JOIN tally_stock_items item ON item.id = pl.stock_item_id
      LEFT JOIN suppliers supplier ON supplier.id = pl.supplier_id
      LEFT JOIN grn_lines gl ON gl.id = pl.grn_line_id
      LEFT JOIN grns g ON g.id = gl.grn_id
      WHERE pl.id = ?
    `).get(purchaseLotId) as Row | undefined;
    if (!row) throw new Error("Inventory lot not found.");
    return row;
  }

  private ensureOpsLot(purchaseLotId: number, traceability?: TraceabilityInput, productOrderId = ""): string {
    const existing = this.db.prepare("SELECT id FROM ops_lots WHERE purchase_lot_id = ?").get(purchaseLotId) as Row | undefined;
    if (existing) {
      if (traceability || productOrderId) {
        this.db.prepare(`
          UPDATE ops_lots SET
            product_order_id = CASE WHEN ? <> '' THEN ? ELSE product_order_id END,
            batch_number = CASE WHEN ? <> '' THEN ? ELSE batch_number END,
            manufacturing_date = CASE WHEN ? <> '' THEN ? ELSE manufacturing_date END,
            expiry_date = CASE WHEN ? <> '' THEN ? ELSE expiry_date END,
            supplier_lot_reference = CASE WHEN ? <> '' THEN ? ELSE supplier_lot_reference END,
            traceability_notes = CASE WHEN ? <> '' THEN ? ELSE traceability_notes END,
            updated_at = ?
          WHERE id = ?
        `).run(
          productOrderId, productOrderId,
          text(traceability?.batchNumber), text(traceability?.batchNumber),
          optionalDate(traceability?.manufacturingDate), optionalDate(traceability?.manufacturingDate),
          optionalDate(traceability?.expiryDate), optionalDate(traceability?.expiryDate),
          text(traceability?.supplierLotReference), text(traceability?.supplierLotReference),
          text(traceability?.traceabilityNotes), text(traceability?.traceabilityNotes),
          nowIso(), text(existing.id),
        );
      }
      return text(existing.id);
    }
    const lot = this.purchaseLotRow(purchaseLotId);
    const id = `LOT-${randomUUID()}`;
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO ops_lots(
        id, purchase_lot_id, stock_item_id, supplier_id, purchase_order_id, receipt_grn_id,
        product_order_id, source_type, source_reference, batch_number, manufacturing_date,
        expiry_date, supplier_lot_reference, traceability_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, purchaseLotId, lot.stock_item_id, lot.supplier_id, lot.purchase_order_id,
      lot.grn_id, productOrderId, text(lot.source_type), text(lot.source_voucher_guid) || text(lot.grn_number),
      text(traceability?.batchNumber), optionalDate(traceability?.manufacturingDate),
      optionalDate(traceability?.expiryDate), text(traceability?.supplierLotReference),
      text(traceability?.traceabilityNotes), timestamp, timestamp,
    );
    this.db.prepare(`
      INSERT INTO ops_lot_balances(lot_id, condition, quantity, updated_at)
      VALUES (?, 'AVAILABLE', ?, ?)
    `).run(id, Number(lot.quantity_remaining), timestamp);
    return id;
  }

  reconcileLegacyLots(): void {
    this.transaction("reconciling inventory lots", () => {
      const lots = this.db.prepare("SELECT id FROM purchase_lots ORDER BY id").all() as Row[];
      for (const lot of lots) this.ensureOpsLot(Number(lot.id));
      this.db.prepare(`
        UPDATE ops_lot_balances
        SET quantity = (SELECT quantity_remaining FROM purchase_lots
          WHERE purchase_lots.id = (SELECT purchase_lot_id FROM ops_lots WHERE ops_lots.id = ops_lot_balances.lot_id)),
          updated_at = ?
        WHERE condition = 'AVAILABLE'
          AND NOT EXISTS (
            SELECT 1 FROM ops_movements movement
            JOIN ops_movement_lot_lines line ON line.movement_id = movement.id
            WHERE line.lot_id = ops_lot_balances.lot_id
          )
      `).run(nowIso());
    });
  }

  private balance(lotId: string, condition: OnHandCondition): number {
    const row = this.db.prepare(
      "SELECT quantity FROM ops_lot_balances WHERE lot_id = ? AND condition = ?",
    ).get(lotId, condition) as Row | undefined;
    return Number(row?.quantity ?? 0);
  }

  private changeBalance(lotId: string, condition: OnHandCondition, delta: number): void {
    const current = this.balance(lotId, condition);
    const next = current + delta;
    if (!Number.isInteger(next) || next < 0) {
      throw new Error(`The ${condition.toLocaleLowerCase().replaceAll("_", " ")} lot balance cannot become negative.`);
    }
    this.db.prepare(`
      INSERT INTO ops_lot_balances(lot_id, condition, quantity, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(lot_id, condition) DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at
    `).run(lotId, condition, next, nowIso());
  }

  private syncAvailableFromLegacyPurchaseLot(purchaseLotId: number): string {
    const lotId = this.ensureOpsLot(purchaseLotId);
    const lot = this.purchaseLotRow(purchaseLotId);
    const target = Number(lot.quantity_remaining);
    const current = this.balance(lotId, "AVAILABLE");
    if (target !== current) this.changeBalance(lotId, "AVAILABLE", target - current);
    return lotId;
  }

  private serialRows(lotId: string, condition: string): Row[] {
    return this.db.prepare(`
      SELECT * FROM ops_serials WHERE lot_id = ? AND condition = ? AND active = 1
      ORDER BY serial_number COLLATE NOCASE
    `).all(lotId, condition) as Row[];
  }

  private createSerials(lotId: string, stockItemId: number, condition: OnHandCondition, serials: string[]): void {
    const timestamp = nowIso();
    for (const serial of normalizeSerials(serials)) {
      try {
        this.db.prepare(`
          INSERT INTO ops_serials(serial_number, lot_id, stock_item_id, condition, active, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?)
        `).run(serial, lotId, stockItemId, condition, timestamp, timestamp);
      } catch (error) {
        if (/UNIQUE/i.test(error instanceof Error ? error.message : String(error))) {
          throw new Error(`Serial number ${serial} already exists in inventory history.`);
        }
        throw error;
      }
    }
  }

  private moveSerials(
    lotId: string,
    stockItemId: number,
    source: string,
    target: string,
    quantity: number,
    requested: string[],
  ): string[] {
    const serials = normalizeSerials(requested);
    const serialized = this.db.prepare(
      "SELECT COUNT(*) AS count FROM ops_serials WHERE lot_id = ? AND active = 1",
    ).get(lotId) as Row;
    if (Number(serialized.count) === 0 && serials.length === 0) return [];
    if (serials.length !== quantity) throw new Error(`Select exactly ${quantity} serial number${quantity === 1 ? "" : "s"}.`);
    const timestamp = nowIso();
    for (const serial of serials) {
      const row = this.db.prepare(`
        SELECT stock_item_id, condition, active FROM ops_serials
        WHERE serial_number = ? COLLATE NOCASE AND lot_id = ?
      `).get(serial, lotId) as Row | undefined;
      if (!row || Number(row.active) !== 1 || Number(row.stock_item_id) !== stockItemId || text(row.condition) !== source) {
        throw new Error(`Serial number ${serial} is not active in ${source.toLocaleLowerCase().replaceAll("_", " ")} stock for this lot.`);
      }
      this.db.prepare("UPDATE ops_serials SET condition = ?, active = ?, updated_at = ? WHERE serial_number = ? COLLATE NOCASE")
        .run(target, ["SCRAPPED", "RETURNED_TO_SUPPLIER"].includes(target) ? 0 : 1, timestamp, serial);
    }
    return serials;
  }

  private itemAvailable(stockItemId: number): number {
    return Number((this.db.prepare(
      "SELECT COALESCE(SUM(quantity_remaining), 0) AS quantity FROM purchase_lots WHERE stock_item_id = ?",
    ).get(stockItemId) as Row).quantity);
  }

  private createSyntheticPurchaseLot(
    stockItemId: number,
    quantity: number,
    eventDate: string,
    sourceReference: string,
    supplierId: number | null = null,
  ): number {
    const timestamp = nowIso();
    const insert = this.db.prepare(`
      INSERT INTO purchase_lots(
        stock_item_id, supplier_id, source_type, source_voucher_guid, source_voucher_date,
        grn_number, receipt_date, quantity_received, quantity_remaining, legacy_warning, created_at
      ) VALUES (?, ?, 'LOCAL_GRN', ?, ?, ?, ?, ?, 0, 0, ?)
    `).run(
      stockItemId, supplierId, sourceReference, eventDate, sourceReference,
      eventDate, quantity, timestamp,
    );
    return Number(insert.lastInsertRowid);
  }

  private lotForId(lotId: string): Row {
    const row = this.db.prepare(`
      SELECT ol.*, pl.receipt_date, pl.grn_number, pl.po_number,
        item.tally_guid, COALESCE(NULLIF(item.local_name_override, ''), item.name) AS item_name,
        item.parent_name AS item_group, supplier.name AS supplier_name
      FROM ops_lots ol
      JOIN purchase_lots pl ON pl.id = ol.purchase_lot_id
      JOIN tally_stock_items item ON item.id = ol.stock_item_id
      LEFT JOIN suppliers supplier ON supplier.id = ol.supplier_id
      WHERE ol.id = ?
    `).get(text(lotId)) as Row | undefined;
    if (!row) throw new Error("The selected inventory lot is unavailable.");
    return row;
  }

  private allocate(
    stockItemId: number,
    condition: OnHandCondition,
    quantity: number,
    preferredLotId = "",
    serialNumbers: string[] = [],
  ): Array<{ lotId: string; purchaseLotId: number; quantity: number; serialNumbers: string[] }> {
    const requested = whole(quantity, "Quantity");
    const serials = normalizeSerials(serialNumbers);
    if (serials.length > 0) {
      if (serials.length !== requested) throw new Error("The number of selected serials must match the quantity.");
      const groups = new Map<string, string[]>();
      for (const serial of serials) {
        const row = this.db.prepare(`
          SELECT serial.lot_id, lot.purchase_lot_id
          FROM ops_serials serial JOIN ops_lots lot ON lot.id = serial.lot_id
          WHERE serial.serial_number = ? COLLATE NOCASE AND serial.stock_item_id = ?
            AND serial.condition = ? AND serial.active = 1
        `).get(serial, stockItemId, condition) as Row | undefined;
        if (!row) throw new Error(`Serial number ${serial} is not available in the requested condition.`);
        const lotId = text(row.lot_id);
        groups.set(lotId, [...(groups.get(lotId) ?? []), serial]);
      }
      return [...groups.entries()].map(([lotId, values]) => ({
        lotId,
        purchaseLotId: Number((this.db.prepare("SELECT purchase_lot_id FROM ops_lots WHERE id = ?").get(lotId) as Row).purchase_lot_id),
        quantity: values.length,
        serialNumbers: values,
      }));
    }

    const lots = this.db.prepare(`
      SELECT balance.lot_id, lot.purchase_lot_id, balance.quantity
      FROM ops_lot_balances balance
      JOIN ops_lots lot ON lot.id = balance.lot_id
      JOIN purchase_lots pl ON pl.id = lot.purchase_lot_id
      WHERE lot.stock_item_id = ? AND balance.condition = ? AND balance.quantity > 0
        AND (? = '' OR balance.lot_id = ?)
      ORDER BY CASE WHEN balance.lot_id = ? THEN 0 ELSE 1 END,
        pl.receipt_date ASC, pl.source_voucher_date ASC, pl.id ASC
    `).all(stockItemId, condition, preferredLotId, preferredLotId, preferredLotId) as Row[];
    let remaining = requested;
    const allocations: Array<{ lotId: string; purchaseLotId: number; quantity: number; serialNumbers: string[] }> = [];
    for (const lot of lots) {
      if (remaining <= 0) break;
      const amount = Math.min(remaining, Number(lot.quantity));
      const serializedRows = this.serialRows(text(lot.lot_id), condition);
      if (serializedRows.length > 0) {
        throw new Error("This stock is serialized. Select the serial numbers for the transaction.");
      }
      allocations.push({ lotId: text(lot.lot_id), purchaseLotId: Number(lot.purchase_lot_id), quantity: amount, serialNumbers: [] });
      remaining -= amount;
    }
    if (remaining > 0) throw new Error(`Insufficient ${condition.toLocaleLowerCase().replaceAll("_", " ")} stock. ${requested - remaining} available; ${requested} requested.`);
    return allocations;
  }

  private insertMovement(input: {
    clientTransactionId: string;
    movementType: MovementType;
    eventDate?: string;
    stockItemId: number;
    quantity: number;
    sourceCondition?: StockCondition | null;
    targetCondition?: StockCondition | null;
    supplierId?: number | null;
    purchaseOrderId?: number | null;
    purchaseOrderReference?: string;
    receiptReference?: string;
    productOrderId?: string;
    productName?: string;
    faultId?: string;
    legacyMovementId?: string;
    referenceMovementId?: string;
    reversalOfMovementId?: string;
    status?: OperationsMovement["status"];
    notes?: string;
    metadata?: Record<string, unknown>;
    allocations: Array<{ lotId: string; purchaseLotId: number; quantity: number; sourceCondition?: StockCondition | null; targetCondition?: StockCondition | null; serialNumbers?: string[] }>;
  }, actor: ActorContext): string {
    const item = this.stockItemById(input.stockItemId);
    const supplier = this.supplierRow(input.supplierId);
    const movementId = `OPM-${randomUUID()}`;
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO ops_movements(
        id, client_transaction_id, movement_type, event_date, event_timestamp, stock_item_id,
        item_name_snapshot, item_group_snapshot, quantity, source_condition, target_condition,
        supplier_id, supplier_name_snapshot, purchase_order_id, purchase_order_reference,
        receipt_reference, product_order_id, product_name_snapshot, fault_id,
        legacy_movement_id, reference_movement_id, reversal_of_movement_id, status,
        notes, metadata_json, operator_user_id, operator_name, operator_role, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      movementId, text(input.clientTransactionId), input.movementType, dateOnly(input.eventDate), timestamp,
      input.stockItemId, text(item.name), text(item.parent_name), whole(input.quantity, "Movement quantity"),
      input.sourceCondition ?? null, input.targetCondition ?? null, input.supplierId ?? null,
      text(supplier?.name), input.purchaseOrderId ?? null, text(input.purchaseOrderReference),
      text(input.receiptReference), text(input.productOrderId), text(input.productName), text(input.faultId),
      text(input.legacyMovementId), text(input.referenceMovementId), text(input.reversalOfMovementId),
      input.status ?? "APPLIED", text(input.notes), json(input.metadata ?? {}), actor.userId,
      actor.displayName, actor.role, timestamp,
    );
    for (const allocation of input.allocations) {
      this.db.prepare(`
        INSERT INTO ops_movement_lot_lines(
          movement_id, lot_id, purchase_lot_id, quantity, source_condition, target_condition
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        movementId, allocation.lotId, allocation.purchaseLotId, allocation.quantity,
        allocation.sourceCondition ?? input.sourceCondition ?? null,
        allocation.targetCondition ?? input.targetCondition ?? null,
      );
      for (const serial of allocation.serialNumbers ?? []) {
        this.db.prepare("INSERT INTO ops_movement_serials(movement_id, serial_number) VALUES (?, ?)").run(movementId, serial);
      }
    }
    this.audit(actor, "STOCK_MOVEMENT", "MOVEMENT", movementId, { movementType: input.movementType, quantity: input.quantity });
    return movementId;
  }

  private addManualTallyReview(movementId: string, movementType: MovementType, reason: string): void {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT OR IGNORE INTO ops_tally_reviews(
        id, movement_id, movement_type, status, review_reason, created_at, updated_at
      ) VALUES (?, ?, ?, 'PENDING', ?, ?, ?)
    `).run(`OTR-${randomUUID()}`, movementId, movementType, reason, timestamp, timestamp);
  }

  private faultUnresolved(faultId: string): number {
    const row = this.db.prepare(`
      SELECT fault.quantity - COALESCE(SUM(resolution.quantity), 0) AS unresolved
      FROM ops_supplier_faults fault
      LEFT JOIN ops_supplier_fault_resolutions resolution ON resolution.fault_id = fault.id
      WHERE fault.id = ? GROUP BY fault.id
    `).get(faultId) as Row | undefined;
    if (!row) throw new Error("Supplier fault record not found.");
    return Number(row.unresolved);
  }

  registerVendorReceipt(input: any, movement: { id: string; tallyItemGuid: string; quantity: number }, actor: ActorContext): void {
    const grn = this.db.prepare(`
      SELECT grn.voucher_number AS grn_number
      FROM inventory_movements movement
      JOIN grns grn ON grn.id = movement.grn_id
      WHERE movement.id = ?
    `).get(movement.id) as Row | undefined;
    this.registerBulkReceipt(
      { ...input, lines: [{ ...input, quantity: movement.quantity }] },
      { grnNumber: text(grn?.grn_number), movements: [movement] },
      actor,
    );
  }

  registerBulkReceipt(input: any, result: { grnNumber: string; movements: Array<{ id: string; tallyItemGuid: string; quantity: number }> }, actor: ActorContext): void {
    requirePermission(actor, "RECEIVE_MATERIAL");
    this.transaction("recording receipt conditions", () => {
      const lines = Array.isArray(input.lines) ? input.lines : [];
      for (const receiptLine of lines) {
        const movement = result.movements.find((entry) => entry.tallyItemGuid === text(receiptLine.tallyItemGuid));
        if (!movement) throw new Error("The receipt result did not contain one of the submitted Stock Items.");
        const legacy = this.db.prepare("SELECT * FROM inventory_movements WHERE id = ?").get(movement.id) as Row;
        const lotRow = this.db.prepare(`
          SELECT pl.id, pl.grn_line_id, pl.stock_item_id, pl.supplier_id, pl.po_number, pl.grn_number,
            pl.challan_number, g.purchase_order_id
          FROM purchase_lots pl
          LEFT JOIN grn_lines gl ON gl.id = pl.grn_line_id
          LEFT JOIN grns g ON g.id = gl.grn_id
          WHERE pl.grn_line_id IN (SELECT id FROM grn_lines WHERE grn_id = ? AND stock_item_id = ?)
          ORDER BY pl.id DESC LIMIT 1
        `).get(legacy.grn_id, legacy.stock_item_id) as Row | undefined;
        if (!lotRow) throw new Error("The purchase lot for the receipt could not be located.");

        const total = whole(receiptLine.quantity, "Received quantity");
        const available = receiptLine.acceptedQuantity == null
          ? total - Number(receiptLine.pendingInspectionQuantity ?? 0) - Number(receiptLine.faultyQuantity ?? 0)
          : whole(receiptLine.acceptedQuantity, "Accepted quantity", true);
        const pending = whole(receiptLine.pendingInspectionQuantity ?? 0, "Pending-inspection quantity", true);
        const faulty = whole(receiptLine.faultyQuantity ?? 0, "Faulty quantity", true);
        if (available + pending + faulty !== total) {
          throw new Error("Accepted, pending-inspection, and faulty quantities must equal the received quantity.");
        }
        const traceability: TraceabilityInput = {
          batchNumber: text(receiptLine.batchNumber),
          manufacturingDate: text(receiptLine.manufacturingDate),
          expiryDate: text(receiptLine.expiryDate),
          supplierLotReference: text(receiptLine.supplierLotReference),
          traceabilityNotes: text(receiptLine.traceabilityNotes),
        };
        const lotId = this.ensureOpsLot(Number(lotRow.id), traceability);
        this.changeBalance(lotId, "AVAILABLE", available - this.balance(lotId, "AVAILABLE"));
        this.changeBalance(lotId, "PENDING_INSPECTION", pending - this.balance(lotId, "PENDING_INSPECTION"));
        this.changeBalance(lotId, "FAULTY", faulty - this.balance(lotId, "FAULTY"));

        const allSerials = normalizeSerials(receiptLine.serialNumbers);
        const availableSerials = normalizeSerials(receiptLine.availableSerialNumbers ?? (allSerials.length && available === total ? allSerials : []));
        const pendingSerials = normalizeSerials(receiptLine.pendingSerialNumbers);
        const faultySerials = normalizeSerials(receiptLine.faultySerialNumbers);
        const serialCount = availableSerials.length + pendingSerials.length + faultySerials.length;
        if (serialCount > 0 && serialCount !== total) throw new Error("The receipt serial count must equal the received quantity.");
        if (availableSerials.length && availableSerials.length !== available) throw new Error("Accepted serial count must equal accepted quantity.");
        if (pendingSerials.length && pendingSerials.length !== pending) throw new Error("Pending serial count must equal pending quantity.");
        if (faultySerials.length && faultySerials.length !== faulty) throw new Error("Faulty serial count must equal faulty quantity.");
        this.createSerials(lotId, Number(lotRow.stock_item_id), "AVAILABLE", availableSerials);
        this.createSerials(lotId, Number(lotRow.stock_item_id), "PENDING_INSPECTION", pendingSerials);
        this.createSerials(lotId, Number(lotRow.stock_item_id), "FAULTY", faultySerials);

        this.db.prepare(`
          INSERT OR IGNORE INTO ops_receipt_inspections(
            id, grn_line_id, lot_id, total_received, expected_quantity, available_quantity,
            pending_quantity, faulty_quantity, discrepancy_type, wrong_item_guid,
            fault_reason, recorded_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `RIN-${randomUUID()}`, lotRow.grn_line_id, lotId, total,
          receiptLine.expectedQuantity == null ? null : whole(receiptLine.expectedQuantity, "Expected quantity", true),
          available, pending, faulty, text(receiptLine.discrepancyType), text(receiptLine.wrongItemTallyGuid),
          text(receiptLine.faultReason), actor.displayName, nowIso(),
        );

        const conditions: Array<{ quantity: number; condition: OnHandCondition; type: MovementType; serials: string[] }> = [
          { quantity: available, condition: "AVAILABLE", type: "ACCEPTED_RECEIPT", serials: availableSerials },
          { quantity: pending, condition: "PENDING_INSPECTION", type: "PENDING_INSPECTION_RECEIPT", serials: pendingSerials },
          { quantity: faulty, condition: "FAULTY", type: "FAULTY_RECEIPT", serials: faultySerials },
        ];
        let faultyMovementId = "";
        for (const condition of conditions) {
          if (condition.quantity <= 0) continue;
          const clientId = `${text(input.clientTransactionId)}:${text(receiptLine.tallyItemGuid)}:${condition.condition}`;
          const existing = this.db.prepare("SELECT id FROM ops_movements WHERE client_transaction_id = ?").get(clientId) as Row | undefined;
          const movementId = existing ? text(existing.id) : this.insertMovement({
            clientTransactionId: clientId,
            movementType: condition.type,
            eventDate: input.receiptDate,
            stockItemId: Number(lotRow.stock_item_id),
            quantity: condition.quantity,
            sourceCondition: null,
            targetCondition: condition.condition,
            supplierId: Number(lotRow.supplier_id),
            purchaseOrderId: lotRow.purchase_order_id == null ? null : Number(lotRow.purchase_order_id),
            purchaseOrderReference: text(lotRow.po_number),
            receiptReference: text(lotRow.grn_number),
            legacyMovementId: movement.id,
            notes: text(receiptLine.faultReason),
            metadata: {
              challanNumber: text(lotRow.challan_number),
              discrepancyType: text(receiptLine.discrepancyType),
              expectedQuantity: receiptLine.expectedQuantity ?? null,
            },
            allocations: [{
              lotId,
              purchaseLotId: Number(lotRow.id),
              quantity: condition.quantity,
              sourceCondition: null,
              targetCondition: condition.condition,
              serialNumbers: condition.serials,
            }],
          }, actor);
          if (condition.type === "FAULTY_RECEIPT") faultyMovementId = movementId;
          if (condition.type !== "ACCEPTED_RECEIPT" || available !== total) {
            this.addManualTallyReview(movementId, condition.type, "Receipt condition split requires Accounts review before Tally entry.");
          }
        }

        if (faulty > 0) {
          const faultId = `FLT-${randomUUID()}`;
          const timestamp = nowIso();
          const supplier = this.supplierRow(Number(lotRow.supplier_id));
          const item = this.stockItemById(Number(lotRow.stock_item_id));
          this.db.prepare(`
            INSERT INTO ops_supplier_faults(
              id, supplier_id, supplier_name_snapshot, stock_item_id, item_name_snapshot,
              quantity, purchase_lot_id, lot_id, receipt_reference, purchase_order_reference,
              challan_reference, batch_number, serials_json, date_discovered,
              discovered_by_user_id, discovered_by_name, discovery_point, fault_reason,
              notes, status, current_resolution, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AT_RECEIPT', ?, ?, 'OPEN', 'PENDING', ?, ?)
          `).run(
            faultId, lotRow.supplier_id, text(supplier?.name), lotRow.stock_item_id, text(item.name),
            faulty, lotRow.id, lotId, text(lotRow.grn_number), text(lotRow.po_number),
            text(lotRow.challan_number), text(traceability.batchNumber), json(faultySerials), dateOnly(input.receiptDate),
            actor.userId, actor.displayName, text(receiptLine.faultReason) || "Fault identified at receipt",
            text(receiptLine.traceabilityNotes), timestamp, timestamp,
          );
          if (faultyMovementId) this.db.prepare("UPDATE ops_movements SET fault_id = ? WHERE id = ?").run(faultId, faultyMovementId);
          this.audit(actor, "SUPPLIER_FAULT_CREATED", "SUPPLIER_FAULT", faultId, { quantity: faulty, receipt: result.grnNumber });
        }
      }
    });
  }

  registerMaterialOut(input: any, movement: { id: string; quantity: number; tallyItemGuid: string }, actor: ActorContext): void {
    requirePermission(actor, "MATERIAL_ISSUE");
    this.transaction("linking a material issue to the condition ledger", () => {
      const existing = this.db.prepare("SELECT 1 FROM ops_movements WHERE legacy_movement_id = ?").get(movement.id);
      if (existing) return;
      const item = this.stockItem(input.tallyItemGuid);
      const allocations = this.db.prepare(`
        SELECT fa.purchase_lot_id, fa.quantity FROM fifo_allocations fa
        WHERE fa.movement_id = ? AND fa.direction = 'OUT' ORDER BY fa.id
      `).all(movement.id) as Row[];
      const requestedSerials = normalizeSerials(input.serialNumbers);
      let serialOffset = 0;
      const movementAllocations: Array<{ lotId: string; purchaseLotId: number; quantity: number; sourceCondition: StockCondition; targetCondition: StockCondition | null; serialNumbers: string[] }> = [];
      for (const allocation of allocations) {
        const quantity = Number(allocation.quantity);
        const lotSerials = requestedSerials.length ? requestedSerials.slice(serialOffset, serialOffset + quantity) : [];
        serialOffset += quantity;
        const lotId = this.ensureOpsLot(Number(allocation.purchase_lot_id));
        const movedSerials = this.moveSerials(lotId, Number(item.id), "AVAILABLE", "ISSUED", quantity, lotSerials);
        this.syncAvailableFromLegacyPurchaseLot(Number(allocation.purchase_lot_id));
        movementAllocations.push({
          lotId,
          purchaseLotId: Number(allocation.purchase_lot_id),
          quantity,
          sourceCondition: "AVAILABLE",
          targetCondition: null,
          serialNumbers: movedSerials,
        });
      }
      if (requestedSerials.length && serialOffset !== requestedSerials.length) throw new Error("Serial selection does not match the FIFO allocation.");
      const purpose = text(input.purpose)
        || (text(input.productOrderId) || text(input.destinationTallyItemGuid) ? "PRODUCTION" : "CUSTOMER_EXTRAS");
      const destination = text(input.destinationTallyItemGuid)
        ? this.db.prepare("SELECT id, COALESCE(NULLIF(local_name_override, ''), name) AS name FROM tally_stock_items WHERE tally_guid = ?")
          .get(text(input.destinationTallyItemGuid)) as Row | undefined
        : undefined;
      const movementId = this.insertMovement({
        clientTransactionId: text(input.clientTransactionId),
        movementType: "MATERIAL_ISSUE",
        eventDate: input.eventDate,
        stockItemId: Number(item.id),
        quantity: movement.quantity,
        sourceCondition: "AVAILABLE",
        targetCondition: null,
        productOrderId: text(input.productOrderId),
        productName: purpose === "PRODUCTION" ? text(destination?.name) : "",
        legacyMovementId: movement.id,
        notes: text(input.notes),
        metadata: {
          destinationTallyItemGuid: text(input.destinationTallyItemGuid),
          purpose,
          substitutionForTallyGuid: text(input.substitutionForTallyGuid),
          additionalConsumption: input.additionalConsumption === true,
        },
        allocations: movementAllocations,
      }, actor);
      this.addManualTallyReview(movementId, "MATERIAL_ISSUE", "Material issue follows the existing Material Out review mapping.");
      if (purpose === "PRODUCTION") {
        this.consumeProductionReservation(
          text(input.productOrderId),
          text(input.destinationTallyItemGuid),
          text(input.substitutionForTallyGuid) || text(input.tallyItemGuid),
          movement.quantity,
        );
      }
      if (text(input.productOrderId)) {
        this.ensureProductionExecution(text(input.productOrderId), actor);
        this.db.prepare("UPDATE ops_production_executions SET status = 'IN_PROGRESS', version = version + 1, updated_at = ? WHERE product_order_id = ?")
          .run(nowIso(), text(input.productOrderId));
      }
    });
  }

  private consumeProductionReservation(productOrderId: string, productTallyGuid: string, componentTallyGuid: string, quantity: number): void {
    const component = this.db.prepare("SELECT id FROM tally_stock_items WHERE tally_guid = ?").get(componentTallyGuid) as Row | undefined;
    if (!component) return;
    const rows = productOrderId
      ? this.db.prepare(`
          SELECT reservation.id, reservation.reserved_quantity
          FROM planning_reservations reservation
          WHERE reservation.product_order_id = ? AND reservation.component_item_id = ? AND reservation.status = 'ACTIVE'
        `).all(productOrderId, component.id) as Row[]
      : this.db.prepare(`
          SELECT reservation.id, reservation.reserved_quantity
          FROM planning_reservations reservation
          JOIN planning_product_orders product_order ON product_order.id = reservation.product_order_id
          JOIN tally_stock_items product ON product.id = product_order.product_item_id
          WHERE product.tally_guid = ? AND reservation.component_item_id = ?
            AND reservation.status = 'ACTIVE' AND product_order.status = 'CONFIRMED'
          ORDER BY product_order.required_date, product_order.created_at
        `).all(productTallyGuid, component.id) as Row[];
    let remaining = quantity;
    const update = this.db.prepare(`
      UPDATE planning_reservations
      SET reserved_quantity = ?, status = CASE WHEN ? = 0 THEN 'CONSUMED' ELSE status END, updated_at = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      if (remaining <= 0) break;
      const consumed = Math.min(remaining, Number(row.reserved_quantity));
      const next = Number(row.reserved_quantity) - consumed;
      update.run(next, next, nowIso(), row.id);
      remaining -= consumed;
    }
  }

  registerAdjustment(input: any, movement: { id: string; quantity: number; tallyItemGuid: string }, actor: ActorContext): void {
    const permission: Permission = input.direction === "RETURN_TO_STOCK" ? "PRODUCTION_RETURN" : "MATERIAL_ISSUE";
    requirePermission(actor, permission);
    this.transaction("linking an adjustment to the condition ledger", () => {
      if (this.db.prepare("SELECT 1 FROM ops_movements WHERE legacy_movement_id = ?").get(movement.id)) return;
      const item = this.stockItem(input.tallyItemGuid);
      const allocations = this.db.prepare(`
        SELECT fa.purchase_lot_id, fa.quantity, fa.direction FROM fifo_allocations fa
        WHERE fa.movement_id = ? ORDER BY fa.id
      `).all(movement.id) as Row[];
      const target: OnHandCondition | null = input.direction === "RETURN_TO_STOCK"
        ? (onHand(input.targetCondition) ? input.targetCondition : "AVAILABLE")
        : null;
      const lines: Array<{ lotId: string; purchaseLotId: number; quantity: number; sourceCondition: StockCondition | null; targetCondition: StockCondition | null; serialNumbers: string[] }> = [];
      const requestedSerials = normalizeSerials(input.serialNumbers);
      let offset = 0;
      for (const allocation of allocations) {
        const quantity = Number(allocation.quantity);
        const serials = requestedSerials.length ? requestedSerials.slice(offset, offset + quantity) : [];
        offset += quantity;
        const lotId = this.ensureOpsLot(Number(allocation.purchase_lot_id));
        if (input.direction === "RETURN_TO_STOCK") {
          const returnCondition = target ?? "AVAILABLE";
          const moved = this.moveSerials(lotId, Number(item.id), "ISSUED", returnCondition, quantity, serials);
          this.syncAvailableFromLegacyPurchaseLot(Number(allocation.purchase_lot_id));
          if (returnCondition !== "AVAILABLE") {
            this.changeBalance(lotId, "AVAILABLE", -quantity);
            this.changeBalance(lotId, returnCondition, quantity);
          }
          lines.push({ lotId, purchaseLotId: Number(allocation.purchase_lot_id), quantity, sourceCondition: null, targetCondition: returnCondition, serialNumbers: moved });
        } else {
          const moved = this.moveSerials(lotId, Number(item.id), "AVAILABLE", "ISSUED", quantity, serials);
          this.syncAvailableFromLegacyPurchaseLot(Number(allocation.purchase_lot_id));
          lines.push({ lotId, purchaseLotId: Number(allocation.purchase_lot_id), quantity, sourceCondition: "AVAILABLE", targetCondition: null, serialNumbers: moved });
        }
      }
      const type: MovementType = input.direction === "RETURN_TO_STOCK" ? "PRODUCTION_RETURN" : "MATERIAL_ISSUE";
      const movementId = this.insertMovement({
        clientTransactionId: text(input.clientTransactionId), movementType: type, eventDate: input.eventDate,
        stockItemId: Number(item.id), quantity: movement.quantity,
        sourceCondition: input.direction === "RETURN_TO_STOCK" ? null : "AVAILABLE",
        targetCondition: target, legacyMovementId: movement.id,
        productOrderId: text(input.productOrderId), referenceMovementId: text(input.referenceMovementId),
        notes: text(input.note), allocations: lines,
      }, actor);
      this.addManualTallyReview(movementId, type, "Adjustment requires Accounts review before Tally entry.");
    });
  }

  registerOpeningAdjustment(input: any, adjustment: { id: string; tallyItemGuid: string; deltaQuantity: number }, actor: ActorContext): void {
    requirePermission(actor, "STOCK_ADJUST");
    if (adjustment.deltaQuantity === 0) return;
    this.transaction("linking an opening-stock correction", () => {
      const item = this.stockItem(adjustment.tallyItemGuid);
      const quantity = Math.abs(adjustment.deltaQuantity);
      const source = adjustment.deltaQuantity < 0 ? "AVAILABLE" : null;
      const target = adjustment.deltaQuantity > 0 ? "AVAILABLE" : null;
      const affected = this.db.prepare(`
        SELECT id, quantity_remaining FROM purchase_lots
        WHERE stock_item_id = ? AND source_type = 'LEGACY_OPENING'
        ORDER BY id DESC
      `).all(item.id) as Row[];
      const lines: Array<{ lotId: string; purchaseLotId: number; quantity: number; sourceCondition: StockCondition | null; targetCondition: StockCondition | null }> = [];
      let remaining = quantity;
      for (const lot of affected) {
        if (remaining <= 0) break;
        const lotId = this.ensureOpsLot(Number(lot.id));
        const current = this.balance(lotId, "AVAILABLE");
        const databaseQty = Number(lot.quantity_remaining);
        const delta = Math.abs(databaseQty - current);
        if (delta <= 0) continue;
        this.changeBalance(lotId, "AVAILABLE", databaseQty - current);
        lines.push({ lotId, purchaseLotId: Number(lot.id), quantity: delta, sourceCondition: source, targetCondition: target });
        remaining -= delta;
      }
      if (remaining > 0) this.reconcileLegacyLots();
      const movementId = this.insertMovement({
        clientTransactionId: text(input.clientTransactionId), movementType: "OPENING_STOCK_CORRECTION",
        stockItemId: Number(item.id), quantity, sourceCondition: source, targetCondition: target,
        notes: text(input.reason), metadata: { openingAdjustmentId: adjustment.id }, allocations: lines,
      }, actor);
      this.addManualTallyReview(movementId, "OPENING_STOCK_CORRECTION", "Opening-stock corrections require manual Accounts review.");
    });
  }

  transitionCondition(input: ConditionTransitionInput, actor: ActorContext): OperationsMovement {
    const permission: Permission = input.toCondition === "FAULTY" ? "MARK_FAULTY"
      : input.toCondition === "RETURNED_TO_SUPPLIER" ? "SUPPLIER_RETURN"
        : input.toCondition === "SCRAPPED" ? "SCRAP_STOCK" : "INSPECT_STOCK";
    requirePermission(actor, permission);
    return this.runIdempotent(input.clientTransactionId, "CONDITION_TRANSITION", input, () => {
      const item = this.stockItem(input.tallyItemGuid);
      const lot = this.lotForId(input.lotId);
      if (Number(lot.stock_item_id) !== Number(item.id)) throw new Error("The selected lot belongs to a different Stock Item.");
      const quantity = whole(input.quantity, "Quantity");
      if (!onHand(input.fromCondition)) throw new Error("Choose an on-hand source condition.");
      if (input.fromCondition === input.toCondition) throw new Error("Choose a different destination condition.");
      const allocation = this.allocate(Number(item.id), input.fromCondition, quantity, input.lotId, input.serialNumbers);
      const serialTarget = onHand(input.toCondition) ? input.toCondition : input.toCondition;
      const lines: Array<{ lotId: string; purchaseLotId: number; quantity: number; sourceCondition: StockCondition; targetCondition: StockCondition; serialNumbers: string[] }> = [];
      for (const part of allocation) {
        this.changeBalance(part.lotId, input.fromCondition, -part.quantity);
        if (onHand(input.toCondition)) this.changeBalance(part.lotId, input.toCondition, part.quantity);
        const serials = this.moveSerials(part.lotId, Number(item.id), input.fromCondition, serialTarget, part.quantity, part.serialNumbers);
        lines.push({ ...part, sourceCondition: input.fromCondition, targetCondition: input.toCondition, serialNumbers: serials });
      }
      const movementType: MovementType = input.toCondition === "AVAILABLE" ? "INSPECTION_RELEASE"
        : input.toCondition === "FAULTY" ? "FAULT_DISCOVERED"
          : input.toCondition === "SCRAPPED" ? "SCRAP" : "SUPPLIER_RETURN";
      const movementId = this.insertMovement({
        clientTransactionId: input.clientTransactionId,
        movementType,
        eventDate: input.eventDate,
        stockItemId: Number(item.id),
        quantity,
        sourceCondition: input.fromCondition,
        targetCondition: input.toCondition,
        supplierId: lot.supplier_id == null ? null : Number(lot.supplier_id),
        purchaseOrderId: lot.purchase_order_id == null ? null : Number(lot.purchase_order_id),
        purchaseOrderReference: text(lot.po_number),
        receiptReference: text(lot.grn_number),
        notes: [text(input.reason), text(input.notes)].filter(Boolean).join(" · "),
        allocations: lines,
      }, actor);
      if (["SUPPLIER_RETURN", "SCRAP"].includes(movementType)) {
        this.addManualTallyReview(movementId, movementType, "No automatic Tally voucher mapping is configured for this operation.");
      }
      if (input.toCondition === "FAULTY") {
        this.insertFault({
          clientTransactionId: `${input.clientTransactionId}:fault`,
          tallyItemGuid: input.tallyItemGuid,
          quantity,
          lotId: input.lotId,
          sourceCondition: "FAULTY",
          dateDiscovered: input.eventDate,
          discoveryPoint: input.faultDiscoveryPoint ?? "IN_STORES",
          faultReason: input.reason,
          notes: input.notes,
          serialNumbers: input.serialNumbers,
        }, actor, movementId, false);
      }
      if (input.toCondition === "SCRAPPED") {
        this.db.prepare(`
          INSERT INTO ops_scrap_records(id, client_transaction_id, movement_id, reason, notes, recorded_by, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(`SCR-${randomUUID()}`, input.clientTransactionId, movementId, text(input.reason), text(input.notes), actor.displayName, nowIso());
      }
      if (input.toCondition === "RETURNED_TO_SUPPLIER") {
        this.db.prepare(`
          INSERT INTO ops_supplier_returns(
            id, client_transaction_id, movement_id, supplier_id, supplier_name_snapshot,
            supplier_return_reference, return_date, replacement_status, credit_status,
            notes, recorded_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 'PENDING', ?, ?, ?)
        `).run(
          `SRT-${randomUUID()}`, `${input.clientTransactionId}:supplier-return`, movementId,
          lot.supplier_id, text(lot.supplier_name), text(input.reason), dateOnly(input.eventDate),
          text(input.notes), actor.displayName, nowIso(),
        );
      }
      return this.getMovement(movementId)!;
    });
  }

  private insertFault(input: CreateFaultInput, actor: ActorContext, linkedMovementId = "", moveToFaulty = true): SupplierFaultRecord {
    const item = this.stockItem(input.tallyItemGuid);
    const quantity = whole(input.quantity, "Fault quantity");
    const sourceCondition = input.sourceCondition ?? "AVAILABLE";
    let lotId = text(input.lotId);
    let movementId = linkedMovementId;
    let lot: Row;
    if (!lotId) {
      const allocation = this.allocate(Number(item.id), sourceCondition, quantity, "", input.serialNumbers);
      if (allocation.length !== 1) throw new Error("Choose a specific lot when a fault quantity spans multiple supplier lots.");
      lotId = allocation[0].lotId;
    }
    lot = this.lotForId(lotId);
    if (moveToFaulty && sourceCondition !== "FAULTY") {
      const allocation = this.allocate(Number(item.id), sourceCondition, quantity, lotId, input.serialNumbers);
      const lines = allocation.map((part) => {
        this.changeBalance(part.lotId, sourceCondition, -part.quantity);
        this.changeBalance(part.lotId, "FAULTY", part.quantity);
        const serials = this.moveSerials(part.lotId, Number(item.id), sourceCondition, "FAULTY", part.quantity, part.serialNumbers);
        return { ...part, sourceCondition, targetCondition: "FAULTY" as StockCondition, serialNumbers: serials };
      });
      movementId = this.insertMovement({
        clientTransactionId: input.clientTransactionId,
        movementType: "FAULT_DISCOVERED",
        eventDate: input.dateDiscovered,
        stockItemId: Number(item.id), quantity, sourceCondition, targetCondition: "FAULTY",
        supplierId: lot.supplier_id == null ? null : Number(lot.supplier_id),
        purchaseOrderId: lot.purchase_order_id == null ? null : Number(lot.purchase_order_id),
        purchaseOrderReference: text(lot.po_number), receiptReference: text(lot.grn_number),
        notes: [text(input.faultReason), text(input.notes)].filter(Boolean).join(" · "), allocations: lines,
      }, actor);
    } else if (!movementId) {
      movementId = this.insertMovement({
        clientTransactionId: input.clientTransactionId,
        movementType: "FAULT_DISCOVERED",
        eventDate: input.dateDiscovered,
        stockItemId: Number(item.id), quantity, sourceCondition: "FAULTY", targetCondition: "FAULTY",
        supplierId: lot.supplier_id == null ? null : Number(lot.supplier_id),
        purchaseOrderId: lot.purchase_order_id == null ? null : Number(lot.purchase_order_id),
        purchaseOrderReference: text(lot.po_number), receiptReference: text(lot.grn_number),
        notes: [text(input.faultReason), text(input.notes)].filter(Boolean).join(" · "),
        allocations: [{ lotId, purchaseLotId: Number(lot.purchase_lot_id), quantity, sourceCondition: "FAULTY", targetCondition: "FAULTY", serialNumbers: normalizeSerials(input.serialNumbers) }],
      }, actor);
    }
    const faultId = `FLT-${randomUUID()}`;
    const timestamp = nowIso();
    const supplier = this.supplierRow(lot.supplier_id == null ? null : Number(lot.supplier_id));
    this.db.prepare(`
      INSERT INTO ops_supplier_faults(
        id, supplier_id, supplier_name_snapshot, stock_item_id, item_name_snapshot,
        quantity, purchase_lot_id, lot_id, receipt_reference, purchase_order_reference,
        challan_reference, batch_number, serials_json, date_discovered,
        discovered_by_user_id, discovered_by_name, discovery_point, fault_reason,
        notes, status, current_resolution, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', 'PENDING', ?, ?)
    `).run(
      faultId, lot.supplier_id, text(supplier?.name), item.id, text(item.name), quantity,
      lot.purchase_lot_id, lotId, text(lot.grn_number), text(lot.po_number), text(lot.challan_number),
      text(lot.batch_number), json(normalizeSerials(input.serialNumbers)), dateOnly(input.dateDiscovered),
      actor.userId, actor.displayName, input.discoveryPoint, text(input.faultReason), text(input.notes), timestamp, timestamp,
    );
    if (movementId) this.db.prepare("UPDATE ops_movements SET fault_id = ? WHERE id = ?").run(faultId, movementId);
    this.audit(actor, "SUPPLIER_FAULT_CREATED", "SUPPLIER_FAULT", faultId, { quantity, movementId });
    return this.getFault(faultId)!;
  }

  createFault(input: CreateFaultInput, actor: ActorContext): SupplierFaultRecord {
    requirePermission(actor, "MARK_FAULTY");
    return this.runIdempotent(input.clientTransactionId, "CREATE_SUPPLIER_FAULT", input, () => this.insertFault(input, actor));
  }

  resolveFault(input: ResolveFaultInput, actor: ActorContext): SupplierFaultRecord {
    const permission: Permission = input.resolution === "RETURNED_TO_SUPPLIER" ? "SUPPLIER_RETURN"
      : input.resolution === "SCRAPPED" ? "SCRAP_STOCK"
        : input.resolution === "ACCEPTED_BACK_INTO_AVAILABLE" ? "INSPECT_STOCK"
          : input.resolution === "REPLACEMENT_RECEIVED" ? "RECEIVE_MATERIAL"
            : ["REPLACEMENT_EXPECTED", "CREDIT_NOTE_EXPECTED", "CREDIT_NOTE_RECEIVED", "CLOSED_WITHOUT_FURTHER_ACTION"].includes(input.resolution)
              ? "PURCHASING_MANAGE"
              : "MARK_FAULTY";
    requirePermission(actor, permission);
    return this.runIdempotent(input.clientTransactionId, "RESOLVE_SUPPLIER_FAULT", input, () => {
      const fault = this.db.prepare("SELECT * FROM ops_supplier_faults WHERE id = ?").get(text(input.faultId)) as Row | undefined;
      if (!fault) throw new Error("Supplier fault record not found.");
      if (input.expectedVersion != null && Number(fault.version) !== Number(input.expectedVersion)) {
        throw new Error("This fault record changed after it was opened. Refresh and try again.");
      }
      const quantity = whole(input.quantity, "Resolution quantity");
      const unresolved = this.faultUnresolved(text(input.faultId));
      if (quantity > unresolved) throw new Error(`Only ${unresolved} faulty unit${unresolved === 1 ? " remains" : "s remain"} unresolved.`);
      const resolution = input.resolution;
      const lotId = text(fault.lot_id);
      const lot = lotId ? this.lotForId(lotId) : null;
      const item = this.stockItemById(Number(fault.stock_item_id));
      let movementId = "";
      if (["RETURNED_TO_SUPPLIER", "SCRAPPED", "ACCEPTED_BACK_INTO_AVAILABLE"].includes(resolution)) {
        if (!lot) throw new Error("The original inventory lot is unavailable for this stock resolution.");
        const target: StockCondition = resolution === "RETURNED_TO_SUPPLIER" ? "RETURNED_TO_SUPPLIER"
          : resolution === "SCRAPPED" ? "SCRAPPED" : "AVAILABLE";
        const allocation = this.allocate(Number(item.id), "FAULTY", quantity, lotId, input.serialNumbers);
        const lines = allocation.map((part) => {
          this.changeBalance(part.lotId, "FAULTY", -part.quantity);
          if (target === "AVAILABLE") this.changeBalance(part.lotId, "AVAILABLE", part.quantity);
          const serials = this.moveSerials(part.lotId, Number(item.id), "FAULTY", target, part.quantity, part.serialNumbers);
          return { ...part, sourceCondition: "FAULTY" as StockCondition, targetCondition: target, serialNumbers: serials };
        });
        const type: MovementType = target === "AVAILABLE" ? "INSPECTION_RELEASE" : target === "SCRAPPED" ? "SCRAP" : "SUPPLIER_RETURN";
        movementId = this.insertMovement({
          clientTransactionId: `${input.clientTransactionId}:movement`, movementType: type,
          stockItemId: Number(item.id), quantity, sourceCondition: "FAULTY", targetCondition: target,
          supplierId: fault.supplier_id == null ? null : Number(fault.supplier_id), faultId: text(fault.id),
          receiptReference: text(fault.receipt_reference), purchaseOrderReference: text(fault.purchase_order_reference),
          notes: [text(input.reference), text(input.notes)].filter(Boolean).join(" · "), allocations: lines,
        }, actor);
        if (type === "SCRAP") {
          this.db.prepare(`INSERT INTO ops_scrap_records(id, client_transaction_id, movement_id, fault_id, reason, notes, recorded_by, recorded_at)
            VALUES (?, ?, ?, ?, 'Supplier fault resolution', ?, ?, ?)`)
            .run(`SCR-${randomUUID()}`, `${input.clientTransactionId}:scrap`, movementId, fault.id, text(input.notes), actor.displayName, nowIso());
        }
        if (type !== "INSPECTION_RELEASE") this.addManualTallyReview(movementId, type, "Supplier-fault resolution requires manual Accounts review.");
        if (type === "SUPPLIER_RETURN") {
          this.db.prepare(`
            INSERT INTO ops_supplier_returns(
              id, client_transaction_id, movement_id, fault_id, supplier_id, supplier_name_snapshot,
              supplier_return_reference, return_date, replacement_status, credit_status,
              notes, recorded_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 'PENDING', ?, ?, ?)
          `).run(
            `SRT-${randomUUID()}`, `${input.clientTransactionId}:supplier-return`, movementId, fault.id,
            fault.supplier_id, text(fault.supplier_name_snapshot), text(input.reference) || `Fault ${fault.id}`,
            dateOnly(), text(input.notes), actor.displayName, nowIso(),
          );
        }
      } else if (resolution === "REPLACEMENT_RECEIVED") {
        const target = input.targetCondition === "PENDING_INSPECTION" ? "PENDING_INSPECTION" : "AVAILABLE";
        const eventDate = dateOnly();
        const purchaseLotId = this.createSyntheticPurchaseLot(Number(item.id), quantity, eventDate, `REPLACEMENT:${fault.id}`, fault.supplier_id == null ? null : Number(fault.supplier_id));
        const replacementLotId = this.ensureOpsLot(purchaseLotId, {
          batchNumber: text(fault.batch_number),
          serialNumbers: input.serialNumbers,
          traceabilityNotes: `Replacement for supplier fault ${fault.id}`,
        });
        this.changeBalance(replacementLotId, target, quantity);
        this.createSerials(replacementLotId, Number(item.id), target, normalizeSerials(input.serialNumbers));
        movementId = this.insertMovement({
          clientTransactionId: `${input.clientTransactionId}:movement`, movementType: target === "AVAILABLE" ? "ACCEPTED_RECEIPT" : "PENDING_INSPECTION_RECEIPT",
          stockItemId: Number(item.id), quantity, sourceCondition: null, targetCondition: target,
          supplierId: fault.supplier_id == null ? null : Number(fault.supplier_id), faultId: text(fault.id),
          receiptReference: text(input.reference), notes: text(input.notes), allocations: [{ lotId: replacementLotId, purchaseLotId, quantity, sourceCondition: null, targetCondition: target, serialNumbers: normalizeSerials(input.serialNumbers) }],
        }, actor);
        this.addManualTallyReview(movementId, target === "AVAILABLE" ? "ACCEPTED_RECEIPT" : "PENDING_INSPECTION_RECEIPT", "Replacement receipt requires manual Accounts review.");
      }

      const resolutionId = `FLR-${randomUUID()}`;
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO ops_supplier_fault_resolutions(
          id, client_transaction_id, fault_id, resolution, quantity, reference, notes,
          recorded_by_user_id, recorded_by_name, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(resolutionId, input.clientTransactionId, fault.id, resolution, quantity, text(input.reference), text(input.notes), actor.userId, actor.displayName, timestamp);
      const remaining = unresolved - quantity;
      const status = remaining === 0
        ? (resolution === "CLOSED_WITHOUT_FURTHER_ACTION" ? "CLOSED" : "RESOLVED")
        : "PARTIALLY_RESOLVED";
      this.db.prepare(`
        UPDATE ops_supplier_faults SET status = ?, current_resolution = ?, version = version + 1, updated_at = ? WHERE id = ?
      `).run(status, resolution, timestamp, fault.id);
      this.audit(actor, "SUPPLIER_FAULT_RESOLVED", "SUPPLIER_FAULT", text(fault.id), { resolution, quantity, remaining, movementId });
      return this.getFault(text(fault.id))!;
    });
  }

  private currentConditionTotal(stockItemId: number, condition: "AVAILABLE" | "FAULTY"): number {
    if (condition === "AVAILABLE") return this.itemAvailable(stockItemId);
    return Number((this.db.prepare(`
      SELECT COALESCE(SUM(balance.quantity), 0) AS quantity
      FROM ops_lot_balances balance JOIN ops_lots lot ON lot.id = balance.lot_id
      WHERE lot.stock_item_id = ? AND balance.condition = 'FAULTY'
    `).get(stockItemId) as Row).quantity);
  }

  private postSnapshotDelta(stockItemId: number, condition: "AVAILABLE" | "FAULTY", snapshotAt: string): number {
    const rows = this.db.prepare(`
      SELECT quantity, source_condition, target_condition
      FROM ops_movements
      WHERE stock_item_id = ? AND event_timestamp > ? AND status IN ('APPLIED','MANUAL_REVIEW')
    `).all(stockItemId, snapshotAt) as Row[];
    return rows.reduce((sum, row) => sum + movementDelta(row, condition), 0);
  }

  createCountSession(input: CreateCountSessionInput, actor: ActorContext): StockCountDetail {
    requirePermission(actor, "STOCK_COUNT");
    return this.runIdempotent(input.clientTransactionId, "CREATE_COUNT_SESSION", input, () => {
      const name = text(input.name);
      if (!name) throw new Error("Count session name is required.");
      const includeAvailable = input.includeAvailable !== false;
      const includeFaulty = input.includeFaulty !== false;
      if (!includeAvailable && !includeFaulty) throw new Error("Include available stock, faulty stock, or both.");
      const requested = new Set((input.tallyItemGuids ?? []).map(text).filter(Boolean));
      const items = this.db.prepare(`
        SELECT id, tally_guid FROM tally_stock_items
        WHERE active = 1 OR EXISTS (SELECT 1 FROM purchase_lots WHERE stock_item_id = tally_stock_items.id AND quantity_remaining > 0)
        ORDER BY name
      `).all() as Row[];
      const selected = input.scope === "FULL" ? items : items.filter((item) => requested.has(text(item.tally_guid)));
      if (selected.length === 0) throw new Error("Select at least one Stock Item for the cycle count.");
      const sessionId = `CNT-${randomUUID()}`;
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO ops_count_sessions(
          id, client_transaction_id, name, scope, status, snapshot_at,
          started_by_user_id, started_by_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)
      `).run(sessionId, input.clientTransactionId, name, input.scope, timestamp, actor.userId, actor.displayName, timestamp, timestamp);
      for (const item of selected) {
        if (includeAvailable) {
          this.db.prepare("INSERT INTO ops_count_items(session_id, stock_item_id, condition, snapshot_expected) VALUES (?, ?, 'AVAILABLE', ?)")
            .run(sessionId, item.id, this.currentConditionTotal(Number(item.id), "AVAILABLE"));
        }
        if (includeFaulty) {
          this.db.prepare("INSERT INTO ops_count_items(session_id, stock_item_id, condition, snapshot_expected) VALUES (?, ?, 'FAULTY', ?)")
            .run(sessionId, item.id, this.currentConditionTotal(Number(item.id), "FAULTY"));
        }
      }
      this.audit(actor, "COUNT_SESSION_CREATED", "COUNT_SESSION", sessionId, { scope: input.scope, items: selected.length });
      return this.getCountDetail(sessionId)!;
    });
  }

  recordCountEntry(input: RecordCountEntryInput, actor: ActorContext): StockCountDetail {
    requirePermission(actor, "STOCK_COUNT");
    return this.runIdempotent(input.clientTransactionId, "RECORD_COUNT_ENTRY", input, () => {
      const session = this.db.prepare("SELECT * FROM ops_count_sessions WHERE id = ?").get(text(input.sessionId)) as Row | undefined;
      if (!session) throw new Error("Count session not found.");
      if (!["DRAFT", "COUNTING"].includes(text(session.status))) throw new Error("This count session is no longer editable.");
      if (input.expectedVersion != null && Number(input.expectedVersion) !== Number(session.version)) {
        throw new Error("This count session changed after it was opened. Refresh and try again.");
      }
      const item = this.stockItem(input.tallyItemGuid);
      const countItem = this.db.prepare(`
        SELECT 1 FROM ops_count_items WHERE session_id = ? AND stock_item_id = ? AND condition = ?
      `).get(session.id, item.id, input.condition);
      if (!countItem) throw new Error("This item and condition are not part of the count session.");
      const counted = whole(input.countedQuantity, "Counted quantity", true);
      if (input.reason === "OTHER" && !text(input.notes)) throw new Error("Notes are required when the adjustment reason is Other.");
      const sequence = Number((this.db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM ops_count_entries
        WHERE session_id = ? AND stock_item_id = ? AND condition = ?
      `).get(session.id, item.id, input.condition) as Row).sequence);
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO ops_count_entries(
          id, client_transaction_id, session_id, stock_item_id, condition, counted_quantity,
          reason, notes, sequence, counted_by_user_id, counted_by_name, counted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`CNE-${randomUUID()}`, input.clientTransactionId, session.id, item.id, input.condition, counted,
        input.reason, text(input.notes), sequence, actor.userId, actor.displayName, timestamp);
      this.db.prepare(`
        UPDATE ops_count_sessions SET status = 'COUNTING', version = version + 1, updated_at = ? WHERE id = ?
      `).run(timestamp, session.id);
      this.audit(actor, "COUNT_ENTRY_RECORDED", "COUNT_SESSION", text(session.id), { item: item.tally_guid, condition: input.condition, counted, sequence });
      return this.getCountDetail(text(session.id))!;
    });
  }

  finalizeCount(input: FinalizeCountInput, actor: ActorContext): StockCountDetail {
    requirePermission(actor, "STOCK_ADJUST");
    return this.runIdempotent(input.clientTransactionId, "FINALIZE_COUNT", input, () => {
      const session = this.db.prepare("SELECT * FROM ops_count_sessions WHERE id = ?").get(text(input.sessionId)) as Row | undefined;
      if (!session) throw new Error("Count session not found.");
      if (!["DRAFT", "COUNTING"].includes(text(session.status))) throw new Error("This count session cannot be finalized.");
      if (input.expectedVersion != null && Number(input.expectedVersion) !== Number(session.version)) {
        throw new Error("This count session changed after it was opened. Refresh and try again.");
      }
      const detail = this.getCountDetail(text(session.id))!;
      const uncounted = detail.lines.filter((line) => line.countedQuantity == null);
      if (uncounted.length > 0) throw new Error(`${uncounted.length} count line${uncounted.length === 1 ? " is" : "s are"} still uncounted.`);
      for (const line of detail.lines) {
        const variance = Number(line.variance ?? 0);
        if (variance === 0) continue;
        const item = this.stockItem(line.tallyItemGuid);
        const movementType: MovementType = variance > 0 ? "COUNT_ADJUSTMENT_GAIN" : "COUNT_ADJUSTMENT_LOSS";
        const quantity = Math.abs(variance);
        const clientId = `${input.clientTransactionId}:${item.tally_guid}:${line.condition}`;
        let allocations: Array<{ lotId: string; purchaseLotId: number; quantity: number; sourceCondition: StockCondition | null; targetCondition: StockCondition | null }>;
        if (variance > 0) {
          const purchaseLotId = this.createSyntheticPurchaseLot(Number(item.id), quantity, dateOnly(), `COUNT:${session.id}`);
          const lotId = this.ensureOpsLot(purchaseLotId, { traceabilityNotes: `Count gain from ${session.name}` });
          this.changeBalance(lotId, line.condition, quantity);
          allocations = [{ lotId, purchaseLotId, quantity, sourceCondition: null, targetCondition: line.condition }];
        } else {
          const parts = this.allocate(Number(item.id), line.condition, quantity);
          allocations = parts.map((part) => {
            this.changeBalance(part.lotId, line.condition, -part.quantity);
            return { ...part, sourceCondition: line.condition, targetCondition: null };
          });
        }
        const movementId = this.insertMovement({
          clientTransactionId: clientId, movementType, stockItemId: Number(item.id), quantity,
          sourceCondition: variance < 0 ? line.condition : null,
          targetCondition: variance > 0 ? line.condition : null,
          notes: [line.reason?.replaceAll("_", " "), line.notes].filter(Boolean).join(" · "),
          metadata: { countSessionId: session.id, snapshotExpected: line.snapshotExpected, postSnapshotMovement: line.postSnapshotMovement, countedQuantity: line.countedQuantity },
          allocations,
        }, actor);
        this.addManualTallyReview(movementId, movementType, "Stock-count adjustment requires manual Accounts review.");
      }
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE ops_count_sessions SET status = 'FINALIZED', finalized_by_user_id = ?,
          finalized_by_name = ?, finalized_at = ?, version = version + 1, updated_at = ? WHERE id = ?
      `).run(actor.userId, actor.displayName, timestamp, timestamp, session.id);
      this.audit(actor, "COUNT_SESSION_FINALIZED", "COUNT_SESSION", text(session.id), { varianceUnits: detail.varianceUnits });
      return this.getCountDetail(text(session.id))!;
    });
  }

  productionReturn(input: ProductionReturnInput, actor: ActorContext): OperationsMovement {
    requirePermission(actor, "PRODUCTION_RETURN");
    return this.runIdempotent(input.clientTransactionId, "PRODUCTION_RETURN", input, () => {
      const item = this.stockItem(input.tallyItemGuid);
      const quantity = whole(input.quantity, "Return quantity");
      const target = input.targetCondition;
      const serials = normalizeSerials(input.serialNumbers);
      const lines: Array<{ lotId: string; purchaseLotId: number; quantity: number; sourceCondition: null; targetCondition: StockCondition; serialNumbers: string[] }> = [];
      const referenceId = text(input.originalMovementId);
      if (referenceId) {
        const original = this.db.prepare(`
          SELECT * FROM ops_movements WHERE id = ? OR legacy_movement_id = ?
        `).get(referenceId, referenceId) as Row | undefined;
        if (!original || text(original.movement_type) !== "MATERIAL_ISSUE" || Number(original.stock_item_id) !== Number(item.id)) {
          throw new Error("The linked original movement is not a Material Out for this Stock Item.");
        }
        const originalLines = this.db.prepare(`
          SELECT line.* FROM ops_movement_lot_lines line WHERE line.movement_id = ? ORDER BY line.id
        `).all(original.id) as Row[];
        const alreadyReturned = Number((this.db.prepare(`
          SELECT COALESCE(SUM(quantity), 0) AS quantity FROM ops_movements
          WHERE reference_movement_id = ? AND movement_type = 'PRODUCTION_RETURN' AND status <> 'REVERSED'
        `).get(original.id) as Row).quantity);
        if (quantity > Number(original.quantity) - alreadyReturned) {
          throw new Error(`Only ${Number(original.quantity) - alreadyReturned} units remain returnable from the linked issue.`);
        }
        let remaining = quantity;
        let serialOffset = 0;
        for (const originalLine of originalLines) {
          if (remaining <= 0) break;
          const returnedForLine = Number((this.db.prepare(`
            SELECT COALESCE(SUM(return_line.quantity), 0) AS quantity
            FROM ops_movements return_movement
            JOIN ops_movement_lot_lines return_line ON return_line.movement_id = return_movement.id
            WHERE return_movement.reference_movement_id = ?
              AND return_movement.movement_type = 'PRODUCTION_RETURN'
              AND return_movement.status <> 'REVERSED'
              AND return_line.lot_id = ?
          `).get(original.id, originalLine.lot_id) as Row).quantity);
          const returnable = Math.max(0, Number(originalLine.quantity) - returnedForLine);
          const amount = Math.min(remaining, returnable);
          if (amount <= 0) continue;
          const selected = serials.length ? serials.slice(serialOffset, serialOffset + amount) : [];
          serialOffset += amount;
          this.changeBalance(text(originalLine.lot_id), target, amount);
          const moved = this.moveSerials(text(originalLine.lot_id), Number(item.id), "ISSUED", target, amount, selected);
          lines.push({ lotId: text(originalLine.lot_id), purchaseLotId: Number(originalLine.purchase_lot_id), quantity: amount, sourceCondition: null, targetCondition: target, serialNumbers: moved });
          remaining -= amount;
        }
        if (remaining !== 0) throw new Error("The linked issue no longer has enough reversible lot quantity.");
      } else {
        if (!text(input.explanation)) throw new Error("An explanation is required for an unlinked production return.");
        let lotId = text(input.lotId);
        let purchaseLotId: number;
        if (lotId) {
          const lot = this.lotForId(lotId);
          if (Number(lot.stock_item_id) !== Number(item.id)) throw new Error("The selected lot belongs to another Stock Item.");
          purchaseLotId = Number(lot.purchase_lot_id);
          this.changeBalance(lotId, target, quantity);
          if (serials.length > 0) {
            const issuedSerials = serials.filter((serial) => {
              const row = this.db.prepare(`
                SELECT condition, active FROM ops_serials
                WHERE serial_number = ? COLLATE NOCASE AND lot_id = ?
              `).get(serial, lotId) as Row | undefined;
              return row && Number(row.active) === 1 && text(row.condition) === "ISSUED";
            });
            if (issuedSerials.length === serials.length) {
              this.moveSerials(lotId, Number(item.id), "ISSUED", target, quantity, serials);
            } else if (issuedSerials.length > 0) {
              throw new Error("The selected serial numbers mix issued and unknown stock. Use a linked return or separate transactions.");
            } else {
              this.createSerials(lotId, Number(item.id), target, serials);
            }
          }
        } else {
          purchaseLotId = this.createSyntheticPurchaseLot(Number(item.id), quantity, dateOnly(input.eventDate), `UNLINKED-PRODUCTION-RETURN:${input.clientTransactionId}`);
          lotId = this.ensureOpsLot(purchaseLotId, { traceabilityNotes: text(input.explanation) }, text(input.productOrderId));
          this.changeBalance(lotId, target, quantity);
          this.createSerials(lotId, Number(item.id), target, serials);
        }
        lines.push({ lotId, purchaseLotId, quantity, sourceCondition: null, targetCondition: target, serialNumbers: serials });
      }
      const movementId = this.insertMovement({
        clientTransactionId: input.clientTransactionId, movementType: "PRODUCTION_RETURN",
        eventDate: input.eventDate, stockItemId: Number(item.id), quantity,
        sourceCondition: null, targetCondition: target, productOrderId: text(input.productOrderId),
        referenceMovementId: referenceId, notes: text(input.explanation), allocations: lines,
      }, actor);
      this.addManualTallyReview(movementId, "PRODUCTION_RETURN", "Production return requires manual Accounts review.");
      if (target === "FAULTY") {
        this.insertFault({
          clientTransactionId: `${input.clientTransactionId}:fault`, tallyItemGuid: input.tallyItemGuid,
          quantity, lotId: lines[0]?.lotId, sourceCondition: "FAULTY",
          discoveryPoint: "AFTER_PRODUCTION_RETURN", faultReason: text(input.explanation) || "Fault discovered after production return",
          serialNumbers: serials,
        }, actor, movementId, false);
      }
      return this.getMovement(movementId)!;
    });
  }

  supplierReturn(input: SupplierReturnInput, actor: ActorContext): OperationsMovement {
    requirePermission(actor, "SUPPLIER_RETURN");
    return this.runIdempotent(input.clientTransactionId, "SUPPLIER_RETURN", input, () => {
      const item = this.stockItem(input.tallyItemGuid);
      const lot = this.lotForId(input.lotId);
      if (Number(lot.stock_item_id) !== Number(item.id)) throw new Error("The selected supplier lot belongs to a different Stock Item.");
      if (lot.supplier_id == null) throw new Error("This lot has unknown supplier provenance and cannot be returned as a supplier return.");
      const quantity = whole(input.quantity, "Supplier return quantity");
      const allocations = this.allocate(Number(item.id), input.sourceCondition, quantity, input.lotId, input.serialNumbers);
      const lines = allocations.map((part) => {
        this.changeBalance(part.lotId, input.sourceCondition, -part.quantity);
        const moved = this.moveSerials(part.lotId, Number(item.id), input.sourceCondition, "RETURNED_TO_SUPPLIER", part.quantity, part.serialNumbers);
        return { ...part, sourceCondition: input.sourceCondition as StockCondition, targetCondition: "RETURNED_TO_SUPPLIER" as StockCondition, serialNumbers: moved };
      });
      const movementId = this.insertMovement({
        clientTransactionId: input.clientTransactionId, movementType: "SUPPLIER_RETURN",
        eventDate: input.returnDate, stockItemId: Number(item.id), quantity,
        sourceCondition: input.sourceCondition, targetCondition: "RETURNED_TO_SUPPLIER",
        supplierId: Number(lot.supplier_id), purchaseOrderId: lot.purchase_order_id == null ? null : Number(lot.purchase_order_id),
        purchaseOrderReference: text(lot.po_number), receiptReference: text(lot.grn_number),
        faultId: text(input.faultId), notes: text(input.notes), allocations: lines,
      }, actor);
      this.db.prepare(`
        INSERT INTO ops_supplier_returns(
          id, client_transaction_id, movement_id, fault_id, supplier_id, supplier_name_snapshot,
          supplier_return_reference, return_date, replacement_status, credit_status, notes,
          recorded_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `SRT-${randomUUID()}`, input.clientTransactionId, movementId, text(input.faultId), lot.supplier_id,
        text(lot.supplier_name), text(input.supplierReturnReference), dateOnly(input.returnDate),
        supplierFollowUpStatus(input.replacementStatus), supplierFollowUpStatus(input.creditStatus), text(input.notes), actor.displayName, nowIso(),
      );
      if (text(input.faultId)) {
        const fault = this.db.prepare("SELECT * FROM ops_supplier_faults WHERE id = ?").get(text(input.faultId)) as Row | undefined;
        if (!fault) throw new Error("The linked supplier fault record was not found.");
        if (text(fault.lot_id) && text(fault.lot_id) !== text(input.lotId)) throw new Error("The linked fault belongs to a different supplier lot.");
        const unresolved = this.faultUnresolved(text(input.faultId));
        if (quantity > unresolved) throw new Error(`Only ${unresolved} units remain unresolved on the linked fault.`);
        const timestamp = nowIso();
        this.db.prepare(`
          INSERT INTO ops_supplier_fault_resolutions(
            id, client_transaction_id, fault_id, resolution, quantity, reference, notes,
            recorded_by_user_id, recorded_by_name, recorded_at
          ) VALUES (?, ?, ?, 'RETURNED_TO_SUPPLIER', ?, ?, ?, ?, ?, ?)
        `).run(
          `FLR-${randomUUID()}`, `${input.clientTransactionId}:fault-resolution`, fault.id, quantity,
          text(input.supplierReturnReference), text(input.notes), actor.userId, actor.displayName, timestamp,
        );
        const remaining = unresolved - quantity;
        this.db.prepare(`
          UPDATE ops_supplier_faults SET status = ?, current_resolution = 'RETURNED_TO_SUPPLIER',
            version = version + 1, updated_at = ? WHERE id = ?
        `).run(remaining === 0 ? "RESOLVED" : "PARTIALLY_RESOLVED", timestamp, fault.id);
      }
      this.addManualTallyReview(movementId, "SUPPLIER_RETURN", "Supplier return has no configured automatic Tally voucher mapping.");
      return this.getMovement(movementId)!;
    });
  }

  updateSupplierReturn(input: UpdateSupplierReturnInput, actor: ActorContext): Record<string, unknown> {
    requirePermission(actor, "PURCHASING_MANAGE");
    return this.transaction("updating supplier-return follow-up", () => {
      const row = this.db.prepare("SELECT * FROM ops_supplier_returns WHERE id = ?").get(text(input.returnId)) as Row | undefined;
      if (!row) throw new Error("Supplier return record not found.");
      if (input.expectedVersion != null && Number(input.expectedVersion) !== Number(row.version)) {
        throw new Error("This supplier return changed after it was opened. Refresh and try again.");
      }
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE ops_supplier_returns SET replacement_status = ?, credit_status = ?, notes = ?,
          version = version + 1, updated_at = ? WHERE id = ?
      `).run(supplierFollowUpStatus(input.replacementStatus), supplierFollowUpStatus(input.creditStatus), text(input.notes), timestamp, row.id);
      this.audit(actor, "SUPPLIER_RETURN_FOLLOW_UP", "SUPPLIER_RETURN", text(row.id), {
        replacementStatus: input.replacementStatus,
        creditStatus: input.creditStatus,
      });
      return this.supplierReturnRow(text(row.id))!;
    });
  }

  initiateCustomerReturn(input: CustomerReturnInput, actor: ActorContext): Record<string, unknown> {
    requirePermission(actor, "CUSTOMER_RETURN_INITIATE");
    return this.runIdempotent(input.clientTransactionId, "INITIATE_CUSTOMER_RETURN", input, () => {
      const item = this.stockItem(input.tallyItemGuid);
      const quantity = whole(input.quantity, "Return quantity");
      const id = `CRT-${randomUUID()}`;
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO ops_customer_returns(
          id, client_transaction_id, external_reference, stock_item_id, item_name_snapshot,
          quantity, initiated_by_user_id, initiated_by_name, traceability_json, notes,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.clientTransactionId, text(input.externalReference), item.id, text(item.name), quantity,
        actor.userId, actor.displayName, json(input), text(input.notes), timestamp, timestamp);
      this.audit(actor, "CUSTOMER_RETURN_INITIATED", "CUSTOMER_RETURN", id, { quantity, externalReference: input.externalReference });
      return this.customerReturnRow(id)!;
    });
  }

  receiveCustomerReturn(input: ReceiveCustomerReturnInput, actor: ActorContext): Record<string, unknown> {
    requirePermission(actor, "CUSTOMER_RETURN_RECEIVE");
    return this.runIdempotent(input.clientTransactionId, "RECEIVE_CUSTOMER_RETURN", input, () => {
      const record = this.db.prepare("SELECT * FROM ops_customer_returns WHERE id = ?").get(text(input.returnId)) as Row | undefined;
      if (!record) throw new Error("Customer return record not found.");
      if (text(record.status) !== "AWAITING_STORE_RECEIPT") throw new Error("This customer return is not awaiting physical receipt.");
      const item = this.stockItemById(Number(record.stock_item_id));
      const quantity = Number(record.quantity);
      const purchaseLotId = this.createSyntheticPurchaseLot(Number(item.id), quantity, dateOnly(input.receiptDate), `CUSTOMER-RETURN:${record.id}`);
      const lotId = this.ensureOpsLot(purchaseLotId, input);
      this.changeBalance(lotId, input.condition, quantity);
      const serials = normalizeSerials(input.serialNumbers);
      if (serials.length && serials.length !== quantity) throw new Error("The serial count must equal the customer return quantity.");
      this.createSerials(lotId, Number(item.id), input.condition, serials);
      const movementId = this.insertMovement({
        clientTransactionId: `${input.clientTransactionId}:movement`, movementType: "CUSTOMER_RETURN_RECEIPT",
        eventDate: input.receiptDate, stockItemId: Number(item.id), quantity,
        sourceCondition: null, targetCondition: input.condition, receiptReference: text(record.external_reference),
        notes: text(record.notes), allocations: [{ lotId, purchaseLotId, quantity, sourceCondition: null, targetCondition: input.condition, serialNumbers: serials }],
      }, actor);
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE ops_customer_returns SET status = 'RECEIVED', received_by_user_id = ?,
          received_by_name = ?, received_condition = ?, movement_id = ?, received_at = ?, updated_at = ?
        WHERE id = ?
      `).run(actor.userId, actor.displayName, input.condition, movementId, timestamp, timestamp, record.id);
      this.addManualTallyReview(movementId, "CUSTOMER_RETURN_RECEIPT", "Customer return receipt requires manual Accounts review.");
      if (input.condition === "FAULTY") {
        this.insertFault({
          clientTransactionId: `${input.clientTransactionId}:fault`, tallyItemGuid: text(item.tally_guid), quantity,
          lotId, sourceCondition: "FAULTY", discoveryPoint: "AFTER_CUSTOMER_RETURN",
          faultReason: "Faulty customer return", notes: text(record.notes), serialNumbers: serials,
        }, actor, movementId, false);
      }
      return this.customerReturnRow(text(record.id))!;
    });
  }

  scrap(input: ScrapInput, actor: ActorContext): OperationsMovement {
    requirePermission(actor, "SCRAP_STOCK");
    return this.runIdempotent(input.clientTransactionId, "SCRAP_STOCK", input, () => {
      const item = this.stockItem(input.tallyItemGuid);
      const quantity = whole(input.quantity, "Scrap quantity");
      const allocations = this.allocate(Number(item.id), input.sourceCondition, quantity, text(input.lotId), input.serialNumbers);
      const lines = allocations.map((part) => {
        this.changeBalance(part.lotId, input.sourceCondition, -part.quantity);
        const moved = this.moveSerials(part.lotId, Number(item.id), input.sourceCondition, "SCRAPPED", part.quantity, part.serialNumbers);
        return { ...part, sourceCondition: input.sourceCondition as StockCondition, targetCondition: "SCRAPPED" as StockCondition, serialNumbers: moved };
      });
      const product = text(input.productOrderId)
        ? this.db.prepare(`
            SELECT COALESCE(NULLIF(item.local_name_override, ''), item.name) AS name
            FROM planning_product_orders product_order
            JOIN tally_stock_items item ON item.id = product_order.product_item_id
            WHERE product_order.id = ?
          `).get(text(input.productOrderId)) as Row | undefined
        : undefined;
      const movementId = this.insertMovement({
        clientTransactionId: input.clientTransactionId, movementType: "SCRAP", eventDate: input.eventDate,
        stockItemId: Number(item.id), quantity, sourceCondition: input.sourceCondition, targetCondition: "SCRAPPED",
        productOrderId: text(input.productOrderId), productName: text(product?.name),
        faultId: text(input.faultId), notes: [text(input.reason), text(input.notes)].filter(Boolean).join(" · "),
        allocations: lines,
      }, actor);
      this.db.prepare(`
        INSERT INTO ops_scrap_records(id, client_transaction_id, movement_id, product_order_id, fault_id, reason, notes, recorded_by, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`SCR-${randomUUID()}`, input.clientTransactionId, movementId, text(input.productOrderId), text(input.faultId), text(input.reason), text(input.notes), actor.displayName, nowIso());
      this.addManualTallyReview(movementId, "SCRAP", "Scrap/write-off requires manual Accounts review.");
      return this.getMovement(movementId)!;
    });
  }

  private ensureProductionExecution(productOrderId: string, actor?: ActorContext): void {
    const id = text(productOrderId);
    if (!id) return;
    const order = this.db.prepare("SELECT id, order_type FROM planning_product_orders WHERE id = ?").get(id) as Row | undefined;
    if (!order) throw new Error("Product order not found.");
    if (text(order.order_type) === "SERVICE") {
      throw new Error("Service Orders are tracked on the order dashboard and cannot enter Production execution.");
    }
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO ops_production_executions(product_order_id, status, created_at, updated_at)
      VALUES (?, 'PLANNED', ?, ?)
      ON CONFLICT(product_order_id) DO NOTHING
    `).run(id, timestamp, timestamp);
    if (actor) this.audit(actor, "PRODUCTION_EXECUTION_ENSURED", "PRODUCT_ORDER", id, {});
  }

  releaseProductOrder(productOrderId: string, clientTransactionId: string, notes: string, actor: ActorContext): ProductionExecution {
    requirePermission(actor, "PRODUCTION_EXECUTE");
    return this.runIdempotent(clientTransactionId, "RELEASE_PRODUCT_ORDER", { productOrderId, notes }, () => {
      this.ensureProductionExecution(productOrderId);
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE ops_production_executions SET status = 'RELEASED', notes = ?, released_by_user_id = ?,
          released_by_name = ?, released_at = ?, version = version + 1, updated_at = ?
        WHERE product_order_id = ?
      `).run(text(notes), actor.userId, actor.displayName, timestamp, timestamp, text(productOrderId));
      this.audit(actor, "PRODUCT_ORDER_RELEASED", "PRODUCT_ORDER", text(productOrderId), { notes });
      return this.getProductionExecution(text(productOrderId))!;
    });
  }

  setProductionOrderExecutionStatus(
    productOrderId: string,
    status: "CANCELLED" | "CLOSED",
    clientTransactionId: string,
    notes: string,
    actor: ActorContext,
  ): ProductionExecution {
    requirePermission(actor, "PRODUCTION_EXECUTE");
    return this.runIdempotent(clientTransactionId, `PRODUCT_ORDER_${status}`, { productOrderId, status, notes }, () => {
      this.ensureProductionExecution(productOrderId);
      const issued = Number((this.db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN movement_type = 'MATERIAL_ISSUE' THEN quantity ELSE 0 END), 0) AS issued
        FROM ops_movements WHERE product_order_id = ? AND status <> 'REVERSED'
      `).get(text(productOrderId)) as Row).issued);
      if (status === "CANCELLED" && issued > 0 && !text(notes)) {
        throw new Error("Explain how already-issued material will be handled before cancelling this production order.");
      }
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE ops_production_executions SET status = ?, notes = ?, closed_by_user_id = ?,
          closed_by_name = ?, closed_at = ?, version = version + 1, updated_at = ?
        WHERE product_order_id = ?
      `).run(status, text(notes), actor.userId, actor.displayName, timestamp, timestamp, text(productOrderId));
      this.audit(actor, `PRODUCT_ORDER_${status}`, "PRODUCT_ORDER", text(productOrderId), { issued, notes });
      return this.getProductionExecution(text(productOrderId))!;
    });
  }

  productionCompletion(input: ProductionCompletionInput, actor: ActorContext): ProductionExecution {
    requirePermission(actor, "PRODUCTION_EXECUTE");
    return this.runIdempotent(input.clientTransactionId, "PRODUCTION_COMPLETION", input, () => {
      this.ensureProductionExecution(input.productOrderId);
      const execution = this.db.prepare("SELECT * FROM ops_production_executions WHERE product_order_id = ?").get(text(input.productOrderId)) as Row;
      if (["CANCELLED", "CLOSED"].includes(text(execution.status))) throw new Error("This product order is not open for completion.");
      const item = this.stockItem(input.tallyItemGuid);
      const total = whole(input.completedQuantity, "Completed quantity");
      const pending = whole(input.pendingInspectionQuantity ?? 0, "Pending-inspection output", true);
      const faulty = whole(input.faultyQuantity ?? 0, "Faulty output", true);
      const available = input.availableQuantity == null ? total - pending - faulty : whole(input.availableQuantity, "Available output", true);
      if (available + pending + faulty !== total) throw new Error("Available, pending-inspection, and faulty output must equal completed quantity.");
      const eventDate = dateOnly(input.completionDate);
      const purchaseLotId = this.createSyntheticPurchaseLot(Number(item.id), total, eventDate, `PRODUCTION:${input.productOrderId}`);
      const lotId = this.ensureOpsLot(purchaseLotId, input, text(input.productOrderId));
      this.changeBalance(lotId, "AVAILABLE", available - this.balance(lotId, "AVAILABLE"));
      this.changeBalance(lotId, "PENDING_INSPECTION", pending);
      this.changeBalance(lotId, "FAULTY", faulty);
      const availableSerials = normalizeSerials(input.availableSerialNumbers ?? input.serialNumbers);
      const pendingSerials = normalizeSerials(input.pendingSerialNumbers);
      const faultySerials = normalizeSerials(input.faultySerialNumbers);
      const serialCount = availableSerials.length + pendingSerials.length + faultySerials.length;
      if (serialCount > 0 && serialCount !== total) throw new Error("Finished-product serial count must equal completed quantity.");
      if (availableSerials.length && availableSerials.length !== available) throw new Error("Available finished-product serial count is incorrect.");
      if (pendingSerials.length && pendingSerials.length !== pending) throw new Error("Pending finished-product serial count is incorrect.");
      if (faultySerials.length && faultySerials.length !== faulty) throw new Error("Faulty finished-product serial count is incorrect.");
      this.createSerials(lotId, Number(item.id), "AVAILABLE", availableSerials);
      this.createSerials(lotId, Number(item.id), "PENDING_INSPECTION", pendingSerials);
      this.createSerials(lotId, Number(item.id), "FAULTY", faultySerials);

      const parts: Array<{ quantity: number; condition: OnHandCondition; type: MovementType; serials: string[] }> = [
        { quantity: available, condition: "AVAILABLE", type: "PRODUCTION_COMPLETION", serials: availableSerials },
        { quantity: pending, condition: "PENDING_INSPECTION", type: "PRODUCTION_COMPLETION", serials: pendingSerials },
        { quantity: faulty, condition: "FAULTY", type: "FAULTY_PRODUCTION_OUTPUT", serials: faultySerials },
      ];
      for (const part of parts) {
        if (part.quantity <= 0) continue;
        const movementId = this.insertMovement({
          clientTransactionId: `${input.clientTransactionId}:${part.condition}`,
          movementType: part.type, eventDate, stockItemId: Number(item.id), quantity: part.quantity,
          sourceCondition: null, targetCondition: part.condition, productOrderId: text(input.productOrderId),
          productName: text(item.name), notes: text(input.notes),
          allocations: [{ lotId, purchaseLotId, quantity: part.quantity, sourceCondition: null, targetCondition: part.condition, serialNumbers: part.serials }],
        }, actor);
        this.addManualTallyReview(movementId, part.type, "Finished-goods receipt requires manual Accounts review until a Tally mapping is configured.");
      }
      this.db.prepare(`
        UPDATE ops_production_executions SET status = 'IN_PROGRESS', version = version + 1, updated_at = ? WHERE product_order_id = ?
      `).run(nowIso(), text(input.productOrderId));
      this.audit(actor, "PRODUCTION_COMPLETED_PARTIALLY", "PRODUCT_ORDER", text(input.productOrderId), { total, available, pending, faulty });
      return this.getProductionExecution(text(input.productOrderId))!;
    });
  }

  recordSyncException(input: {
    clientTransactionId: string;
    deviceId: string;
    operator: string;
    localTimestamp: string;
    operationType: string;
    tallyItemGuid?: string;
    requestedQuantity?: number;
    productOrderId?: string;
    reason: string;
    payload: Record<string, unknown>;
  }): SyncExceptionRecord {
    const existing = this.db.prepare("SELECT id FROM ops_sync_exceptions WHERE client_transaction_id = ?").get(text(input.clientTransactionId)) as Row | undefined;
    if (existing) return this.getSyncException(text(existing.id))!;
    const item = input.tallyItemGuid ? this.stockItem(input.tallyItemGuid) : null;
    const id = `SYN-${randomUUID()}`;
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO ops_sync_exceptions(
        id, client_transaction_id, device_id, operator_name, local_timestamp, server_timestamp,
        operation_type, stock_item_id, item_name_snapshot, requested_quantity, product_order_id,
        reason, available_quantity, original_payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, text(input.clientTransactionId), text(input.deviceId), text(input.operator),
      text(input.localTimestamp) || timestamp, timestamp, text(input.operationType), item?.id ?? null,
      text(item?.name), whole(input.requestedQuantity ?? 0, "Requested quantity", true), text(input.productOrderId),
      text(input.reason), item ? this.itemAvailable(Number(item.id)) : 0, json(input.payload), timestamp, timestamp,
    );
    return this.getSyncException(id)!;
  }

  markSyncException(
    exceptionId: string,
    status: "RESOLVED" | "CANCELLED" | "REPLACED",
    action: string,
    notes: string,
    actor: ActorContext,
    expectedVersion?: number,
  ): SyncExceptionRecord {
    requirePermission(actor, "SYNC_EXCEPTION_RESOLVE");
    return this.transaction("resolving a synchronization exception", () => {
      const row = this.db.prepare("SELECT * FROM ops_sync_exceptions WHERE id = ?").get(text(exceptionId)) as Row | undefined;
      if (!row) throw new Error("Synchronization exception not found.");
      if (expectedVersion != null && Number(expectedVersion) !== Number(row.version)) throw new Error("This exception changed after it was opened.");
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE ops_sync_exceptions SET status = ?, resolution_action = ?, resolution_notes = ?,
          resolved_by_user_id = ?, resolved_by_name = ?, resolved_at = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(status, action, text(notes), actor.userId, actor.displayName, timestamp, timestamp, row.id);
      this.audit(actor, "SYNC_EXCEPTION_RESOLVED", "SYNC_EXCEPTION", text(row.id), { status, action, notes });
      return this.getSyncException(text(row.id))!;
    });
  }

  recordAuthorizedShortage(
    exception: SyncExceptionRecord,
    clientTransactionId: string,
    notes: string,
    actor: ActorContext,
  ): OperationsMovement {
    requirePermission(actor, "SYNC_EXCEPTION_RESOLVE");
    return this.runIdempotent(clientTransactionId, "AUTHORIZED_SYNC_SHORTAGE", {
      exceptionId: exception.id,
      requestedQuantity: exception.requestedQuantity,
      tallyItemGuid: exception.tallyItemGuid,
      notes,
    }, () => {
      const item = this.stockItem(exception.tallyItemGuid);
      const movementId = this.insertMovement({
        clientTransactionId,
        movementType: "COUNT_ADJUSTMENT_LOSS",
        stockItemId: Number(item.id),
        quantity: exception.requestedQuantity,
        sourceCondition: "AVAILABLE",
        targetCondition: null,
        productOrderId: exception.productOrderId,
        status: "EXCEPTION",
        notes: notes || "Authorized shortage recorded from an offline synchronization exception.",
        metadata: {
          synchronizationExceptionId: exception.id,
          deviceId: exception.deviceId,
          originalClientTransactionId: exception.clientTransactionId,
          currentAvailableQuantity: exception.availableQuantity,
          doesNotReducePhysicalBalance: true,
        },
        allocations: [],
      }, actor);
      this.addManualTallyReview(
        movementId,
        "COUNT_ADJUSTMENT_LOSS",
        "Authorized offline shortage requires Accounts to determine the accounting treatment.",
      );
      return this.getMovement(movementId)!;
    });
  }

  reverseMovement(input: ReverseMovementInput, actor: ActorContext): OperationsMovement {
    requirePermission(actor, "TRANSACTION_REVERSE");
    return this.runIdempotent(input.clientTransactionId, "REVERSE_MOVEMENT", input, () => {
      const original = this.db.prepare("SELECT * FROM ops_movements WHERE id = ?").get(text(input.movementId)) as Row | undefined;
      if (!original) throw new Error("Movement not found.");
      if (text(original.movement_type) === "TRANSACTION_REVERSAL") throw new Error("Reverse the original movement, not its reversal.");
      const reversed = Number((this.db.prepare(`
        SELECT COALESCE(SUM(quantity), 0) AS quantity FROM ops_movements
        WHERE reversal_of_movement_id = ? AND status <> 'EXCEPTION'
      `).get(original.id) as Row).quantity);
      const reversible = Number(original.quantity) - reversed;
      const quantity = whole(input.quantity, "Reversal quantity");
      if (quantity > reversible) throw new Error(`Only ${reversible} unit${reversible === 1 ? " remains" : "s remain"} reversible.`);
      const source = original.target_condition ? text(original.target_condition) as StockCondition : null;
      const target = original.source_condition ? text(original.source_condition) as StockCondition : null;
      const originalLines = this.db.prepare("SELECT * FROM ops_movement_lot_lines WHERE movement_id = ? ORDER BY id").all(original.id) as Row[];
      let remaining = quantity;
      const serials = normalizeSerials(input.serialNumbers);
      let serialOffset = 0;
      const reversalLines: Array<{ lotId: string; purchaseLotId: number; quantity: number; sourceCondition: StockCondition | null; targetCondition: StockCondition | null; serialNumbers: string[] }> = [];
      try {
        this.transaction("validating transaction reversal", () => {
          for (const originalLine of originalLines) {
            if (remaining <= 0) break;
            const priorForLot = Number((this.db.prepare(`
              SELECT COALESCE(SUM(line.quantity), 0) AS quantity
              FROM ops_movements movement JOIN ops_movement_lot_lines line ON line.movement_id = movement.id
              WHERE movement.reversal_of_movement_id = ? AND movement.status <> 'EXCEPTION' AND line.lot_id = ?
            `).get(original.id, originalLine.lot_id) as Row).quantity);
            const availableForLot = Math.max(0, Number(originalLine.quantity) - priorForLot);
            const amount = Math.min(remaining, availableForLot);
            if (amount <= 0) continue;
            const selected = serials.length ? serials.slice(serialOffset, serialOffset + amount) : [];
            serialOffset += amount;
            if (source && onHand(source)) {
              if (this.balance(text(originalLine.lot_id), source) < amount) {
                throw new Error("Stock created by the original movement has already been consumed or moved.");
              }
              this.changeBalance(text(originalLine.lot_id), source, -amount);
            }
            if (target && onHand(target)) this.changeBalance(text(originalLine.lot_id), target, amount);
            let moved: string[] = [];
            if (source || target) {
              const sourceSerialCondition = source ?? (["SCRAPPED", "RETURNED_TO_SUPPLIER"].includes(text(original.target_condition)) ? text(original.target_condition) : "ISSUED");
              const targetSerialCondition = target ?? "ISSUED";
              moved = this.moveSerials(text(originalLine.lot_id), Number(original.stock_item_id), sourceSerialCondition, targetSerialCondition, amount, selected);
            }
            reversalLines.push({ lotId: text(originalLine.lot_id), purchaseLotId: Number(originalLine.purchase_lot_id), quantity: amount, sourceCondition: source, targetCondition: target, serialNumbers: moved });
            remaining -= amount;
          }
          if (remaining !== 0) throw new Error("The original lot quantities are no longer fully reversible.");
        });
      } catch (error) {
        const exception = this.recordSyncException({
          clientTransactionId: `${input.clientTransactionId}:exception`, deviceId: "DESKTOP", operator: actor.displayName,
          localTimestamp: nowIso(), operationType: "REVERSAL", requestedQuantity: quantity,
          reason: error instanceof Error ? error.message : String(error), payload: input as unknown as Record<string, unknown>,
        });
        return this.getMovement(this.insertMovement({
          clientTransactionId: input.clientTransactionId, movementType: "TRANSACTION_REVERSAL",
          eventDate: input.eventDate, stockItemId: Number(original.stock_item_id), quantity,
          sourceCondition: source, targetCondition: target, reversalOfMovementId: text(original.id),
          status: "EXCEPTION", notes: `${text(input.reason)} · Exception ${exception.id}: ${exception.reason}`,
          allocations: [],
        }, actor))!;
      }
      const movementId = this.insertMovement({
        clientTransactionId: input.clientTransactionId, movementType: "TRANSACTION_REVERSAL",
        eventDate: input.eventDate, stockItemId: Number(original.stock_item_id), quantity,
        sourceCondition: source, targetCondition: target, supplierId: original.supplier_id,
        purchaseOrderId: original.purchase_order_id, purchaseOrderReference: text(original.purchase_order_reference),
        receiptReference: text(original.receipt_reference), productOrderId: text(original.product_order_id),
        faultId: text(original.fault_id), referenceMovementId: text(original.reference_movement_id),
        reversalOfMovementId: text(original.id), notes: [text(input.reason), text(input.notes)].filter(Boolean).join(" · "),
        allocations: reversalLines,
      }, actor);
      if (quantity === reversible) this.db.prepare("UPDATE ops_movements SET status = 'REVERSED' WHERE id = ?").run(original.id);
      this.addManualTallyReview(movementId, "TRANSACTION_REVERSAL", "Transaction reversal requires manual Accounts review.");
      return this.getMovement(movementId)!;
    });
  }

  reviewManualTally(input: { reviewId: string; status: "APPROVED" | "PROCESSED" | "FAILED"; tallyVoucherReference?: string; notes?: string }, actor: ActorContext): ManualTallyReview {
    requirePermission(actor, "TALLY_REVIEW");
    const reference = text(input.tallyVoucherReference);
    if (input.status === "PROCESSED" && !reference) throw new Error("Enter the Tally voucher reference before marking this entry processed.");
    const timestamp = nowIso();
    const result = this.db.prepare(`
      UPDATE ops_tally_reviews SET status = ?, tally_voucher_reference = ?, notes = ?,
        reviewed_by_user_id = ?, reviewed_by_name = ?, reviewed_at = ?, updated_at = ? WHERE id = ?
    `).run(input.status, reference, text(input.notes), actor.userId, actor.displayName, timestamp, timestamp, text(input.reviewId));
    if (Number(result.changes) !== 1) throw new Error("Manual Tally review entry not found.");
    this.audit(actor, "TALLY_REVIEW_UPDATED", "TALLY_REVIEW", text(input.reviewId), input);
    return this.getManualTallyReviews().find((entry) => entry.id === input.reviewId)!;
  }

  private movementLines(movementId: string): MovementLotLine[] {
    return (this.db.prepare(`
      SELECT line.*, lot.batch_number,
        COALESCE((SELECT json_group_array(serial.serial_number)
          FROM ops_movement_serials link JOIN ops_serials serial ON serial.serial_number = link.serial_number
          WHERE link.movement_id = line.movement_id AND serial.lot_id = line.lot_id), '[]') AS serials_json
      FROM ops_movement_lot_lines line
      JOIN ops_lots lot ON lot.id = line.lot_id
      WHERE line.movement_id = ? ORDER BY line.id
    `).all(movementId) as Row[]).map((row) => ({
      lotId: text(row.lot_id),
      purchaseLotId: Number(row.purchase_lot_id),
      quantity: Number(row.quantity),
      sourceCondition: row.source_condition ? text(row.source_condition) as StockCondition : null,
      targetCondition: row.target_condition ? text(row.target_condition) as StockCondition : null,
      serialNumbers: parseJson<string[]>(row.serials_json, []),
      batchNumber: text(row.batch_number),
    }));
  }

  getMovement(id: string): OperationsMovement | null {
    const row = this.db.prepare(`
      SELECT movement.*, item.tally_guid,
        COALESCE(SUM(reversal.quantity), 0) AS reversed_quantity
      FROM ops_movements movement
      JOIN tally_stock_items item ON item.id = movement.stock_item_id
      LEFT JOIN ops_movements reversal ON reversal.reversal_of_movement_id = movement.id AND reversal.status <> 'EXCEPTION'
      WHERE movement.id = ?
      GROUP BY movement.id
    `).get(text(id)) as Row | undefined;
    if (!row) return null;
    return {
      id: text(row.id),
      clientTransactionId: text(row.client_transaction_id),
      movementType: text(row.movement_type) as MovementType,
      eventDate: text(row.event_date),
      eventTimestamp: text(row.event_timestamp),
      tallyItemGuid: text(row.tally_guid),
      itemName: text(row.item_name_snapshot),
      itemGroup: text(row.item_group_snapshot),
      quantity: Number(row.quantity),
      sourceCondition: row.source_condition ? text(row.source_condition) as StockCondition : null,
      targetCondition: row.target_condition ? text(row.target_condition) as StockCondition : null,
      supplierId: row.supplier_id == null ? null : Number(row.supplier_id),
      supplierName: text(row.supplier_name_snapshot),
      purchaseOrderId: row.purchase_order_id == null ? null : Number(row.purchase_order_id),
      purchaseOrderReference: text(row.purchase_order_reference),
      receiptReference: text(row.receipt_reference),
      productOrderId: text(row.product_order_id),
      productName: text(row.product_name_snapshot),
      faultId: text(row.fault_id),
      referenceMovementId: text(row.reference_movement_id),
      reversalOfMovementId: text(row.reversal_of_movement_id),
      status: text(row.status) as OperationsMovement["status"],
      notes: text(row.notes),
      operator: text(row.operator_name),
      operatorRole: text(row.operator_role) as UserRole,
      createdAt: text(row.created_at),
      reversibleQuantity: Math.max(0, Number(row.quantity) - Number(row.reversed_quantity)),
      lines: this.movementLines(text(row.id)),
    };
  }

  getMovements(limit = 1000): OperationsMovement[] {
    return (this.db.prepare("SELECT id FROM ops_movements ORDER BY event_timestamp DESC, created_at DESC LIMIT ?").all(Math.max(1, Math.min(limit, 5000))) as Row[])
      .map((row) => this.getMovement(text(row.id)))
      .filter((entry): entry is OperationsMovement => entry !== null);
  }

  private getFault(id: string): SupplierFaultRecord | null {
    const row = this.db.prepare(`
      SELECT fault.*, item.tally_guid,
        fault.quantity - COALESCE(SUM(resolution.quantity), 0) AS unresolved_quantity
      FROM ops_supplier_faults fault
      JOIN tally_stock_items item ON item.id = fault.stock_item_id
      LEFT JOIN ops_supplier_fault_resolutions resolution ON resolution.fault_id = fault.id
      WHERE fault.id = ? GROUP BY fault.id
    `).get(text(id)) as Row | undefined;
    if (!row) return null;
    const resolutions: SupplierFaultResolutionEntry[] = (this.db.prepare(`
      SELECT * FROM ops_supplier_fault_resolutions WHERE fault_id = ? ORDER BY recorded_at, id
    `).all(row.id) as Row[]).map((entry) => ({
      id: text(entry.id), resolution: text(entry.resolution) as FaultResolution,
      quantity: Number(entry.quantity), reference: text(entry.reference), notes: text(entry.notes),
      recordedBy: text(entry.recorded_by_name), recordedAt: text(entry.recorded_at),
    }));
    return {
      id: text(row.id), supplierId: row.supplier_id == null ? null : Number(row.supplier_id),
      supplierName: text(row.supplier_name_snapshot), tallyItemGuid: text(row.tally_guid),
      itemName: text(row.item_name_snapshot), quantity: Number(row.quantity),
      unresolvedQuantity: Number(row.unresolved_quantity), receiptReference: text(row.receipt_reference),
      purchaseOrderReference: text(row.purchase_order_reference), challanReference: text(row.challan_reference),
      purchaseLotId: row.purchase_lot_id == null ? null : Number(row.purchase_lot_id), lotId: text(row.lot_id),
      batchNumber: text(row.batch_number), serialNumbers: parseJson<string[]>(row.serials_json, []),
      dateDiscovered: text(row.date_discovered), discoveredBy: text(row.discovered_by_name),
      discoveryPoint: text(row.discovery_point) as SupplierFaultRecord["discoveryPoint"],
      faultReason: text(row.fault_reason), notes: text(row.notes), status: text(row.status) as SupplierFaultRecord["status"],
      currentResolution: text(row.current_resolution) as FaultResolution, createdAt: text(row.created_at),
      updatedAt: text(row.updated_at), version: Number(row.version), resolutions,
    };
  }

  getFaults(): SupplierFaultRecord[] {
    return (this.db.prepare("SELECT id FROM ops_supplier_faults ORDER BY date_discovered DESC, created_at DESC").all() as Row[])
      .map((row) => this.getFault(text(row.id)))
      .filter((entry): entry is SupplierFaultRecord => entry !== null);
  }

  private countLineRows(sessionId: string): StockCountLine[] {
    const session = this.db.prepare("SELECT snapshot_at FROM ops_count_sessions WHERE id = ?").get(sessionId) as Row | undefined;
    if (!session) return [];
    const rows = this.db.prepare(`
      SELECT count_item.*, item.tally_guid,
        COALESCE(NULLIF(item.local_name_override, ''), item.name) AS item_name,
        latest.counted_quantity, latest.reason, latest.notes, latest.counted_by_name,
        latest.counted_at,
        COALESCE((SELECT COUNT(*) FROM ops_count_entries entry_count
          WHERE entry_count.session_id = count_item.session_id
            AND entry_count.stock_item_id = count_item.stock_item_id
            AND entry_count.condition = count_item.condition), 0) AS entry_count
      FROM ops_count_items count_item
      JOIN tally_stock_items item ON item.id = count_item.stock_item_id
      LEFT JOIN ops_count_entries latest ON latest.id = (
        SELECT id FROM ops_count_entries candidate
        WHERE candidate.session_id = count_item.session_id
          AND candidate.stock_item_id = count_item.stock_item_id
          AND candidate.condition = count_item.condition
        ORDER BY candidate.sequence DESC LIMIT 1
      )
      WHERE count_item.session_id = ?
      ORDER BY item.name, count_item.condition
    `).all(sessionId) as Row[];
    return rows.map((row) => {
      const condition = text(row.condition) as "AVAILABLE" | "FAULTY";
      const postSnapshotMovement = this.postSnapshotDelta(Number(row.stock_item_id), condition, text(session.snapshot_at));
      const currentExpected = Math.max(0, Number(row.snapshot_expected) + postSnapshotMovement);
      const counted = row.counted_quantity == null ? null : Number(row.counted_quantity);
      return {
        sessionId, tallyItemGuid: text(row.tally_guid), itemName: text(row.item_name), condition,
        snapshotExpected: Number(row.snapshot_expected), postSnapshotMovement, currentExpected,
        countedQuantity: counted, variance: counted == null ? null : counted - currentExpected,
        reason: row.reason ? text(row.reason) as StockCountLine["reason"] : null,
        notes: text(row.notes), countedBy: text(row.counted_by_name), countedAt: row.counted_at ? text(row.counted_at) : null,
        entryCount: Number(row.entry_count),
      };
    });
  }

  private getCountDetail(id: string): StockCountDetail | null {
    const row = this.db.prepare("SELECT * FROM ops_count_sessions WHERE id = ?").get(text(id)) as Row | undefined;
    if (!row) return null;
    const lines = this.countLineRows(text(row.id));
    return {
      id: text(row.id), name: text(row.name), scope: text(row.scope) as StockCountDetail["scope"],
      status: text(row.status) as StockCountDetail["status"], startedAt: text(row.snapshot_at),
      finalizedAt: row.finalized_at ? text(row.finalized_at) : null, startedBy: text(row.started_by_name),
      finalizedBy: text(row.finalized_by_name), itemCount: new Set(lines.map((line) => line.tallyItemGuid)).size,
      countedLines: lines.filter((line) => line.countedQuantity != null).length,
      varianceUnits: lines.reduce((sum, line) => sum + Math.abs(line.variance ?? 0), 0),
      movementsAfterSnapshot: lines.reduce((sum, line) => sum + Math.abs(line.postSnapshotMovement), 0),
      version: Number(row.version), lines,
    };
  }

  getCountDetails(): StockCountDetail[] {
    return (this.db.prepare("SELECT id FROM ops_count_sessions ORDER BY snapshot_at DESC").all() as Row[])
      .map((row) => this.getCountDetail(text(row.id)))
      .filter((entry): entry is StockCountDetail => entry !== null);
  }

  private supplierReturnRow(id: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT * FROM ops_supplier_returns WHERE id = ?").get(text(id)) as Row | undefined;
    if (!row) return null;
    return {
      id: text(row.id), clientTransactionId: text(row.client_transaction_id), movementId: text(row.movement_id),
      faultId: text(row.fault_id), supplierId: row.supplier_id == null ? null : Number(row.supplier_id),
      supplierName: text(row.supplier_name_snapshot), supplierReturnReference: text(row.supplier_return_reference),
      returnDate: text(row.return_date), replacementStatus: text(row.replacement_status), creditStatus: text(row.credit_status),
      notes: text(row.notes), recordedBy: text(row.recorded_by), createdAt: text(row.created_at),
      updatedAt: text(row.updated_at || row.created_at), version: Number(row.version ?? 1),
    };
  }

  private customerReturnRow(id: string): Record<string, unknown> | null {
    const row = this.db.prepare(`
      SELECT customer_return.*, item.tally_guid FROM ops_customer_returns customer_return
      JOIN tally_stock_items item ON item.id = customer_return.stock_item_id WHERE customer_return.id = ?
    `).get(text(id)) as Row | undefined;
    if (!row) return null;
    return {
      id: text(row.id), clientTransactionId: text(row.client_transaction_id), externalReference: text(row.external_reference),
      tallyItemGuid: text(row.tally_guid), itemName: text(row.item_name_snapshot), quantity: Number(row.quantity),
      status: text(row.status), initiatedBy: text(row.initiated_by_name), receivedBy: text(row.received_by_name),
      receivedCondition: text(row.received_condition), movementId: text(row.movement_id),
      traceability: parseJson<Record<string, unknown>>(row.traceability_json, {}), notes: text(row.notes),
      createdAt: text(row.created_at), receivedAt: row.received_at ? text(row.received_at) : null,
    };
  }

  private getSyncException(id: string): SyncExceptionRecord | null {
    const row = this.db.prepare(`
      SELECT exception.*, item.tally_guid FROM ops_sync_exceptions exception
      LEFT JOIN tally_stock_items item ON item.id = exception.stock_item_id WHERE exception.id = ?
    `).get(text(id)) as Row | undefined;
    if (!row) return null;
    return {
      id: text(row.id), clientTransactionId: text(row.client_transaction_id), deviceId: text(row.device_id),
      operator: text(row.operator_name), localTimestamp: text(row.local_timestamp), serverTimestamp: text(row.server_timestamp),
      operationType: text(row.operation_type), tallyItemGuid: text(row.tally_guid), itemName: text(row.item_name_snapshot),
      requestedQuantity: Number(row.requested_quantity), productOrderId: text(row.product_order_id), reason: text(row.reason),
      availableQuantity: Number(row.available_quantity), status: text(row.status) as SyncExceptionRecord["status"],
      resolutionAction: text(row.resolution_action), resolutionNotes: text(row.resolution_notes),
      resolvedBy: text(row.resolved_by_name), resolvedAt: row.resolved_at ? text(row.resolved_at) : null,
      originalPayload: parseJson<Record<string, unknown>>(row.original_payload_json, {}), version: Number(row.version),
    };
  }

  getSyncExceptions(): SyncExceptionRecord[] {
    return (this.db.prepare("SELECT id FROM ops_sync_exceptions ORDER BY server_timestamp DESC").all() as Row[])
      .map((row) => this.getSyncException(text(row.id)))
      .filter((entry): entry is SyncExceptionRecord => entry !== null);
  }

  private getProductionExecution(productOrderId: string): ProductionExecution | null {
    const order = this.db.prepare(`
      SELECT product_order.*, execution.status AS execution_status, execution.notes AS execution_notes,
        execution.updated_at AS execution_updated_at, execution.version AS execution_version,
        product.tally_guid AS product_tally_guid,
        COALESCE(NULLIF(product.local_name_override, ''), product.name) AS product_name
      FROM planning_product_orders product_order
      JOIN tally_stock_items product ON product.id = product_order.product_item_id
      LEFT JOIN ops_production_executions execution ON execution.product_order_id = product_order.id
      WHERE product_order.id = ?
    `).get(text(productOrderId)) as Row | undefined;
    if (!order) return null;
    const requirements = this.db.prepare(`
      SELECT reservation.component_item_id, reservation.required_quantity, reservation.reserved_quantity,
        component.tally_guid, COALESCE(NULLIF(component.local_name_override, ''), component.name) AS component_name
      FROM planning_reservations reservation
      JOIN tally_stock_items component ON component.id = reservation.component_item_id
      WHERE reservation.product_order_id = ?
    `).all(order.id) as Row[];
    const actualComponents = this.db.prepare(`
      SELECT DISTINCT movement.stock_item_id AS component_item_id,
        item.tally_guid,
        COALESCE(NULLIF(item.local_name_override, ''), item.name) AS component_name
      FROM ops_movements movement
      JOIN tally_stock_items item ON item.id = movement.stock_item_id
      WHERE movement.product_order_id = ?
        AND movement.movement_type IN ('MATERIAL_ISSUE','PRODUCTION_RETURN','SCRAP')
        AND movement.status <> 'REVERSED'
    `).all(order.id) as Row[];
    const componentRows = new Map<number, Row>();
    for (const row of requirements) componentRows.set(Number(row.component_item_id), row);
    for (const row of actualComponents) {
      if (!componentRows.has(Number(row.component_item_id))) {
        componentRows.set(Number(row.component_item_id), {
          ...row,
          required_quantity: 0,
          reserved_quantity: 0,
        });
      }
    }
    const expectedComponents = [...componentRows.values()]
      .sort((left, right) => text(left.component_name).localeCompare(text(right.component_name)))
      .map((requirement) => {
        const usage = this.db.prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN movement_type = 'MATERIAL_ISSUE' AND stock_item_id = ? THEN quantity ELSE 0 END), 0) AS issued,
            COALESCE(SUM(CASE WHEN movement_type = 'PRODUCTION_RETURN' AND stock_item_id = ? THEN quantity ELSE 0 END), 0) AS returned,
            COALESCE(SUM(CASE WHEN movement_type = 'SCRAP' AND stock_item_id = ? THEN quantity ELSE 0 END), 0) AS scrapped
          FROM ops_movements WHERE product_order_id = ? AND status <> 'REVERSED'
        `).get(requirement.component_item_id, requirement.component_item_id, requirement.component_item_id, order.id) as Row;
        const issued = Number(usage.issued);
        const returned = Number(usage.returned);
        const scrapped = Number(usage.scrapped);
        const netConsumed = issued - returned;
        return {
          tallyItemGuid: text(requirement.tally_guid), itemName: text(requirement.component_name),
          expectedQuantity: Number(requirement.required_quantity), reservedQuantity: Number(requirement.reserved_quantity),
          issuedQuantity: issued, returnedQuantity: returned, scrappedQuantity: scrapped,
          netConsumed, variance: netConsumed - Number(requirement.required_quantity),
        };
      });
    const output = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN movement_type = 'PRODUCTION_COMPLETION' THEN quantity ELSE 0 END), 0) AS finished,
        COALESCE(SUM(CASE WHEN movement_type = 'FAULTY_PRODUCTION_OUTPUT' THEN quantity ELSE 0 END), 0) AS faulty
      FROM ops_movements WHERE product_order_id = ? AND status <> 'REVERSED'
    `).get(order.id) as Row;
    return {
      productOrderId: text(order.id), externalReference: text(order.external_reference),
      productTallyGuid: text(order.product_tally_guid), productName: text(order.product_name),
      orderedQuantity: Number(order.quantity), status: (text(order.execution_status) || "PLANNED") as ProductionExecution["status"],
      expectedComponents, finishedQuantity: Number(output.finished), faultyFinishedQuantity: Number(output.faulty),
      notes: text(order.execution_notes), updatedAt: text(order.execution_updated_at || order.updated_at),
      version: Number(order.execution_version ?? 1),
    };
  }

  getProductionExecutions(): ProductionExecution[] {
    const ids = this.db.prepare("SELECT id FROM planning_product_orders ORDER BY updated_at DESC").all() as Row[];
    return ids.map((row) => this.getProductionExecution(text(row.id))).filter((entry): entry is ProductionExecution => entry !== null);
  }

  private getManualTallyReviews(): ManualTallyReview[] {
    return (this.db.prepare(`
      SELECT review.*, movement.event_date, movement.item_name_snapshot, movement.quantity
      FROM ops_tally_reviews review JOIN ops_movements movement ON movement.id = review.movement_id
      ORDER BY review.created_at DESC
    `).all() as Row[]).map((row) => ({
      id: text(row.id), movementId: text(row.movement_id), movementType: text(row.movement_type) as MovementType,
      eventDate: text(row.event_date), itemName: text(row.item_name_snapshot), quantity: Number(row.quantity),
      status: text(row.status) as ManualTallyReview["status"], reviewReason: text(row.review_reason),
      tallyVoucherReference: text(row.tally_voucher_reference), reviewedBy: text(row.reviewed_by_name),
      reviewedAt: row.reviewed_at ? text(row.reviewed_at) : null, notes: text(row.notes),
    }));
  }

  private getBalances(): ConditionBalance[] {
    const today = dateOnly();
    const soon = new Date(`${today}T00:00:00.000Z`);
    soon.setUTCDate(soon.getUTCDate() + EXPIRING_SOON_DAYS);
    const soonDate = soon.toISOString().slice(0, 10);
    return (this.db.prepare(`
      SELECT balance.*, lot.purchase_lot_id, lot.supplier_id, lot.purchase_order_id,
        lot.source_type, lot.source_reference, lot.batch_number, lot.manufacturing_date,
        lot.expiry_date, lot.supplier_lot_reference, lot.traceability_notes,
        purchase_lot.receipt_date, purchase_lot.po_number, purchase_lot.grn_number,
        item.tally_guid, COALESCE(NULLIF(item.local_name_override, ''), item.name) AS item_name,
        item.parent_name AS item_group, supplier.name AS supplier_name,
        COALESCE((SELECT json_group_array(serial.serial_number) FROM ops_serials serial
          WHERE serial.lot_id = lot.id AND serial.condition = balance.condition AND serial.active = 1), '[]') AS serials_json
      FROM ops_lot_balances balance
      JOIN ops_lots lot ON lot.id = balance.lot_id
      JOIN purchase_lots purchase_lot ON purchase_lot.id = lot.purchase_lot_id
      JOIN tally_stock_items item ON item.id = lot.stock_item_id
      LEFT JOIN suppliers supplier ON supplier.id = lot.supplier_id
      WHERE balance.quantity > 0
      ORDER BY item.name, balance.condition, purchase_lot.receipt_date, purchase_lot.id
    `).all() as Row[]).map((row) => ({
      lotId: text(row.lot_id), purchaseLotId: Number(row.purchase_lot_id), tallyItemGuid: text(row.tally_guid),
      itemName: text(row.item_name), itemGroup: text(row.item_group), supplierId: row.supplier_id == null ? null : Number(row.supplier_id),
      supplierName: text(row.supplier_name), purchaseOrderId: row.purchase_order_id == null ? null : Number(row.purchase_order_id),
      poNumber: text(row.po_number), grnNumber: text(row.grn_number), receiptDate: text(row.receipt_date),
      sourceType: text(row.source_type), sourceReference: text(row.source_reference),
      condition: text(row.condition) as OnHandCondition, quantity: Number(row.quantity),
      batchNumber: text(row.batch_number), serialNumbers: parseJson<string[]>(row.serials_json, []),
      manufacturingDate: text(row.manufacturing_date), expiryDate: text(row.expiry_date),
      supplierLotReference: text(row.supplier_lot_reference), traceabilityNotes: text(row.traceability_notes),
      expired: Boolean(row.expiry_date && text(row.expiry_date) < today),
      expiringSoon: Boolean(row.expiry_date && text(row.expiry_date) >= today && text(row.expiry_date) <= soonDate),
    }));
  }

  getState(): OperationsState {
    this.reconcileLegacyLots();
    const balances = this.getBalances();
    const faults = this.getFaults();
    const countDetails = this.getCountDetails();
    const faultSummaryMap = new Map<string, SupplierFaultSummary>();
    for (const fault of faults) {
      const key = `${fault.supplierId ?? "UNKNOWN"}:${fault.tallyItemGuid}`;
      const current = faultSummaryMap.get(key) ?? {
        supplierId: fault.supplierId, supplierName: fault.supplierName || "Unknown supplier",
        tallyItemGuid: fault.tallyItemGuid, itemName: fault.itemName, totalFaulty: 0, unresolved: 0, faultCount: 0,
      };
      current.totalFaulty += fault.quantity;
      current.unresolved += fault.unresolvedQuantity;
      current.faultCount += 1;
      faultSummaryMap.set(key, current);
    }
    const supplierReturns = (this.db.prepare("SELECT id FROM ops_supplier_returns ORDER BY return_date DESC, created_at DESC").all() as Row[])
      .map((row) => this.supplierReturnRow(text(row.id))!);
    const customerReturns = (this.db.prepare("SELECT id FROM ops_customer_returns ORDER BY created_at DESC").all() as Row[])
      .map((row) => this.customerReturnRow(text(row.id))!);
    const scrapRecords = (this.db.prepare(`
      SELECT scrap.*, movement.item_name_snapshot, movement.quantity, movement.event_date
      FROM ops_scrap_records scrap JOIN ops_movements movement ON movement.id = scrap.movement_id
      ORDER BY scrap.recorded_at DESC
    `).all() as Row[]).map((row) => ({ ...row }));
    const wastageRows = this.db.prepare(`
      SELECT movement.item_name_snapshot AS material_name,
        COALESCE(NULLIF(movement.product_name_snapshot, ''), 'Unassigned / general') AS product_name,
        SUM(line.quantity) AS quantity,
        SUM(line.quantity * COALESCE(lot.rate,
          CASE WHEN lot.quantity_received > 0 THEN lot.value / lot.quantity_received END, 0)) AS value,
        SUM(CASE WHEN lot.rate IS NULL AND lot.value IS NULL THEN line.quantity ELSE 0 END) AS unvalued_quantity
      FROM ops_movements movement
      JOIN ops_movement_lot_lines line ON line.movement_id = movement.id
      JOIN purchase_lots lot ON lot.id = line.purchase_lot_id
      WHERE movement.movement_type = 'SCRAP' AND movement.status <> 'REVERSED'
      GROUP BY movement.item_name_snapshot,
        COALESCE(NULLIF(movement.product_name_snapshot, ''), 'Unassigned / general')
    `).all() as Row[];
    const aggregateWastage = (key: "material_name" | "product_name") => {
      const values = new Map<string, { name: string; quantity: number; value: number }>();
      for (const row of wastageRows) {
        const name = text(row[key]);
        const current = values.get(name) ?? { name, quantity: 0, value: 0 };
        current.quantity += Number(row.quantity);
        current.value += Number(row.value);
        values.set(name, current);
      }
      return [...values.values()].sort((left, right) => right.value - left.value || right.quantity - left.quantity);
    };
    const wastage = {
      totalQuantity: wastageRows.reduce((sum, row) => sum + Number(row.quantity), 0),
      totalValue: wastageRows.reduce((sum, row) => sum + Number(row.value), 0),
      unvaluedQuantity: wastageRows.reduce((sum, row) => sum + Number(row.unvalued_quantity), 0),
      byProduct: aggregateWastage("product_name"),
      byMaterial: aggregateWastage("material_name"),
    };
    const syncExceptions = this.getSyncExceptions();
    return {
      moduleVersion: this.moduleVersion, generatedAt: nowIso(), balances, movements: this.getMovements(), faults,
      faultSummary: [...faultSummaryMap.values()].sort((left, right) => right.unresolved - left.unresolved || left.supplierName.localeCompare(right.supplierName)),
      countSessions: countDetails.map(({ lines: _lines, ...session }) => session as StockCountSessionSummary), countDetails,
      supplierReturns, customerReturns, scrapRecords, productionExecutions: this.getProductionExecutions(),
      syncExceptions, manualTallyReviews: this.getManualTallyReviews(), wastage,
      reports: {
        available: balances.filter((entry) => entry.condition === "AVAILABLE").reduce((sum, entry) => sum + entry.quantity, 0),
        pendingInspection: balances.filter((entry) => entry.condition === "PENDING_INSPECTION").reduce((sum, entry) => sum + entry.quantity, 0),
        faulty: balances.filter((entry) => entry.condition === "FAULTY").reduce((sum, entry) => sum + entry.quantity, 0),
        expired: balances.filter((entry) => entry.expired).reduce((sum, entry) => sum + entry.quantity, 0),
        expiringSoon: balances.filter((entry) => entry.expiringSoon).reduce((sum, entry) => sum + entry.quantity, 0),
        serialized: balances.reduce((sum, entry) => sum + entry.serialNumbers.length, 0),
        unresolvedFaults: faults.reduce((sum, fault) => sum + fault.unresolvedQuantity, 0),
        unresolvedSyncExceptions: syncExceptions.filter((entry) => entry.status === "OPEN").length,
      },
    };
  }
}
