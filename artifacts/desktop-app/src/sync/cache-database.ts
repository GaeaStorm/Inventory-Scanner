import path from "node:path";

import { ApplicationDatabase } from "../database/application-database";
import { CACHE_MODULE_NAME, cacheMigrations } from "./cache-schema";

export type CacheDomain = "stores" | "planning" | "operations";

function nowIso(): string {
  return new Date().toISOString();
}

function text(value: unknown): string {
  return String(value ?? "");
}

/**
 * Owns the LAN client's local SQLite cache: read snapshots of each domain's
 * `/state` payload, the durable command outbox, and the offline permission
 * snapshot. Only constructed when deploymentConfig.role === "LAN_CLIENT".
 */
export class ClientCacheDatabase {
  readonly host: ApplicationDatabase;

  constructor(userDataDirectory: string) {
    this.host = new ApplicationDatabase(path.join(userDataDirectory, "data", "client-cache.sqlite"));
    this.host.migrateModule(CACHE_MODULE_NAME, cacheMigrations);
  }

  saveSnapshot(domain: CacheDomain, state: unknown): void {
    this.host.db.prepare(`
      INSERT INTO cache_snapshots(domain, state_json, cached_at) VALUES (?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET state_json = excluded.state_json, cached_at = excluded.cached_at
    `).run(domain, JSON.stringify(state), nowIso());
  }

  readSnapshot(domain: CacheDomain): { state: unknown; cachedAt: string } | null {
    const row = this.host.db.prepare(
      "SELECT state_json, cached_at FROM cache_snapshots WHERE domain = ?",
    ).get(domain) as { state_json: string; cached_at: string } | undefined;
    if (!row) return null;
    return { state: JSON.parse(row.state_json), cachedAt: row.cached_at };
  }

  enqueueCommand(input: {
    operationId: string;
    deviceId: string;
    actorUserId: string;
    type: string;
    endpoint: string;
    payload: unknown;
  }): void {
    const timestamp = nowIso();
    this.host.db.prepare(`
      INSERT INTO outbox_commands(
        operation_id, device_id, actor_user_id, created_at, updated_at, type, endpoint, payload_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
    `).run(input.operationId, input.deviceId, input.actorUserId, timestamp, timestamp, input.type, input.endpoint, JSON.stringify(input.payload));
  }

  pendingCommands(): Array<{
    operationId: string;
    type: string;
    endpoint: string;
    payload: unknown;
    createdAt: string;
  }> {
    const rows = this.host.db.prepare(
      "SELECT operation_id, type, endpoint, payload_json, created_at FROM outbox_commands WHERE status = 'PENDING' ORDER BY created_at ASC",
    ).all() as Array<{ operation_id: string; type: string; endpoint: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({
      operationId: row.operation_id,
      type: row.type,
      endpoint: row.endpoint,
      payload: JSON.parse(row.payload_json),
      createdAt: row.created_at,
    }));
  }

  markCommand(operationId: string, status: "PENDING" | "ACCEPTED" | "CONFLICT" | "REJECTED" | "SYNCING", result?: unknown): void {
    this.host.db.prepare(`
      UPDATE outbox_commands SET status = ?, result_json = ?, updated_at = ? WHERE operation_id = ?
    `).run(status, result === undefined ? null : JSON.stringify(result), nowIso(), operationId);
  }

  queuedCommandCount(): number {
    const row = this.host.db.prepare(
      "SELECT COUNT(*) AS count FROM outbox_commands WHERE status = 'PENDING'",
    ).get() as { count: number };
    return Number(row.count);
  }

  reviewableCommands(): Array<{ operationId: string; type: string; status: string; result: unknown; createdAt: string }> {
    const rows = this.host.db.prepare(
      "SELECT operation_id, type, status, result_json, created_at FROM outbox_commands WHERE status IN ('CONFLICT', 'REJECTED') ORDER BY created_at ASC",
    ).all() as Array<{ operation_id: string; type: string; status: string; result_json: string | null; created_at: string }>;
    return rows.map((row) => ({
      operationId: row.operation_id,
      type: row.type,
      status: row.status,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      createdAt: row.created_at,
    }));
  }

  saveOfflinePermissionSnapshot(input: {
    sessionToken: string;
    deviceFingerprint: string;
    userId: string;
    displayName: string;
    role: string;
    permissions: string[];
    expiresAt: string;
  }): void {
    this.host.db.exec("DELETE FROM offline_permission_snapshot");
    this.host.db.prepare(`
      INSERT INTO offline_permission_snapshot(
        session_token, device_fingerprint, user_id, display_name, role, permissions_json, expires_at, cached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.sessionToken, input.deviceFingerprint, input.userId, input.displayName, input.role, JSON.stringify(input.permissions), input.expiresAt, nowIso());
  }

  readOfflinePermissionSnapshot(): {
    sessionToken: string;
    deviceFingerprint: string;
    userId: string;
    displayName: string;
    role: string;
    permissions: string[];
    expiresAt: string;
  } | null {
    const row = this.host.db.prepare("SELECT * FROM offline_permission_snapshot LIMIT 1").get() as {
      session_token: string;
      device_fingerprint: string;
      user_id: string;
      display_name: string;
      role: string;
      permissions_json: string;
      expires_at: string;
    } | undefined;
    if (!row) return null;
    return {
      sessionToken: text(row.session_token),
      deviceFingerprint: text(row.device_fingerprint),
      userId: text(row.user_id),
      displayName: text(row.display_name),
      role: text(row.role),
      permissions: JSON.parse(row.permissions_json),
      expiresAt: text(row.expires_at),
    };
  }

  clearOfflinePermissionSnapshot(): void {
    this.host.db.exec("DELETE FROM offline_permission_snapshot");
  }
}
