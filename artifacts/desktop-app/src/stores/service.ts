import path from "node:path";

import type { TallyStoresSnapshot } from "../tally/types";
import type { OperationsService } from "../operations/service";
import type { ActorContext, Permission } from "../operations/types";
import { requirePermission } from "../operations/permissions";
import { ApplicationDatabase, DatabaseBusyError } from "../database/application-database";
import { createDemoStoresSnapshot } from "./demo-data";
import { CatalogExporter } from "./catalog-exporter";
import { StoresDatabase } from "./database";
import { StoresExporter } from "./exporter";
import type {
  AdjustmentInput,
  BulkVendorReceiptInput,
  ConfirmImportInput,
  CreateCatalogGroupInput,
  CreateLocalStockItemInput,
  CreateStockCategoryInput,
  DeleteCatalogGroupInput,
  DeleteStockCategoryInput,
  DeleteStockItemInput,
  ExportBatchInput,
  MaterialOutInput,
  OpeningQuantityInput,
  RenameStockItemInput,
  ReviewDecisionInput,
  SaveBoxInput,
  SaveItemFieldDefinitionInput,
  SetCatalogRoleInput,
  SetCatalogStatusInput,
  SetGroupRoleInput,
  StoresOfflineBatchInput,
  StoresOfflineBatchResult,
  VendorReceiptInput,
} from "./types";

export class StoresService {
  readonly databaseHost: ApplicationDatabase;
  readonly database: StoresDatabase;
  readonly exporter: StoresExporter;
  readonly catalogExporter: CatalogExporter;
  private operations: OperationsService | null = null;

  constructor(userDataDirectory: string, databaseHost: ApplicationDatabase) {
    this.databaseHost = databaseHost;
    this.database = new StoresDatabase(userDataDirectory, this.databaseHost);
    this.exporter = new StoresExporter(
      this.database,
      path.join(userDataDirectory, "exports"),
    );
    this.catalogExporter = new CatalogExporter(
      this.database,
      path.join(userDataDirectory, "exports"),
    );
  }

  bindOperations(operations: OperationsService): void {
    this.operations = operations;
  }

  private authorize(actor: ActorContext, permission: Permission): ActorContext {
    return requirePermission(actor, permission);
  }

