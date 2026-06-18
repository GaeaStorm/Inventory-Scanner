import path from "node:path";

import type { TallyStoresSnapshot } from "../tally/types";
import { createDemoStoresSnapshot } from "./demo-data";
import { StoresDatabase } from "./database";
import { StoresExporter } from "./exporter";
import type {
  BulkVendorReceiptInput,
  ConfirmImportInput,
  ExportBatchInput,
  MaterialOutInput,
  ReturnUnusedInput,
  ReviewDecisionInput,
  SaveBoxInput,
  VendorReceiptInput,
} from "./types";

export class StoresService {
  readonly database: StoresDatabase;
  readonly exporter: StoresExporter;

  constructor(userDataDirectory: string) {
    this.database = new StoresDatabase(userDataDirectory);
    this.exporter = new StoresExporter(
      this.database,
      path.join(userDataDirectory, "exports"),
    );
  }

  close(): void {
    this.database.close();
  }

  ensureDemoData(): ReturnType<StoresDatabase["getState"]> {
    const current = this.database.getState();
    if (current.stockItems.length > 0) return current;

    this.database.applyTallySnapshot(createDemoStoresSnapshot());
    this.database.setDataMode("demo");
    return this.database.getState();
  }

  sync(snapshot: TallyStoresSnapshot) {
    if (snapshot.stockItems.length === 0) {
      const demoState = this.ensureDemoData();
      return {
        ...demoState.sync,
        warnings: [
          ...demoState.sync.warnings,
          `Tally company ${snapshot.company || "(unnamed)"} returned no Stock Items, so the demo catalog was retained.`,
        ],
      };
    }

    if (this.database.getDataMode() === "demo") {
      this.database.resetDemoDataForTallySync();
    }
    const summary = this.database.applyTallySnapshot(snapshot);
    this.database.setDataMode("tally");
    return summary;
  }

  getState() {
    return this.database.getState();
  }

  getBox(boxId: string) {
    return this.database.getBox(boxId);
  }

  saveBox(input: SaveBoxInput) {
    return this.database.saveBox(input);
  }

  vendorReceipt(input: VendorReceiptInput) {
    return this.database.recordVendorReceipt(input);
  }

  bulkVendorReceipt(input: BulkVendorReceiptInput) {
    return this.database.recordBulkVendorReceipt(input);
  }

  materialOut(input: MaterialOutInput) {
    return this.database.recordMaterialOut(input);
  }

  returnUnused(input: ReturnUnusedInput) {
    return this.database.recordReturnUnused(input);
  }

  review(input: ReviewDecisionInput) {
    this.database.review(input);
    return this.getState();
  }

  confirmImport(input: ConfirmImportInput) {
    this.database.confirmImport(input);
    return this.getState();
  }

  exportBatch(input: ExportBatchInput) {
    return this.exporter.generate(input);
  }

  backup(label?: string) {
    return this.database.backup(label);
  }

  setBackupFolder(folder: string) {
    this.database.setBackupFolder(folder);
    return this.getState();
  }

  setExportFolder(folder: string) {
    this.database.setExportFolder(folder);
    return this.getState();
  }
}
