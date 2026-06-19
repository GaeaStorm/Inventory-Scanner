import path from "node:path";

import type { TallyStoresSnapshot } from "../tally/types";
import { ApplicationDatabase, DatabaseBusyError } from "../database/application-database";
import { createDemoStoresSnapshot } from "./demo-data";
import { StoresDatabase } from "./database";
import { StoresExporter } from "./exporter";
import type {
  AdjustmentInput,
  BulkVendorReceiptInput,
  ConfirmImportInput,
  CreateLocalStockItemInput,
  ExportBatchInput,
  MaterialOutInput,
  OpeningQuantityInput,
  ReviewDecisionInput,
  SaveBoxInput,
  StoresOfflineBatchInput,
  StoresOfflineBatchResult,
  VendorReceiptInput,
} from "./types";

export class StoresService {
  readonly databaseHost: ApplicationDatabase;
  readonly database: StoresDatabase;
  readonly exporter: StoresExporter;

  constructor(userDataDirectory: string, databaseHost: ApplicationDatabase) {
    this.databaseHost = databaseHost;
    this.database = new StoresDatabase(userDataDirectory, this.databaseHost);
    this.exporter = new StoresExporter(
      this.database,
      path.join(userDataDirectory, "exports"),
    );
  }

  close(): void {
    // The Electron composition root owns the shared ApplicationDatabase.
    // A future ProductionService will receive the same host.
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

  createLocalStockItem(input: CreateLocalStockItemInput) {
    this.database.createLocalStockItem(input);
    return this.getState();
  }

  getBox(boxId: string) {
    return this.database.getBox(boxId);
  }

  saveBox(input: SaveBoxInput) {
    return this.database.saveBox(input);
  }

  deleteBox(boxId: string, expectedRevision?: number) {
    this.database.deleteBox(boxId, expectedRevision);
    return this.getState();
  }

  vendorReceipt(input: VendorReceiptInput) {
    return this.database.runIdempotent(
      input.clientTransactionId,
      "VENDOR_RECEIPT",
      input,
      () => this.database.recordVendorReceipt(input),
    );
  }

  bulkVendorReceipt(input: BulkVendorReceiptInput) {
    return this.database.runIdempotent(
      input.clientTransactionId,
      "BULK_VENDOR_RECEIPT",
      input,
      () => this.database.recordBulkVendorReceipt(input),
    );
  }

  materialOut(input: MaterialOutInput) {
    return this.database.runIdempotent(
      input.clientTransactionId,
      "MATERIAL_OUT",
      input,
      () => this.database.recordMaterialOut(input),
    );
  }

  adjustment(input: AdjustmentInput) {
    return this.database.runIdempotent(
      input.clientTransactionId,
      "ADJUSTMENT",
      input,
      () => this.database.recordAdjustment(input),
    );
  }


  setOpeningQuantity(input: OpeningQuantityInput) {
    this.database.setOpeningQuantity(input);
    return this.getState();
  }

  processOfflineBatch(input: StoresOfflineBatchInput): StoresOfflineBatchResult {
    const operations = Array.isArray(input.operations) ? input.operations : [];
    if (operations.length === 0) {
      return { receivedAt: new Date().toISOString(), results: [] };
    }
    if (operations.length > 500) {
      throw new Error("An offline synchronization batch can contain at most 500 operations.");
    }

    const results: StoresOfflineBatchResult["results"] = [];
    for (const operation of operations) {
      try {
        const stableId = String(operation.clientTransactionId ?? "").trim();
        if (!stableId || stableId !== operation.payload.clientTransactionId) {
          throw new Error("The queued operation and payload must use the same stable transaction ID.");
        }
        const movement = operation.type === "MATERIAL_OUT"
          ? this.materialOut(operation.payload)
          : this.adjustment(operation.payload);
        results.push({ clientTransactionId: stableId, status: "ACCEPTED", movement });
      } catch (error) {
        results.push({
          clientTransactionId: String(operation.clientTransactionId ?? ""),
          status: error instanceof DatabaseBusyError ? "RETRY" : "REJECTED",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { receivedAt: new Date().toISOString(), results };
  }

  adjustmentContext(
    tallyItemGuid: string,
    destinationTallyItemGuid: string,
    eventDate?: string,
  ) {
    return this.database.getAdjustmentContext(
      tallyItemGuid,
      destinationTallyItemGuid,
      eventDate,
    );
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

  listBackups() {
    return this.database.listBackups();
  }

  restoreBackup(backupPath: string) {
    return this.database.restoreBackup(backupPath);
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
