import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ApplicationDatabaseMigration {
  version: number;
  description: string;
  up: (database: DatabaseSync) => void;
}

export class DatabaseBusyError extends Error {
  readonly retryAfterSeconds = 1;

  constructor(operation: string, cause?: unknown) {
    super(`The Local Stores Database is busy while ${operation}. Retry this request with the same transaction ID.`);
    this.name = "DatabaseBusyError";
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|database is busy|SQLITE_BUSY/i.test(message);
}

/**
 * Owns the single SQLite connection for the desktop process.
 *
 * Domain modules (Stores today, Production later) receive this object instead
 * of opening their own connections. This preserves one operational database,
 * one transaction coordinator, and one migration/backup lifecycle.
 */
export class ApplicationDatabase {
  readonly databasePath: string;
  private connection: DatabaseSync | null = null;
  private transactionDepth = 0;
  private savepointCounter = 0;

  constructor(databasePath: string) {
    this.databasePath = path.normalize(databasePath);
    mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.open();
  }

  get db(): DatabaseSync {
    if (!this.connection?.isOpen) {
      throw new Error("The application database is not open.");
    }
    return this.connection;
  }

  open(): void {
    if (this.connection?.isOpen) return;
    this.connection = new DatabaseSync(this.databasePath, {
      timeout: 15_000,
      enableForeignKeyConstraints: true,
    });
    this.connection.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 15000;
      PRAGMA wal_autocheckpoint = 1000;
    `);
  }

  close(): void {
    if (this.connection?.isOpen) this.connection.close();
    this.connection = null;
    this.transactionDepth = 0;
  }

  reopen(): void {
    this.close();
    this.open();
  }

  moduleVersion(moduleName: string): number {
    const table = this.db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'application_module_migrations'",
    ).get();
    if (!table) return 0;
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(version), 0) AS version
       FROM application_module_migrations WHERE module_name = ?`,
    ).get(moduleName) as { version?: number } | undefined;
    return Number(row?.version ?? 0);
  }

  /**
   * Future domains such as Production register their own ordered migrations
   * against this same connection. The caller may supply a validated backup
   * callback, which runs once before the first pending migration.
   */
  migrateModule(
    moduleName: string,
    migrations: ApplicationDatabaseMigration[],
    beforeMigrate?: () => void,
  ): number {
    const pending = [...migrations]
      .sort((left, right) => left.version - right.version)
      .filter((migration) => migration.version > this.moduleVersion(moduleName));
    if (pending.length === 0) return this.moduleVersion(moduleName);
    beforeMigrate?.();
    for (const migration of pending) {
      this.transaction(`migrating ${moduleName} to version ${migration.version}`, () => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS application_module_migrations (
            module_name TEXT NOT NULL,
            version INTEGER NOT NULL,
            description TEXT NOT NULL,
            applied_at TEXT NOT NULL,
            PRIMARY KEY(module_name, version)
          ) STRICT;
        `);
        migration.up(this.db);
        this.db.prepare(
          `INSERT INTO application_module_migrations(
             module_name, version, description, applied_at
           ) VALUES (?, ?, ?, ?)`,
        ).run(moduleName, migration.version, migration.description, new Date().toISOString());
      });
    }
    return this.moduleVersion(moduleName);
  }

  transaction<T>(operation: string, work: () => T): T {
    const root = this.transactionDepth === 0;
    const savepoint = `app_tx_${++this.savepointCounter}`;

    try {
      if (root) this.db.exec("BEGIN IMMEDIATE");
      else this.db.exec(`SAVEPOINT ${savepoint}`);
      this.transactionDepth += 1;

      const result = work();

      this.transactionDepth -= 1;
      if (root) this.db.exec("COMMIT");
      else this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.transactionDepth = Math.max(0, this.transactionDepth - 1);
      try {
        if (root) this.db.exec("ROLLBACK");
        else {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
      } catch {
        // Preserve the original failure. A future request will re-open the app
        // if SQLite itself became unavailable.
      }
      if (isBusyError(error)) throw new DatabaseBusyError(operation, error);
      throw error;
    }
  }
}
