import { TallyClient, normalizeTallySettings } from "./client";
import { TallyStorage } from "./storage";
import type {
  TallyConnectionResult,
  TallyState,
  TallyStoresSnapshot,
} from "./types";

export class TallyService {
  readonly storage: TallyStorage;
  readonly client = new TallyClient();

  constructor(userDataDirectory: string) {
    this.storage = new TallyStorage(userDataDirectory);
  }

  get cachePath(): string {
    return this.storage.cachePath;
  }

  getState(): Promise<TallyState> {
    return this.storage.getState();
  }

  async testConnection(value: unknown): Promise<TallyConnectionResult> {
    const result = await this.client.testConnection(value);
    await this.storage.saveSettings(result.settings);
    return result;
  }

  async syncStores(value: unknown): Promise<TallyStoresSnapshot> {
    const settings = normalizeTallySettings(value);
    const snapshot = await this.client.syncStores(settings);
    const savedSettings = { ...settings, company: snapshot.company };
    await Promise.all([
      this.storage.saveSettings(savedSettings),
      this.storage.saveCache(snapshot),
    ]);
    return snapshot;
  }
}