  private operationsService(): OperationsService {
    if (!this.operations) throw new Error("The inventory operations service is unavailable.");
    return this.operations;
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

  sync(snapshot: TallyStoresSnapshot, actor?: ActorContext) {
    if (actor) this.authorize(actor, "PURCHASING_MANAGE");
    if (snapshot.stockItems.length === 0) {
      this.database.rememberTallyCompany(snapshot);
      const currentState = this.database.getState();
      return {
        ...currentState.sync,
        warnings: [
          ...currentState.sync.warnings,
          `Tally company ${snapshot.company || "(unnamed)"} returned no Stock Items. The local master catalog was left unchanged so it can be imported into this company.`,
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

  createLocalStockItem(input: CreateLocalStockItemInput, actor: ActorContext) {
    this.authorize(actor, "CATALOG_MANAGE");
    this.database.createLocalStockItem(input);
    return this.getState();
  }

  saveItemFieldDefinition(input: SaveItemFieldDefinitionInput, actor: ActorContext) {
    this.authorize(actor, "CATALOG_MANAGE");
    this.database.saveItemFieldDefinition(input);
    return this.getState();
  }

  deleteItemFieldDefinition(fieldId: string, actor: ActorContext) {
    this.authorize(actor, "CATALOG_MANAGE");
    this.database.deleteItemFieldDefinition(fieldId);
    return this.getState();
  }

  reorderItemFieldDefinitions(orderedIds: string[], groupName: string, actor: ActorContext) {
    this.authorize(actor, "CATALOG_MANAGE");
    this.database.reorderItemFieldDefinitions(orderedIds, groupName);
    return this.getState();
  }

  createCatalogGroup(input: CreateCatalogGroupInput, actor: ActorContext) {
    this.authorize(actor, "CATALOG_MANAGE");
    this.database.createCatalogGroup(input);
    return this.getState();
  }

  deleteCatalogGroup(input: DeleteCatalogGroupInput, actor: ActorContext) {
    this.authorize(actor, "CATALOG_MANAGE");
    this.database.deleteCatalogGroup(input);
    return this.getState();
  }

  createStockCategory(input: CreateStockCategoryInput, actor: ActorContext) {
    this.authorize(actor, "CATALOG_MANAGE");
    this.database.createStockCategory(input);
    return this.getState();
  }

  deleteStockCategory(input: DeleteStockCategoryInput, actor: ActorContext) {
    this.authorize(actor, "CATALOG_MANAGE");
    this.database.deleteStockCategory(input);
    return this.getState();
  }

  deleteStockItem(input: DeleteStockItemInput, actor: ActorContext) {
    this.authorize(actor, "CATALOG_MANAGE");
    this.database.deleteStockItem(input);
    return this.getState();
  }

  setCatalogStatus(input: SetCatalogStatusInput, actor: ActorContext) {
    this.authorize(actor, "CATALOG_MANAGE");
    this.database.setCatalogStatus(input);
    return this.getState();
  }

  setGroupCatalogRole(input: SetGroupRoleInput, actor: ActorContext) {
    this.authorize(actor, "CATALOG_MANAGE");
    this.database.setGroupCatalogRole(input);
    return this.getState();
  }

  setCatalogRole(input: SetCatalogRoleInput, actor: ActorContext) {
    this.authorize(actor, "CATALOG_MANAGE");
    this.database.setCatalogRole(input);
    return this.getState();
  }

  renameStockItem(input: RenameStockItemInput, actor: ActorContext) {
    this.authorize(actor, "CATALOG_MANAGE");
    this.database.renameStockItem(input);
    return this.getState();
  }

  exportCatalogCleanup(actor: ActorContext) {
    if (!actor.permissions?.includes("CATALOG_MANAGE") && !actor.permissions?.includes("TALLY_REVIEW")) {
      throw new Error(`${actor.role} does not have permission to generate Tally master files.`);
    }
    return this.catalogExporter.generate();
  }

  getBox(boxId: string) {
    return this.database.getBox(boxId);
  }

  saveBox(input: SaveBoxInput, actor: ActorContext) {
    this.authorize(actor, "QR_MANAGE");
    return this.database.saveBox(input);
  }

  deleteBox(boxId: string, expectedRevision: number | undefined, actor: ActorContext) {
    this.authorize(actor, "QR_MANAGE");
    this.database.deleteBox(boxId, expectedRevision);
    return this.getState();
  }

  vendorReceipt(input: VendorReceiptInput, actor: ActorContext) {
    this.authorize(actor, "RECEIVE_MATERIAL");
    return this.databaseHost.transaction("recording a vendor receipt with condition detail", () => {
      const movement = this.database.runIdempotent(
        input.clientTransactionId,
        "VENDOR_RECEIPT",
        input,
        () => this.database.recordVendorReceipt(input),
      );
      this.operationsService().database.registerVendorReceipt(input, movement, actor);
      return movement;
    });
  }

  bulkVendorReceipt(input: BulkVendorReceiptInput, actor: ActorContext) {
    this.authorize(actor, "RECEIVE_MATERIAL");
    return this.databaseHost.transaction("recording a bulk vendor receipt with condition detail", () => {
      const result = this.database.runIdempotent(
        input.clientTransactionId,
        "BULK_VENDOR_RECEIPT",
        input,
        () => this.database.recordBulkVendorReceipt(input),
      );
      this.operationsService().database.registerBulkReceipt(input, result, actor);
      return result;
    });
  }

  materialOut(input: MaterialOutInput, actor: ActorContext) {
    this.authorize(actor, input.productOrderId ? "PRODUCTION_EXECUTE" : "MATERIAL_ISSUE");
    return this.databaseHost.transaction("recording Material Out with audit provenance", () => {
      const movement = this.database.runIdempotent(
        input.clientTransactionId,
        "MATERIAL_OUT",
        input,
        () => this.database.recordMaterialOut(input),
      );
      this.operationsService().database.registerMaterialOut(input, movement, actor);
      return movement;
    });
  }

  adjustment(input: AdjustmentInput, actor: ActorContext) {
    this.authorize(actor, input.direction === "RETURN_TO_STOCK" ? "PRODUCTION_RETURN" : "MATERIAL_ISSUE");
    return this.databaseHost.transaction("recording a new Material In or Material Out entry", () => {
      const movement = this.database.runIdempotent(
        input.clientTransactionId,
        "ADJUSTMENT",
        input,
        () => input.direction === "RETURN_TO_STOCK"
          ? this.database.recordMaterialInCorrection(input)
          : this.database.recordMaterialOut({
            clientTransactionId: input.clientTransactionId,
            boxId: input.boxId,
            tallyItemGuid: input.tallyItemGuid,
            purpose: "CUSTOMER_EXTRAS",
            destinationTallyItemGuid: input.destinationTallyItemGuid,
            quantity: input.quantity,
            eventDate: input.eventDate,
            productOrderId: input.productOrderId,
            notes: input.note,
            serialNumbers: input.serialNumbers,
          }),
      );
      this.operationsService().database.registerAdjustment(input, movement, actor);
      return movement;
    });
  }

  setOpeningQuantity(input: OpeningQuantityInput, actor: ActorContext) {
    this.authorize(actor, "STOCK_ADJUST");
    return this.databaseHost.transaction("recording an opening-stock correction with audit provenance", () => {
      const adjustment = this.database.setOpeningQuantity({ ...input, adjustedBy: actor.displayName });
      this.operationsService().database.registerOpeningAdjustment(input, adjustment, actor);
      return this.getState();
    });
  }

  processOfflineBatch(input: StoresOfflineBatchInput, actor: ActorContext): StoresOfflineBatchResult {
    this.authorize(actor, "MATERIAL_ISSUE");
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
          ? this.materialOut(operation.payload, actor)
          : this.adjustment(operation.payload, actor);
        results.push({ clientTransactionId: stableId, status: "ACCEPTED", movement });
      } catch (error) {
        const stableId = String(operation.clientTransactionId ?? "");
        const reason = error instanceof Error ? error.message : String(error);
        let exceptionId: string | undefined;
        if (!(error instanceof DatabaseBusyError)) {
          const payload = operation.payload as MaterialOutInput | AdjustmentInput;
          const exception = this.operationsService().recordSyncException({
            clientTransactionId: stableId,
            deviceId: actor.userId,
            operator: actor.displayName,
            localTimestamp: String(input.localTimestamp ?? ""),
            operationType: operation.type,
            tallyItemGuid: payload.tallyItemGuid,
            requestedQuantity: payload.quantity,
            productOrderId: payload.productOrderId,
            reason,
            payload: operation.payload as unknown as Record<string, unknown>,
          });
          exceptionId = exception.id;
        }
        results.push({
          clientTransactionId: stableId,
          status: error instanceof DatabaseBusyError ? "RETRY" : "REJECTED",
          error: reason,
          exceptionId,
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

  review(input: ReviewDecisionInput, actor: ActorContext) {
    this.authorize(actor, "TALLY_REVIEW");
    this.database.review({ ...input, reviewedBy: actor.displayName });
    return this.getState();
  }

  confirmImport(input: ConfirmImportInput, actor: ActorContext) {
    this.authorize(actor, "TALLY_REVIEW");
    this.database.confirmImport({ ...input, recordedBy: actor.displayName });
    return this.getState();
  }

  exportBatch(input: ExportBatchInput, actor: ActorContext) {
    this.authorize(actor, "TALLY_REVIEW");
    return this.exporter.generate({ ...input, reviewedBy: actor.displayName });
  }

  backup(label?: string, actor?: ActorContext) {
    if (actor) this.authorize(actor, "SETTINGS_MANAGE");
    return this.database.backup(label);
  }

  listBackups() {
    return this.database.listBackups();
  }

  restoreBackup(backupPath: string, actor: ActorContext) {
    this.authorize(actor, "SETTINGS_MANAGE");
    return this.database.restoreBackup(backupPath);
  }

  setBackupFolder(folder: string, actor: ActorContext) {
    this.authorize(actor, "SETTINGS_MANAGE");
    this.database.setBackupFolder(folder);
    return this.getState();
  }

  setExportFolder(folder: string, actor: ActorContext) {
    this.authorize(actor, "SETTINGS_MANAGE");
    this.database.setExportFolder(folder);
    return this.getState();
  }
}
