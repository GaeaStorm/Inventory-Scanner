import type { DatabaseSync } from "node:sqlite";

import type { ApplicationDatabaseMigration } from "../database/application-database";

export const CACHE_MODULE_NAME = "sync-cache";

export const cacheMigrations: ApplicationDatabaseMigration[] = [
  {
    version: 1,
    description: "Add LAN-client read cache, outbox, and offline permission snapshot tables",
    up(database: DatabaseSync) {
      database.exec(`
        CREATE TABLE cache_snapshots (
          domain TEXT PRIMARY KEY CHECK (domain IN ('stores', 'planning', 'operations')),
          state_json TEXT NOT NULL,
          cached_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE outbox_commands (
          operation_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          actor_user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          type TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SYNCING', 'ACCEPTED', 'CONFLICT', 'REJECTED')),
          result_json TEXT
        ) STRICT;

        CREATE INDEX idx_outbox_commands_status_created
          ON outbox_commands(status, created_at);

        CREATE TABLE offline_permission_snapshot (
          session_token TEXT PRIMARY KEY,
          device_fingerprint TEXT NOT NULL,
          user_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL,
          permissions_json TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          cached_at TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
];
