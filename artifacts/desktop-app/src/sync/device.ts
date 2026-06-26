import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A stable per-installation identifier, persisted once alongside deployment.json.
 * Used to bind offline permission snapshots and outbox commands to the device
 * that created them, independent of the (renameable, DHCP-assigned) computer name.
 */
export function readOrCreateDeviceId(userDataDirectory: string): string {
  const filePath = path.join(userDataDirectory, "device-id.txt");
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf8").trim();
    if (existing) return existing;
  }
  mkdirSync(userDataDirectory, { recursive: true });
  const id = randomUUID();
  writeFileSync(filePath, id, "utf8");
  return id;
}
