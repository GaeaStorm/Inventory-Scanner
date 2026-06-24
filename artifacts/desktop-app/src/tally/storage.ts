import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  TallyConnectionSettings,
  TallyState,
  TallyStoresSnapshot,
} from "./types";

const DEFAULT_SETTINGS: TallyConnectionSettings = {
  host: process.env.INVENTORY_TALLY_HOST?.trim() || "accounts",
  port: 9000,
  company: "",
  timeoutMs: 15_000,
  historyFrom: "2000-01-01",
  fullVoucherHistory: true,
};

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return null;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

export class TallyStorage {
  readonly settingsPath: string;
  readonly cachePath: string;

  constructor(userDataDirectory: string) {
    this.settingsPath = path.join(userDataDirectory, "tally-settings.json");
    this.cachePath = path.join(userDataDirectory, "tally-stores-cache.json");
  }

  async readSettings(): Promise<TallyConnectionSettings> {
    const saved = await readJson<Partial<TallyConnectionSettings>>(this.settingsPath);
    return { ...DEFAULT_SETTINGS, ...saved };
  }

  async saveSettings(settings: TallyConnectionSettings): Promise<void> {
    await writeJsonAtomic(this.settingsPath, settings);
  }

  async readCache(): Promise<TallyStoresSnapshot | null> {
    const cache = await readJson<TallyStoresSnapshot>(this.cachePath);
    return cache?.schemaVersion === 2 ? cache : null;
  }

  async saveCache(cache: TallyStoresSnapshot): Promise<void> {
    await writeJsonAtomic(this.cachePath, cache);
  }

  async getState(): Promise<TallyState> {
    const [settings, cache] = await Promise.all([
      this.readSettings(),
      this.readCache(),
    ]);
    return { settings, cache, cachePath: this.cachePath };
  }
}
