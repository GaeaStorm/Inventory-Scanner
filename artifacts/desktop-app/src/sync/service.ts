import { randomUUID } from "node:crypto";

import type { ClientCacheDatabase, CacheDomain } from "./cache-database";

export interface EnqueueInput {
  type: string;
  endpoint: string;
  method?: "POST" | "PATCH" | "DELETE";
  payload: unknown;
  actorUserId: string;
}

export interface EnqueueResult {
  queued: boolean;
  operationId: string;
  result?: unknown;
}

const PING_INTERVAL_MS = 15_000;

/**
 * Runs in the main process for LAN_CLIENT installations. Tracks whether
 * Production is reachable, serves cached domain-state reads, queues
 * supported mutations into the durable outbox when offline, and replays the
 * queue against Production once reachable again.
 */
export class SyncService {
  private online = false;
  private sessionToken = "";
  private computerName = "";
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private replaying = false;

  constructor(
    private readonly cache: ClientCacheDatabase,
    private readonly deviceId: string,
    private readonly productionUrl: string,
  ) {}

  setSessionToken(token: string): void {
    this.sessionToken = token;
  }

  setComputerName(name: string): void {
    this.computerName = name;
  }

  isOnline(): boolean {
    return this.online;
  }

  start(): void {
    void this.checkReachability();
    this.pingTimer = setInterval(() => void this.checkReachability(), PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.sessionToken ? { "X-Inventory-Session": this.sessionToken } : {}),
      ...(this.computerName ? { "X-Inventory-Computer-Name": this.computerName } : {}),
      ...extra,
    };
  }

  async checkReachability(): Promise<boolean> {
    const wasOnline = this.online;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetch(`${this.productionUrl}/api/operations/auth/state`, {
          signal: controller.signal,
        });
        this.online = response.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      this.online = false;
    }
    if (this.online && !wasOnline) void this.replayPending();
    return this.online;
  }

  cachedState(domain: CacheDomain): { state: unknown; cachedAt: string } | null {
    return this.cache.readSnapshot(domain);
  }

  cacheState(domain: CacheDomain, state: unknown): void {
    this.cache.saveSnapshot(domain, state);
  }

  status(): { online: boolean; queuedCount: number; reviewable: ReturnType<ClientCacheDatabase["reviewableCommands"]> } {
    return {
      online: this.online,
      queuedCount: this.cache.queuedCommandCount(),
      reviewable: this.cache.reviewableCommands(),
    };
  }

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const operationId = randomUUID();
    if (this.online) {
      try {
        const result = await this.send(input.endpoint, input.method ?? "POST", input.payload);
        return { queued: false, operationId, result };
      } catch {
        this.online = false;
      }
    }
    this.cache.enqueueCommand({
      operationId,
      deviceId: this.deviceId,
      actorUserId: input.actorUserId,
      type: input.type,
      endpoint: input.endpoint,
      payload: input.payload,
    });
    return { queued: true, operationId };
  }

  private async send(endpoint: string, method: string, payload: unknown): Promise<unknown> {
    const response = await fetch(`${this.productionUrl}${endpoint}`, {
      method,
      headers: this.headers(),
      body: JSON.stringify(payload ?? {}),
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      const error = new Error(body.error || `Production server returned ${response.status}.`);
      (error as Error & { httpStatus?: number }).httpStatus = response.status;
      throw error;
    }
    return body;
  }

  async replayPending(): Promise<void> {
    if (this.replaying) return;
    this.replaying = true;
    try {
      for (const command of this.cache.pendingCommands()) {
        this.cache.markCommand(command.operationId, "SYNCING");
        try {
          const result = await this.send(command.endpoint, "POST", command.payload);
          this.cache.markCommand(command.operationId, "ACCEPTED", result);
        } catch (error) {
          const status = (error as Error & { httpStatus?: number }).httpStatus;
          if (status === undefined) {
            // Network failure mid-replay: Production went down again. Revert
            // to PENDING and stop; resume on the next reachable check.
            this.cache.markCommand(command.operationId, "PENDING");
            this.online = false;
            return;
          }
          const verdict = status >= 400 && status < 500 ? "REJECTED" : "CONFLICT";
          this.cache.markCommand(command.operationId, verdict, {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.replaying = false;
    }
  }
}
