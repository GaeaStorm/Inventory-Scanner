import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as XLSX from "xlsx";

import { ApplicationDatabase } from "../src/database/application-database";
import { OperationsDatabase } from "../src/operations/database";
import { permissionsForRole, requirePermission, resolveActorPermissions } from "../src/operations/permissions";
import type { ActorContext, ConditionBalance } from "../src/operations/types";
import { PlanningDatabase, warrantyStatusForSerial } from "../src/planning/database";
import { buildCrfHtml } from "../src/planning/crf-document";
import { traceabilityColumns } from "../src/renderer/traceability";
import { parseBomWorkbook } from "../src/renderer/bom-import";
import { retainedBackupPaths, StoresDatabase } from "../src/stores/database";
import { CatalogExporter } from "../src/stores/catalog-exporter";
import type { BulkVendorReceiptInput } from "../src/stores/types";

interface Context {
  directory: string;
  host: ApplicationDatabase;
  stores: StoresDatabase;
  planning: PlanningDatabase;
  operations: OperationsDatabase;
  actor: ActorContext;
  supplierId: number;
  componentGuid: string;
  productGuid: string;
}

function createContext(): Context {
  const directory = mkdtempSync(path.join(tmpdir(), "inventory-operations-"));
  const host = new ApplicationDatabase(StoresDatabase.databasePathFor(directory));
  const stores = new StoresDatabase(directory, host);
  const planning = new PlanningDatabase(host);
  const operations = new OperationsDatabase(host);
  const session = operations.bootstrapAdmin({
    displayName: "Test Administrator",
    username: "administrator",
    email: "administrator@example.com",
    credential: "correct-horse-battery-staple",
  });
  const actor = operations.actorForToken(session.token);
  assert.ok(actor);
  const component = stores.createLocalStockItem({ name: "Test Component", parentName: "COMPONENTS" });
  const product = stores.createLocalStockItem({ name: "Test Product", parentName: "MANUFACTURED PRODUCTS" });
  host.db.prepare("UPDATE tally_stock_items SET has_bom = 1 WHERE tally_guid = ?").run(product.tallyGuid);
  const supplierId = Number(host.db.prepare(
    "INSERT INTO suppliers(tally_guid, name, synced_at) VALUES (?, ?, ?)",
  ).run("SUPPLIER:TEST", "Test Supplier", new Date().toISOString()).lastInsertRowid);
  return {
    directory,
    host,
    stores,
    planning,
    operations,
    actor,
    supplierId,
    componentGuid: component.tallyGuid,
    productGuid: product.tallyGuid,
  };
}

function closeContext(context: Context): void {
  context.host.close();
  rmSync(context.directory, { recursive: true, force: true });
}

function receive(
  context: Context,
  id: string,
  values: Partial<BulkVendorReceiptInput["lines"][number]> = {},
): ReturnType<StoresDatabase["recordBulkVendorReceipt"]> {
  const quantity = values.quantity ?? 10;
  const input: BulkVendorReceiptInput = {
    clientTransactionId: id,
    supplierId: context.supplierId,
    challanNumber: `CH-${id}`,
    challanDate: "2026-06-19",
    receiptDate: "2026-06-19",
    nonPoException: true,
    lines: [{
      tallyItemGuid: context.componentGuid,
      quantity,
      ...values,
    }],
  };
  const result = context.stores.recordBulkVendorReceipt(input);
  context.operations.registerBulkReceipt(input, result, context.actor);
  return result;
}

function balance(context: Context, condition: "AVAILABLE" | "PENDING_INSPECTION" | "FAULTY"): ConditionBalance {
  const row = context.operations.getState().balances.find((entry) => entry.tallyItemGuid === context.componentGuid && entry.condition === condition);
  assert.ok(row, `Expected a ${condition} balance`);
  return row;
}

test("backup retention keeps today and only the newest backup from yesterday", () => {
  const now = new Date(2026, 5, 20, 12, 0, 0);
  const at = (day: number, hour: number) => new Date(2026, 5, day, hour, 0, 0).getTime();
  const retained = retainedBackupPaths([
    { path: "today-morning", mtime: at(20, 8) },
    { path: "today-noon", mtime: at(20, 12) },
    { path: "yesterday-morning", mtime: at(19, 8) },
    { path: "yesterday-evening", mtime: at(19, 18) },
    { path: "older", mtime: at(18, 18) },
  ], now);
  assert.deepEqual(
    [...retained].sort(),
    ["today-morning", "today-noon", "yesterday-evening"].sort(),
  );
});

test("scheduled backup is created only when the newest snapshot is due", () => {
  const context = createContext();
  try {
    const created = context.stores.backupIfDue(2 * 60 * 60 * 1000);
    assert.ok(created);
    assert.equal(context.stores.backupIfDue(2 * 60 * 60 * 1000), null);
  } finally {
    closeContext(context);
  }
});

test("production BOM parser detects product/version and uses component type for matching", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["BEL-ADA_VER 19.0_BOM"],
    ["TOTAL BOM"],
    [],
    ["Sr.No.", "Component", "Qty.", "Designation", "TYPE"],
    ["1", "1.5K ¼W ± 1%_1206", "2", "R86,R87", "SMD"],
    ["2", "POWER CORD", "1", "", ""],
  ]), "TOTAL BOM");
  const items = [
    { tallyGuid: "PRODUCT", name: "BEL-ADA", tallyName: "BEL-ADA" },
    { tallyGuid: "RESISTOR", name: "1.5K ¼W ± 1%_1206 SMD", tallyName: "1.5K ¼W ± 1%_1206 SMD" },
    { tallyGuid: "CORD", name: "POWER CORD", tallyName: "POWER CORD" },
  ] as any;
  const parsed = parseBomWorkbook(workbook, items, "BEL-ADA_VER 19.0_BOM.xls");
  assert.equal(parsed.productName, "BEL-ADA");
  assert.equal(parsed.versionNumber, 19);
  assert.equal(parsed.rows[0].componentGuid, "RESISTOR");
  assert.equal(parsed.rows[1].componentGuid, "CORD");
});

test("catalog group visibility drives planning while products are derived from BOM evidence", () => {
  const context = createContext();
  try {
    context.stores.createCatalogGroup({ name: "COMPONENTS" });
    context.stores.createCatalogGroup({ name: "RESISTORS", parentName: "COMPONENTS" });
    context.host.db.prepare(
      "UPDATE tally_stock_items SET parent_name = 'RESISTORS' WHERE tally_guid = ?",
    ).run(context.componentGuid);
    let state = context.stores.getState();
    assert.equal(state.stockItems.find((item) => item.tallyGuid === context.productGuid)?.isProduct, true);
    assert.equal(state.stockItems.find((item) => item.tallyGuid === context.componentGuid)?.isProduct, false);
    assert.equal(state.stockItems.find((item) => item.tallyGuid === context.componentGuid)?.primaryGroupName, "COMPONENTS");
    assert.equal(state.stockItems.find((item) => item.tallyGuid === context.componentGuid)?.secondaryGroupName, "RESISTORS");
    assert.ok(state.catalogGroups.some((group) => group.name === "COMPONENTS" && group.type === "PRIMARY"));
    assert.ok(state.catalogGroups.some((group) => group.name === "RESISTORS" && group.type === "SECONDARY" && group.primaryName === "COMPONENTS"));

    context.stores.setGroupCatalogRole({ groupName: "COMPONENTS", role: "IGNORED" });
    state = context.stores.getState();
    assert.equal(state.stockItems.find((item) => item.tallyGuid === context.componentGuid)?.ignored, true);
    assert.equal(context.planning.getState().items.some((item) => item.tallyItemGuid === context.componentGuid), false);
  } finally {
    closeContext(context);
  }
});

test("a manual catalog role designation overrides automatic isProduct detection, in both directions", () => {
  const context = createContext();
  try {
    let state = context.stores.getState();
    assert.equal(state.stockItems.find((item) => item.tallyGuid === context.componentGuid)?.isProduct, false);
    assert.equal(state.stockItems.find((item) => item.tallyGuid === context.productGuid)?.isProduct, true);

    // A brand-new product has no BOM yet, so automatic detection alone can
    // never mark it isProduct — the manual override is the only way in.
    context.stores.setCatalogRole({ tallyItemGuid: context.componentGuid, role: "PRODUCT" });
    state = context.stores.getState();
    const overriddenComponent = state.stockItems.find((item) => item.tallyGuid === context.componentGuid);
    assert.equal(overriddenComponent?.isProduct, true);
    assert.equal(overriddenComponent?.catalogRoleOverride, "PRODUCT");

    // The reverse: explicitly marking something that already has a BOM as
    // "Neither" must suppress automatic detection too (a hard override).
    context.stores.setCatalogRole({ tallyItemGuid: context.productGuid, role: "NEITHER" });
    state = context.stores.getState();
    assert.equal(state.stockItems.find((item) => item.tallyGuid === context.productGuid)?.isProduct, false);

    // Clearing the override falls back to automatic detection again.
    context.stores.setCatalogRole({ tallyItemGuid: context.productGuid, role: null });
    state = context.stores.getState();
    const restoredProduct = state.stockItems.find((item) => item.tallyGuid === context.productGuid);
    assert.equal(restoredProduct?.isProduct, true);
    assert.equal(restoredProduct?.catalogRoleOverride, null);
  } finally {
    closeContext(context);
  }
});

test("a group-level designation cascades to its items, the nearest explicit ancestor wins, and an item override beats both", () => {
  const context = createContext();
  try {
    context.stores.createCatalogGroup({ name: "Service" });
    context.stores.createCatalogGroup({ name: "Repairs", parentName: "Service" });
    const repairItem = context.stores.createLocalStockItem({ name: "Repair Visit", parentName: "Repairs" });

    // Designating the whole "Service" group cascades down to "Repairs" too,
    // since neither has been touched yet — the nearest explicit ancestor.
    context.stores.setGroupCatalogRole({ groupName: "Service", role: "SERVICE" });
    let state = context.stores.getState();
    let repair = state.stockItems.find((item) => item.tallyGuid === repairItem.tallyGuid);
    assert.equal(repair?.isService, true);
    assert.equal(state.catalogGroups.find((group) => group.name === "Repairs")?.effectiveCatalogRole, "SERVICE");

    // Explicitly marking the more specific subgroup "Neither" overrides the
    // ancestor's "Service" designation for everything under it.
    context.stores.setGroupCatalogRole({ groupName: "Repairs", role: "NEITHER" });
    state = context.stores.getState();
    repair = state.stockItems.find((item) => item.tallyGuid === repairItem.tallyGuid);
    assert.equal(repair?.isService, false);
    assert.equal(state.catalogGroups.find((group) => group.name === "Service")?.effectiveCatalogRole, "SERVICE");

    // An item's own override beats its group either way.
    context.stores.setCatalogRole({ tallyItemGuid: repairItem.tallyGuid, role: "PRODUCT" });
    state = context.stores.getState();
    repair = state.stockItems.find((item) => item.tallyGuid === repairItem.tallyGuid);
    assert.equal(repair?.isProduct, true);
    assert.equal(repair?.isService, false);
  } finally {
    closeContext(context);
  }
});

test("local-first catalog builds nested groups and categories and exports complete Tally masters", () => {
  const context = createContext();
  try {
    context.stores.createCatalogGroup({ name: "Raw Material" });
    context.stores.createCatalogGroup({ name: "ICs", parentName: "Raw Material" });
    context.stores.createCatalogGroup({ name: "Import", parentName: "ICs" });
    context.stores.createStockCategory({ name: "SMD" });
    context.stores.createStockCategory({ name: "Fine Pitch", parentName: "SMD" });
    const item = context.stores.createLocalStockItem({
      name: "Test Imported IC",
      parentName: "Import",
      categoryName: "Fine Pitch",
      baseUnits: "Nos",
    });

    let state = context.stores.getState();
    const saved = state.stockItems.find((entry) => entry.tallyGuid === item.tallyGuid);
    assert.deepEqual(saved?.groupPath, ["Raw Material", "ICs", "Import"]);
    assert.equal(saved?.primaryGroupName, "Raw Material");
    assert.equal(saved?.secondaryGroupName, "ICs");
    assert.equal(saved?.categoryName, "Fine Pitch");

    assert.equal(state.dataMode, "local");
    assert.deepEqual(
      state.stockCategories.find((entry) => entry.name === "Fine Pitch")?.path,
      ["SMD", "Fine Pitch"],
    );

    context.stores.rememberTallyCompany({
      company: "Fresh Inventory Company",
      companyGuid: "COMPANY:FRESH",
      syncedAt: new Date().toISOString(),
    });
    const result = new CatalogExporter(context.stores, path.join(context.directory, "exports")).generate();
    const workbook = XLSX.readFile(result.workbookPath);
    assert.ok(workbook.SheetNames.includes("Stock Groups"));
    assert.ok(workbook.SheetNames.includes("Stock Categories"));
    assert.ok(workbook.SheetNames.includes("Stock Items"));
    assert.ok(result.renameXmlPath);
    const masterXml = readFileSync(result.renameXmlPath, "utf8");
    assert.match(masterXml, /<SVCURRENTCOMPANY>Fresh Inventory Company<\/SVCURRENTCOMPANY>/);
    assert.ok(masterXml.indexOf('STOCKGROUP NAME="Raw Material"') < masterXml.indexOf('STOCKGROUP NAME="ICs"'));
    assert.ok(masterXml.indexOf('STOCKGROUP NAME="ICs"') < masterXml.indexOf('STOCKGROUP NAME="Import"'));
    assert.ok(masterXml.indexOf('STOCKCATEGORY NAME="Fine Pitch"') < masterXml.indexOf('STOCKITEM NAME="Test Imported IC"'));
    assert.match(masterXml, /<CATEGORY>Fine Pitch<\/CATEGORY>/);

    assert.throws(
      () => context.stores.deleteCatalogGroup({ name: "Import" }),
      /Move or delete Stock Item/,
    );
    context.stores.deleteStockItem({ tallyItemGuid: item.tallyGuid });
    context.stores.deleteCatalogGroup({ name: "Import" });
    context.stores.deleteStockCategory({ name: "Fine Pitch" });
    state = context.stores.getState();
    assert.equal(state.stockItems.some((entry) => entry.tallyGuid === item.tallyGuid), false);
    assert.equal(state.catalogGroups.some((entry) => entry.name === "Import"), false);
  } finally {
    closeContext(context);
  }
});

test("duplicate item names are distinguished by Stock Group and movements snapshot the qualified name", () => {
  const context = createContext();
  try {
    context.stores.createCatalogGroup({ name: "Raw Material" });
    context.stores.createCatalogGroup({ name: "SMD", parentName: "Raw Material" });
    context.stores.createCatalogGroup({ name: "Non-SMD", parentName: "Raw Material" });
    const smdItem = context.stores.createLocalStockItem({ name: "ABCDE", parentName: "SMD" });
    const nonSmdItem = context.stores.createLocalStockItem({ name: "ABCDE", parentName: "Non-SMD" });

    assert.notEqual(smdItem.tallyGuid, nonSmdItem.tallyGuid);
    const state = context.stores.getState();
    const savedSmd = state.stockItems.find((entry) => entry.tallyGuid === smdItem.tallyGuid);
    const savedNonSmd = state.stockItems.find((entry) => entry.tallyGuid === nonSmdItem.tallyGuid);
    assert.equal(savedSmd?.qualifiedName, "Raw Material > SMD > ABCDE");
    assert.equal(savedNonSmd?.qualifiedName, "Raw Material > Non-SMD > ABCDE");
    assert.equal(state.qualifiedNameCollisions.length, 0);

    context.stores.recordBulkVendorReceipt({
      clientTransactionId: "dup-name-receipt",
      supplierId: context.supplierId,
      challanNumber: "CH-DUP",
      challanDate: "2026-06-19",
      receiptDate: "2026-06-19",
      nonPoException: true,
      lines: [{ tallyItemGuid: smdItem.tallyGuid, quantity: 4 }],
    });
    const movementRow = context.host.db.prepare(`
      SELECT item_name_snapshot, item_qualified_name_snapshot, item_group_path_snapshot
      FROM inventory_movements WHERE stock_item_id = ?
    `).get(smdItem.id) as { item_name_snapshot: string; item_qualified_name_snapshot: string; item_group_path_snapshot: string };
    assert.equal(movementRow.item_name_snapshot, "ABCDE");
    assert.equal(movementRow.item_qualified_name_snapshot, "Raw Material > SMD > ABCDE");
    assert.deepEqual(JSON.parse(movementRow.item_group_path_snapshot), ["Raw Material", "SMD"]);
  } finally {
    closeContext(context);
  }
});

test("item specification fields generate a unique Tally name while keeping a duplicate-friendly display name, and can be reordered/deleted", () => {
  const context = createContext();
  try {
    context.stores.createCatalogGroup({ name: "Switches" });
    const pinCount = context.stores.saveItemFieldDefinition({ label: "Pin count", required: true });
    const color = context.stores.saveItemFieldDefinition({ label: "Color", required: false });
    assert.deepEqual(context.stores.listItemFieldDefinitions().map((field) => field.label), ["Pin count", "Color"]);

    assert.throws(
      () => context.stores.createLocalStockItem({ name: "Item010", parentName: "Switches", fieldValues: { color: "Red" } }),
      /Pin count/,
      "a required field left blank must be rejected",
    );

    const red = context.stores.createLocalStockItem({
      name: "Item010", parentName: "Switches", fieldValues: { [pinCount.key]: "6 pin", [color.key]: "Red" },
    });
    assert.equal(red.tallyName, "Switches_6pin_Red_Item010");
    assert.equal(red.name, "Item010", "display name stays the human label, not the generated name");

    // A blank optional field contributes a literal "X", and the same display
    // name + group with a different field combination is a distinct item.
    const noColor = context.stores.createLocalStockItem({
      name: "Item010", parentName: "Switches", fieldValues: { [pinCount.key]: "6 pin" },
    });
    assert.notEqual(noColor.tallyGuid, red.tallyGuid);
    assert.equal(noColor.tallyName, "Switches_6pin_X_Item010");
    assert.equal(noColor.name, "Item010");

    const state = context.stores.getState();
    const redFromState = state.stockItems.find((entry) => entry.tallyGuid === red.tallyGuid);
    assert.deepEqual(redFromState?.fieldValues, { [pinCount.key]: "6 pin", [color.key]: "Red" });

    // Reorder: Color before Pin count.
    context.stores.reorderItemFieldDefinitions([color.id, pinCount.id]);
    assert.deepEqual(context.stores.listItemFieldDefinitions().map((field) => field.label), ["Color", "Pin count"]);
    const reorderedItem = context.stores.createLocalStockItem({
      name: "Item011", parentName: "Switches", fieldValues: { [pinCount.key]: "4 pin", [color.key]: "Blue" },
    });
    assert.equal(reorderedItem.tallyName, "Switches_Blue_4pin_Item011", "generated name follows the new field order");

    context.stores.deleteItemFieldDefinition(color.id);
    assert.deepEqual(context.stores.listItemFieldDefinitions().map((field) => field.label), ["Pin count"]);

    // A freshly created item's own field-value rows must never count as a
    // blocking reference — they're descriptive metadata, not a real record.
    context.stores.deleteStockItem({ tallyItemGuid: red.tallyGuid });
    assert.ok(!context.stores.getState().stockItems.some((entry) => entry.tallyGuid === red.tallyGuid));
  } finally {
    closeContext(context);
  }
});

test("a local Stock Item with no movements or other references can be deleted from the catalog", () => {
  const context = createContext();
  try {
    context.stores.createCatalogGroup({ name: "Scratch" });
    const item = context.stores.createLocalStockItem({ name: "Throwaway", parentName: "Scratch" });
    assert.ok(context.stores.getState().stockItems.some((entry) => entry.tallyGuid === item.tallyGuid));
    context.stores.deleteStockItem({ tallyItemGuid: item.tallyGuid });
    assert.ok(!context.stores.getState().stockItems.some((entry) => entry.tallyGuid === item.tallyGuid));

    const referenced = context.stores.createLocalStockItem({ name: "InUse", parentName: "Scratch" });
    context.stores.recordBulkVendorReceipt({
      clientTransactionId: "delete-guard-receipt",
      supplierId: context.supplierId,
      challanNumber: "CH-DELETE-GUARD",
      challanDate: "2026-06-19",
      receiptDate: "2026-06-19",
      nonPoException: true,
      lines: [{ tallyItemGuid: referenced.tallyGuid, quantity: 1 }],
    });
    assert.throws(() => context.stores.deleteStockItem({ tallyItemGuid: referenced.tallyGuid }), /referenced|cannot|in use/i);
  } finally {
    closeContext(context);
  }
});

test("catalog group creation accepts implicit parent names from stock item assignments", () => {
  const context = createContext();
  try {
    const item = context.stores.createLocalStockItem({ name: "Implicit Parent Item", parentName: "POT" });
    context.host.db.prepare("DELETE FROM tally_stock_groups WHERE name = ?").run("POT");
    context.stores.createCatalogGroup({ name: "Helical Pot", parentName: "POT" });

    const state = context.stores.getState();
    assert.ok(state.catalogGroups.some((group) => group.name === "POT"));
    assert.ok(state.catalogGroups.some((group) => group.name === "Helical Pot" && group.parentName.toLocaleLowerCase() === "pot"));
    const saved = state.stockItems.find((entry) => entry.tallyGuid === item.tallyGuid);
    assert.deepEqual(saved?.groupPath, ["POT"]);
  } finally {
    closeContext(context);
  }
});

test("credential recovery uses one-time codes and paired phones have revocable identities", () => {
  const context = createContext();
  try {
    assert.equal(context.operations.createRecoveryChallenge({
      username: "administrator",
      email: "wrong@example.com",
    }), null);
    const challenge = context.operations.createRecoveryChallenge({
      username: "administrator",
      email: "administrator@example.com",
    });
    assert.ok(challenge);
    assert.throws(() => context.operations.confirmRecovery({
      username: "administrator",
      email: "administrator@example.com",
      code: "000000",
      credential: "replacement-password",
      credentialType: "PASSWORD",
    }), /invalid or expired/);
    assert.equal(Number((context.host.db.prepare(
      "SELECT attempts FROM ops_recovery_challenges WHERE consumed_at IS NULL",
    ).get() as { attempts: number }).attempts), 1);
    context.operations.confirmRecovery({
      username: "administrator",
      email: "administrator@example.com",
      code: challenge.code,
      credential: "replacement-password",
      credentialType: "PASSWORD",
    });
    const session = context.operations.login({
      username: "administrator",
      credential: "replacement-password",
      deviceLabel: "Test desktop",
    });
    assert.equal(session.user.username, "administrator");
    assert.equal(session.user.email, "administrator@example.com");
    const pairing = context.operations.createScannerPairing("Stores phone 1", context.actor);
    const claimed = context.operations.claimScannerPairing(pairing.pairingToken, "Stores phone 1");
    const phone = context.operations.scannerActor(claimed.deviceToken);
    assert.equal(phone?.displayName, "Stores phone 1");
    assert.equal(phone?.role, "STORE");
    assert.equal(context.operations.listUsers().some((user) => user.userId === phone?.userId), false);
    context.operations.revokeScannerDevice(claimed.device.id, context.actor);
    assert.equal(context.operations.scannerActor(claimed.deviceToken), null);
  } finally {
    closeContext(context);
  }
});

test("production-order tracker persists canonical stages, stage history, spreadsheet fields, and custom fields", () => {
  const context = createContext();
  try {
    const product = context.stores.getState().stockItems.find((item) => item.isProduct)
      ?? context.stores.getState().stockItems[0];
    assert.ok(product);
    const field = context.planning.saveProductOrderFieldDefinition({ label: "Customer contact", type: "TEXT" });
    const saved = context.planning.saveProductOrder({
      externalReference: "PO-KANBAN-1",
      organisation: "Akademika Test Customer",
      fileNumber: "42",
      purchaseOrderDate: "2026-06-20",
      lastDispatchDate: "2026-07-10",
      productTallyGuid: product.tallyGuid,
      quantity: 3,
      pendingQuantity: 2,
      valueIncludingGst: 118000,
      crfStatus: "Sent",
      cracStatus: "Pending",
      taskRemarks: "Inventory check pending",
      responsiblePerson: "Snehal Sawant",
      workflowStateId: "initial-testing",
      customFields: { [field.key]: "A. Customer" },
    });
    assert.equal(saved.organisation, "Akademika Test Customer");
    assert.equal(saved.workflowStateName, "Initial Testing");
    assert.equal(saved.stageHistory.length, 1);
    assert.equal(saved.pendingQuantity, 2);
    assert.equal(saved.valueIncludingGst, 118000);
    assert.equal(saved.customFields[field.key], "A. Customer");
    context.planning.updateProductOrderWorkflowState(saved.id, "material-purchase");
    context.planning.updateProductOrderWorkflowState(saved.id, "quality-control");
    const advanced = context.planning.getState().productOrders.find((order) => order.id === saved.id);
    assert.equal(advanced?.workflowStateName, "Quality Control");
    assert.equal(advanced?.stageHistory.length, 3);
  } finally {
    closeContext(context);
  }
});

test("Production orders, Sales Orders, and fulfilment lines can go on hold or be cancelled without any stage-history time tracking", () => {
  const context = createContext();
  try {
    const product = context.stores.getState().stockItems.find((item) => item.isProduct)
      ?? context.stores.getState().stockItems[0];
    const order = context.planning.saveProductOrder({
      externalReference: "PO-HOLD-1",
      productTallyGuid: product.tallyGuid,
      quantity: 1,
      workflowStateId: "po-pending",
    });
    const stageHistoryBeforeHold = context.planning.getState().productOrders.find((entry) => entry.id === order.id)!.stageHistory.length;
    context.planning.updateProductOrderStatus(order.id, "ON_HOLD");
    const onHold = context.planning.getState().productOrders.find((entry) => entry.id === order.id)!;
    assert.equal(onHold.status, "ON_HOLD");
    assert.equal(onHold.stageHistory.length, stageHistoryBeforeHold, "putting an order on hold must not write a stage-history row");
    context.planning.updateProductOrderStatus(order.id, "CONFIRMED");
    const resumed = context.planning.getState().productOrders.find((entry) => entry.id === order.id)!;
    assert.equal(resumed.status, "CONFIRMED");

    const importResult = context.planning.importTallySalesOrderAggregates([{
      guid: "TALLY-SO-HOLD-1",
      voucherNumber: "SO-HOLD-1",
      voucherDate: "2026-06-24",
      customerName: "Hold Test Customer",
      reference: "CUSTOMER-PO-HOLD-1",
      lines: [{ itemName: "Test Product", itemGuid: context.productGuid, quantity: 1, rate: 100, value: 100, orderNumber: "", trackingNumber: "" }],
    }], context.actor);
    assert.equal(importResult.imported, 1, JSON.stringify(importResult));
    const allSalesOrders = context.planning.getState().salesOrders;
    const salesOrder = allSalesOrders.find((entry) => entry.tallyVoucherGuid === "TALLY-SO-HOLD-1");
    assert.ok(salesOrder, `expected to find TALLY-SO-HOLD-1 among: ${JSON.stringify(allSalesOrders.map((o) => o.tallyVoucherGuid))}`);
    assert.equal(salesOrder.holdStatus, "NONE");
    const heldOrder = context.planning.setSalesOrderHoldStatus(salesOrder.id, "ON_HOLD");
    assert.equal(heldOrder.holdStatus, "ON_HOLD");
    assert.equal(heldOrder.orderStage, salesOrder.orderStage, "a hold must never change orderStage");
    const resumedSalesOrder = context.planning.setSalesOrderHoldStatus(salesOrder.id, "NONE");
    assert.equal(resumedSalesOrder.holdStatus, "NONE");

    const fulfilmentLine = context.planning.addSalesOrderFulfilmentLine(
      { salesOrderId: salesOrder.id, itemTallyGuid: context.productGuid, quantity: 1 }, context.actor,
    );
    assert.equal(fulfilmentLine.holdStatus, "NONE");
    const stageBeforeLineHold = fulfilmentLine.stage;
    const afterCancellingLine = context.planning.setFulfilmentLineHoldStatus(fulfilmentLine.id, "CANCELLED");
    const cancelledLine = afterCancellingLine.fulfilmentLines.find((line) => line.id === fulfilmentLine.id)!;
    assert.equal(cancelledLine.holdStatus, "CANCELLED");
    assert.equal(cancelledLine.stage, stageBeforeLineHold, "cancelling a fulfilment line must not change its stage");
  } finally {
    closeContext(context);
  }
});

test("service orders use separate stages, do not reserve production stock, and derive warranty from Serial No", () => {
  const context = createContext();
  try {
    assert.equal(warrantyStatusForSerial("2506-ABC", "2026-06-20T00:00:00.000Z"), "IN_WARRANTY");
    assert.equal(warrantyStatusForSerial("2412-ABC", "2026-04-20T00:00:00.000Z"), "OUT_OF_WARRANTY");
    assert.equal(warrantyStatusForSerial("2613-ABC", "2026-06-20T00:00:00.000Z"), "OUT_OF_WARRANTY");

    const saved = context.planning.saveProductOrder({
      orderType: "SERVICE",
      serialNumber: "2506-SVC-001",
      externalReference: "SRV-1",
      organisation: "Service Customer",
      productTallyGuid: context.productGuid,
      quantity: 1,
      workflowStateId: "service-incoming",
      requiredDate: "2026-06-30",
    });
    assert.equal(saved.orderType, "SERVICE");
    assert.equal(saved.workflowStateName, "Service · Incoming");
    assert.equal(saved.warrantyStatus, "IN_WARRANTY");
    assert.equal(saved.priority, "LOW");
    assert.equal(saved.requirements.length, 0);
    assert.equal(
      Number((context.host.db.prepare(
        "SELECT COUNT(*) AS count FROM planning_reservations WHERE product_order_id = ?",
      ).get(saved.id) as any).count),
      0,
    );

    context.planning.updateProductOrderWorkflowState(saved.id, "service-initial-testing");
    const advanced = context.planning.getState().productOrders.find((order) => order.id === saved.id);
    assert.equal(advanced?.workflowStateName, "Service · Initial Testing");
    assert.equal(advanced?.stageHistory.length, 2);
    assert.throws(
      () => context.planning.updateProductOrderWorkflowState(saved.id, "initial-testing"),
      /belonging to this order type/,
    );
    assert.throws(
      () => context.operations.releaseProductOrder(saved.id, "release-service", "", context.actor),
      /cannot enter Production execution/,
    );
  } finally {
    closeContext(context);
  }
});

test("Tally Sales Orders import conservatively and bulk updates preserve order-type stages", () => {
  const context = createContext();
  try {
    const imported = context.planning.importTallySalesOrders([{
      tallyGuid: "TALLY-SO-1",
      voucherNumber: "SO-1001",
      voucherDate: "2026-06-20",
      customerName: "Tally Customer",
      reference: "CUSTOMER-PO-9",
      productTallyGuid: context.productGuid,
      productName: "Test Product",
      quantity: 2,
      value: 50000,
    }], context.actor);
    assert.deepEqual(imported, { imported: 1, skipped: 0, unmatched: 0 });
    const order = context.planning.getState().productOrders.find((entry) => entry.externalReference === "SO-1001");
    assert.ok(order);
    assert.equal(order.orderType, "PRODUCTION");
    assert.equal(order.workflowStateId, "po-pending");
    assert.ok(order.activity.some((entry) => entry.eventType === "TALLY_IMPORTED"));

    const repeated = context.planning.importTallySalesOrders([{
      tallyGuid: "TALLY-SO-1",
      voucherNumber: "SO-1001",
      voucherDate: "2026-06-20",
      customerName: "Changed in Tally",
      reference: "CUSTOMER-PO-9",
      productTallyGuid: context.productGuid,
      productName: "Test Product",
      quantity: 3,
      value: 70000,
    }], context.actor);
    assert.deepEqual(repeated, { imported: 0, skipped: 1, unmatched: 0 });

    context.planning.bulkUpdateProductOrders({
      orderIds: [order.id],
      responsiblePerson: "Production Owner",
      priority: "HIGH",
      workflowStateId: "po-generated",
    }, context.actor);
    const updated = context.planning.getState().productOrders.find((entry) => entry.id === order.id);
    assert.equal(updated?.responsiblePerson, "Production Owner");
    assert.equal(updated?.priority, "HIGH");
    assert.equal(updated?.workflowStateId, "po-generated");
    assert.ok(updated?.activity.some((entry) => entry.eventType === "STAGE_CHANGED"));
  } finally {
    closeContext(context);
  }
});

test("Sales Order aggregate groups one Tally voucher into one order with classified source lines and no auto-created fulfilment lines", () => {
  const context = createContext();
  try {
    const result = context.planning.importTallySalesOrderAggregates([{
      guid: "TALLY-SO-AGG-1",
      voucherNumber: "SO-AGG-1",
      voucherDate: "2026-06-24",
      customerName: "Aggregate Customer",
      reference: "CUSTOMER-PO-AGG-1",
      lines: [
        { itemName: "Test Product", itemGuid: context.productGuid, quantity: 2, rate: 25000, value: 50000, orderNumber: "", trackingNumber: "" },
        { itemName: "Test Component", itemGuid: context.componentGuid, quantity: 10, rate: 100, value: 1000, orderNumber: "", trackingNumber: "" },
      ],
    }], context.actor);
    assert.deepEqual(result, { imported: 1, updated: 0, unmatched: 0 });

    const salesOrders = context.planning.getState().salesOrders;
    assert.equal(salesOrders.length, 1);
    const order = salesOrders[0];
    assert.equal(order.tallyVoucherGuid, "TALLY-SO-AGG-1");
    assert.equal(order.customerName, "Aggregate Customer");
    assert.equal(order.orderStage, "PENDING_PO_APPROVAL");
    assert.equal(order.sourceLines.length, 2);
    assert.equal(order.fulfilmentLines.length, 0);
    const productLine = order.sourceLines.find((line) => line.itemTallyGuid === context.productGuid);
    assert.equal(productLine?.family, "MANUFACTURED");
    assert.equal(productLine?.itemQualifiedNameSnapshot, "MANUFACTURED PRODUCTS > Test Product");
    const componentLine = order.sourceLines.find((line) => line.itemTallyGuid === context.componentGuid);
    assert.equal(componentLine?.family, "UNKNOWN");

    const reimported = context.planning.importTallySalesOrderAggregates([{
      guid: "TALLY-SO-AGG-1",
      voucherNumber: "SO-AGG-1",
      voucherDate: "2026-06-24",
      customerName: "Aggregate Customer Renamed",
      reference: "CUSTOMER-PO-AGG-1",
      lines: [
        { itemName: "Test Product", itemGuid: context.productGuid, quantity: 3, rate: 25000, value: 75000, orderNumber: "", trackingNumber: "" },
      ],
    }], context.actor);
    assert.deepEqual(reimported, { imported: 0, updated: 1, unmatched: 0 });
    const updatedOrder = context.planning.getState().salesOrders.find((entry) => entry.tallyVoucherGuid === "TALLY-SO-AGG-1");
    assert.equal(updatedOrder?.customerName, "Aggregate Customer Renamed");
    assert.equal(updatedOrder?.sourceLines.length, 1);

    // The legacy flat Production Order register is untouched by this aggregate import path.
    assert.equal(context.planning.getState().productOrders.length, 0);
  } finally {
    closeContext(context);
  }
});

test("CRF revisions freeze an immutable snapshot, reprint historically, and Tally amendments after CRF Sent never silently rewrite source lines", () => {
  const context = createContext();
  const sales: ActorContext = { userId: "u-sales", displayName: "Sales Rep", username: "sales", role: "SALES", auditIdentity: "SALES", permissions: permissionsForRole(context.host.db, "SALES") };
  const accounts: ActorContext = { userId: "u-accounts", displayName: "Accounts Rep", username: "accounts", role: "ACCOUNTS", auditIdentity: "ACCOUNTS", permissions: permissionsForRole(context.host.db, "ACCOUNTS") };
  try {
    const tallyOrder = {
      guid: "TALLY-SO-CRF-1",
      voucherNumber: "SO-CRF-1",
      voucherDate: "2026-06-24",
      customerName: "CRF Customer",
      reference: "CUSTOMER-PO-CRF-1",
      lines: [{ itemName: "Test Product", itemGuid: context.productGuid, quantity: 1, rate: 1000, value: 1000, orderNumber: "", trackingNumber: "" }],
    };
    context.planning.importTallySalesOrderAggregates([tallyOrder], context.actor);
    const orderId = context.planning.getState().salesOrders.find((entry) => entry.tallyVoucherGuid === "TALLY-SO-CRF-1")!.id;
    context.planning.requestPoApproval(orderId, sales);
    const poRequest = context.planning.getState().salesOrders.find((o) => o.id === orderId)!.approvalRequests[0];
    context.planning.decideApproval(poRequest.id, "APPROVE", "", accounts);

    context.planning.submitCrfForApproval(orderId, sales);
    const afterSubmit = context.planning.getState().salesOrders.find((o) => o.id === orderId)!;
    assert.equal(afterSubmit.crfRevisions.length, 1);
    const firstRevision = afterSubmit.crfRevisions[0];
    assert.equal(firstRevision.supersededAt, null);

    const revision = context.planning.getCrfRevision(firstRevision.id);
    assert.equal(revision.payload.order.customerName, "CRF Customer");
    assert.equal(revision.payload.sourceLines.length, 1);
    const html = buildCrfHtml(revision.payload);
    assert.match(html, /CRF Customer/);
    assert.match(html, /Test Product|MANUFACTURED/);

    // Tally re-syncs the same voucher with a changed quantity after the CRF was already sent.
    context.planning.importTallySalesOrderAggregates([{
      ...tallyOrder,
      lines: [{ itemName: "Test Product", itemGuid: context.productGuid, quantity: 5, rate: 1000, value: 5000, orderNumber: "", trackingNumber: "" }],
    }], context.actor);
    const afterAmendment = context.planning.getState().salesOrders.find((o) => o.id === orderId)!;
    assert.equal(afterAmendment.sourceChanged, true);
    assert.equal(afterAmendment.sourceLines[0].quantity, 1, "source lines must not be silently rewritten");
    assert.ok(afterAmendment.pendingSourceAmendment);
    assert.equal(afterAmendment.pendingSourceAmendment?.newSourceLines[0].quantity, 5);

    // Fulfilment progress is held while the amendment is unresolved.
    const fulfilmentLine = context.planning.addSalesOrderFulfilmentLine({ salesOrderId: orderId, itemTallyGuid: context.productGuid, quantity: 1 }, sales);
    assert.throws(
      () => context.planning.advanceFulfilmentLineStage(fulfilmentLine.id, "material-purchase", sales),
      /Apply or review the amendment/,
    );

    // Applying the amendment updates the source lines and clears the hold.
    const amendmentId = afterAmendment.pendingSourceAmendment!.id;
    const appliedOrder = context.planning.applySourceAmendment(amendmentId, accounts);
    assert.equal(appliedOrder.sourceChanged, false);
    assert.equal(appliedOrder.sourceLines[0].quantity, 5);
    context.planning.advanceFulfilmentLineStage(fulfilmentLine.id, "material-purchase", sales);

    // A new CRF revision is required and supersedes the original.
    context.planning.requestCrfReapproval(orderId, sales);
    const afterReapproval = context.planning.getState().salesOrders.find((o) => o.id === orderId)!;
    assert.equal(afterReapproval.crfRevisions.length, 2);
    const original = afterReapproval.crfRevisions.find((entry) => entry.revisionNumber === 1)!;
    assert.ok(original.supersededAt);
    const reprint = context.planning.getCrfRevision(original.id);
    assert.equal(reprint.payload.sourceLines[0].quantity, 1, "an old revision must reprint exactly as it was originally");
  } finally {
    closeContext(context);
  }
});

test("dual-approval engine enforces distinct approvers and no self-approval, and the checklist engine resolves and waives requirements", () => {
  const context = createContext();
  const sales: ActorContext = { userId: "u-sales", displayName: "Sales Rep", username: "sales", role: "SALES", auditIdentity: "SALES", permissions: permissionsForRole(context.host.db, "SALES") };
  const accounts: ActorContext = { userId: "u-accounts", displayName: "Accounts Rep", username: "accounts", role: "ACCOUNTS", auditIdentity: "ACCOUNTS", permissions: permissionsForRole(context.host.db, "ACCOUNTS") };
  const secondAccounts: ActorContext = { userId: "u-accounts-2", displayName: "Accounts Rep 2", username: "accounts2", role: "ACCOUNTS", auditIdentity: "ACCOUNTS", permissions: permissionsForRole(context.host.db, "ACCOUNTS") };
  try {
    context.planning.importTallySalesOrderAggregates([{
      guid: "TALLY-SO-APPROVAL-1",
      voucherNumber: "SO-APPROVAL-1",
      voucherDate: "2026-06-24",
      customerName: "Approval Customer",
      reference: "CUSTOMER-PO-AP-1",
      lines: [{ itemName: "Test Product", itemGuid: context.productGuid, quantity: 1, rate: 1000, value: 1000, orderNumber: "", trackingNumber: "" }],
    }], context.actor);
    const orderId = context.planning.getState().salesOrders.find((entry) => entry.tallyVoucherGuid === "TALLY-SO-APPROVAL-1")!.id;

    // PO approval: a single Accounts decision satisfies it and advances the order to CRF_PENDING.
    context.planning.requestPoApproval(orderId, sales);
    assert.throws(() => context.planning.requestPoApproval(orderId, sales), /already pending/);
    const poRequest = context.planning.getState().salesOrders.find((o) => o.id === orderId)!.approvalRequests[0];
    assert.throws(
      () => context.planning.decideApproval(poRequest.id, "APPROVE", "", sales),
      /does not hold a permission required/,
    );
    const afterPoApproval = context.planning.decideApproval(poRequest.id, "APPROVE", "", accounts);
    assert.equal(afterPoApproval.orderStage, "CRF_PENDING");
    assert.equal(afterPoApproval.approvalRequests[0].status, "APPROVED");

    // Checklist: requires a Manufactured fulfilment line; waiving lets the CRF submit anyway.
    context.planning.saveChecklistTemplate({
      name: "Standard CRF Checklist",
      requirements: [{ targetType: "PRIMARY_GROUP", targetValue: "MANUFACTURED", description: "At least one Manufactured Product line" }],
    }, context.actor);
    let checklist = context.planning.resolveChecklistForOrder(orderId, sales);
    assert.equal(checklist[0].status, "UNSATISFIED");
    context.planning.waiveChecklistRequirement(orderId, checklist[0].requirementId, "Customer-supplied assembly, no manufacturing on our side", context.actor);
    checklist = context.planning.getChecklistResultsForOrder(orderId);
    assert.equal(checklist[0].status, "WAIVED");
    assert.equal(checklist[0].waiverReason, "Customer-supplied assembly, no manufacturing on our side");

    // Submitting the CRF moves the order to CRF_SENT and opens the dual Accounts+Sales approval.
    context.planning.submitCrfForApproval(orderId, sales);
    const afterSubmit = context.planning.getState().salesOrders.find((o) => o.id === orderId)!;
    assert.equal(afterSubmit.orderStage, "CRF_SENT");
    const crfRequest = afterSubmit.approvalRequests.find((entry) => entry.entityType === "SALES_ORDER_CRF" && entry.status === "PENDING")!;

    // The submitter cannot also approve.
    assert.throws(() => context.planning.decideApproval(crfRequest.id, "APPROVE", "", sales), /cannot also approve/);
    // One Accounts approval alone is not enough — Sales must also approve, from a different person.
    context.planning.decideApproval(crfRequest.id, "APPROVE", "", accounts);
    const partial = context.planning.getState().salesOrders.find((o) => o.id === orderId)!;
    assert.equal(partial.orderStage, "CRF_SENT");
    // A second Accounts approval cannot fill the Sales slot.
    context.planning.decideApproval(crfRequest.id, "APPROVE", "", secondAccounts);
    const stillPending = context.planning.getState().salesOrders.find((o) => o.id === orderId)!;
    assert.equal(stillPending.orderStage, "CRF_SENT");

    // Editing a fulfilment line after submission supersedes the pending approval.
    context.planning.addSalesOrderFulfilmentLine({ salesOrderId: orderId, itemTallyGuid: context.productGuid, quantity: 1 }, sales);
    const afterEdit = context.planning.getState().salesOrders.find((o) => o.id === orderId)!;
    assert.equal(afterEdit.approvalRequests.find((entry) => entry.id === crfRequest.id)?.status, "SUPERSEDED");
  } finally {
    closeContext(context);
  }
});

test("fulfilment-line workflows enforce family-derived stages, nesting rules, and order-level approval gates", () => {
  const context = createContext();
  try {
    context.stores.createCatalogGroup({ name: "Resale Goods" });
    context.stores.createCatalogGroup({ name: "Raw Materials" });
    const resaleItem = context.stores.createLocalStockItem({ name: "Resale Widget", parentName: "Resale Goods" });
    const rawMaterialItem = context.stores.createLocalStockItem({ name: "Raw Bolt", parentName: "Raw Materials" });
    const supplierId = Number(context.host.db.prepare(
      "INSERT INTO suppliers(tally_guid, name, synced_at) VALUES (?, ?, ?)",
    ).run("SUPPLIER:RESALE", "Resale Supplier", new Date().toISOString()).lastInsertRowid);

    const aggregate = context.planning.importTallySalesOrderAggregates([{
      guid: "TALLY-SO-WORKFLOW-1",
      voucherNumber: "SO-WORKFLOW-1",
      voucherDate: "2026-06-24",
      customerName: "Workflow Customer",
      reference: "CUSTOMER-PO-WF-1",
      lines: [{ itemName: "Test Product", itemGuid: context.productGuid, quantity: 1, rate: 1000, value: 1000, orderNumber: "", trackingNumber: "" }],
    }], context.actor);
    assert.equal(aggregate.imported, 1);
    const orderId = context.planning.getState().salesOrders.find((entry) => entry.tallyVoucherGuid === "TALLY-SO-WORKFLOW-1")!.id;

    // Manufactured line: starts at material-planning, reuses the 15-stage lookup, gates quality-control on material-purchase.
    const manufacturedLine = context.planning.addSalesOrderFulfilmentLine({
      salesOrderId: orderId,
      itemTallyGuid: context.productGuid,
      quantity: 1,
    }, context.actor);
    assert.equal(manufacturedLine.family, "MANUFACTURED");
    assert.equal(manufacturedLine.stage, "material-planning");
    assert.throws(
      () => context.planning.advanceFulfilmentLineStage(manufacturedLine.id, "quality-control", context.actor),
      /Material Purchase/,
    );
    context.planning.advanceFulfilmentLineStage(manufacturedLine.id, "material-purchase", context.actor);
    context.planning.advanceFulfilmentLineStage(manufacturedLine.id, "quality-control", context.actor);

    // Nested Resale line under the Manufactured line.
    const resaleLine = context.planning.addSalesOrderFulfilmentLine({
      salesOrderId: orderId,
      parentFulfilmentLineId: manufacturedLine.id,
      itemTallyGuid: resaleItem.tallyGuid,
      quantity: 2,
    }, context.actor);
    assert.equal(resaleLine.parentFulfilmentLineId, manufacturedLine.id);
    assert.equal(resaleLine.stage, "pending-supplier");
    const resaleLineWithSupplier = context.planning.assignResaleSupplier(resaleLine.id, supplierId, context.actor);
    assert.equal(resaleLineWithSupplier.resaleSupplierName, "Resale Supplier");
    context.planning.advanceFulfilmentLineStage(resaleLine.id, "items-received", context.actor);
    assert.throws(
      () => context.planning.advanceFulfilmentLineStage(resaleLine.id, "not-a-real-stage", context.actor),
      /valid stage/,
    );

    // Top-level Raw Material line, sold direct.
    const rawMaterialLine = context.planning.addSalesOrderFulfilmentLine({
      salesOrderId: orderId,
      itemTallyGuid: rawMaterialItem.tallyGuid,
      quantity: 5,
    }, context.actor);
    assert.equal(rawMaterialLine.stage, "awaiting-restock");

    // Internally-consumed Raw Material line cannot be progressed through dispatch stages.
    const internalLine = context.planning.addSalesOrderFulfilmentLine({
      salesOrderId: orderId,
      itemTallyGuid: rawMaterialItem.tallyGuid,
      quantity: 3,
      consumptionMode: "INTERNAL_CONSUMPTION",
    }, context.actor);
    assert.equal(internalLine.stage, "");
    assert.throws(
      () => context.planning.advanceFulfilmentLineStage(internalLine.id, "awaiting-restock", context.actor),
      /Material Issue/,
    );

    // Manufactured/Service lines cannot nest under another line; non-Manufactured parents are rejected.
    assert.throws(
      () => context.planning.addSalesOrderFulfilmentLine({
        salesOrderId: orderId, parentFulfilmentLineId: resaleLine.id, itemTallyGuid: rawMaterialItem.tallyGuid, quantity: 1,
      }, context.actor),
      /Manufactured Product lines can have supporting/,
    );
    assert.throws(
      () => context.planning.addSalesOrderFulfilmentLine({
        salesOrderId: orderId, parentFulfilmentLineId: manufacturedLine.id, itemTallyGuid: context.productGuid, quantity: 1,
      }, context.actor),
      /must be top-level/,
    );

    // Order-level stage machine: forward-only, and the two approval-gated transitions reject direct advancement.
    assert.throws(
      () => context.planning.advanceSalesOrderStage(orderId, "CRF_PENDING", context.actor),
      /requires an approved request/,
    );
    assert.throws(
      () => context.planning.advanceSalesOrderStage(orderId, "COMPLETED", context.actor),
      /move forward one step/,
    );
    // Only the internal setSalesOrderStage() escape hatch (used by the approval engine) may apply the gated transitions.
    context.planning.setSalesOrderStage(orderId, "CRF_PENDING", context.actor);
    context.planning.advanceSalesOrderStage(orderId, "CRF_SENT", context.actor);
    assert.throws(
      () => context.planning.advanceSalesOrderStage(orderId, "IN_FULFILMENT", context.actor),
      /requires an approved request/,
    );
    context.planning.setSalesOrderStage(orderId, "IN_FULFILMENT", context.actor);
    const finalOrder = context.planning.advanceSalesOrderStage(orderId, "COMPLETED", context.actor);
    assert.equal(finalOrder.orderStage, "COMPLETED");
  } finally {
    closeContext(context);
  }
});

test("obsolete items remain visible to Accounts until a restock policy is decided", () => {
  const context = createContext();
  try {
    context.stores.setCatalogStatus({
      tallyItemGuid: context.componentGuid,
      status: "OBSOLETE",
    });
    const item = context.planning.getState().items.find((entry) => entry.tallyItemGuid === context.componentGuid);
    assert.equal(item?.catalogStatus, "OBSOLETE");
    assert.equal(item?.targetStock, 0);
  } finally {
    closeContext(context);
  }
});

test("order stages are fixed while custom fields can be deleted safely", () => {
  const context = createContext();
  try {
    const field = context.planning.saveProductOrderFieldDefinition({
      label: "Temporary field",
      type: "TEXT",
    });
    context.planning.deleteProductOrderFieldDefinition(field.id);
    let state = context.planning.getState();
    assert.equal(state.productOrderWorkflowStates.filter((entry) => entry.orderType === "PRODUCTION").length, 15);
    assert.equal(state.productOrderWorkflowStates.filter((entry) => entry.orderType === "SERVICE").length, 9);
    assert.equal(state.productOrderFieldDefinitions.some((entry) => entry.id === field.id), false);
    assert.throws(
      () => context.planning.saveProductOrderWorkflowState({ name: "Temporary state" }),
      /stages are fixed/,
    );
    assert.throws(() => context.planning.deleteProductOrderWorkflowState("po-pending"), /stages are fixed/);
  } finally {
    closeContext(context);
  }
});

test("migrations are additive and receipt splits keep only AVAILABLE in the legacy FIFO balance", () => {
  const context = createContext();
  try {
    receive(context, "receipt-split", {
      quantity: 10,
      acceptedQuantity: 5,
      pendingInspectionQuantity: 3,
      faultyQuantity: 2,
      batchNumber: "BATCH-1",
      supplierLotReference: "SUP-LOT-1",
      expiryDate: "2026-07-01",
      availableSerialNumbers: ["A-1", "A-2", "A-3", "A-4", "A-5"],
      pendingSerialNumbers: ["P-1", "P-2", "P-3"],
      faultySerialNumbers: ["F-1", "F-2"],
      faultReason: "Damaged on arrival",
    });
    assert.equal(context.operations.moduleVersion, 9);
    assert.equal(balance(context, "AVAILABLE").quantity, 5);
    assert.equal(balance(context, "PENDING_INSPECTION").quantity, 3);
    assert.equal(balance(context, "FAULTY").quantity, 2);
    assert.equal(Number((context.host.db.prepare("SELECT quantity_remaining FROM purchase_lots").get() as any).quantity_remaining), 5);
    assert.throws(() => context.stores.recordMaterialOut({
      clientTransactionId: "issue-too-many",
      boxId: "",
      tallyItemGuid: context.componentGuid,
      destinationTallyItemGuid: context.productGuid,
      quantity: 6,
      serialNumbers: ["A-1", "A-2", "A-3", "A-4", "A-5", "P-1"],
    }), /Insufficient local stock/);
    assert.equal(context.operations.getState().faults.length, 1);
    assert.deepEqual(traceabilityColumns(context.operations.getState().balances), {
      batch: true,
      serial: true,
      expiry: true,
      supplierLot: true,
    });
    const migrationRows = context.host.db.prepare(
      "SELECT version FROM application_module_migrations WHERE module_name = 'operations' ORDER BY version",
    ).all() as Array<{ version: number }>;
    assert.deepEqual(migrationRows.map((row) => Number(row.version)), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  } finally {
    closeContext(context);
  }
});

test("Return found stock needs no product and non-production Material Out needs no destination", () => {
  const context = createContext();
  try {
    const materialIn = context.stores.recordMaterialInCorrection({
      clientTransactionId: "found-extra-material",
      boxId: "",
      tallyItemGuid: context.componentGuid,
      quantity: 2,
      direction: "RETURN_TO_STOCK",
      reason: "OTHER",
      note: "Previously issued extras found in stores",
    });
    assert.equal(materialIn.quantity, 2);
    const servicing = context.stores.recordMaterialOut({
      clientTransactionId: "servicing-material-out",
      boxId: "",
      tallyItemGuid: context.componentGuid,
      purpose: "SERVICING",
      quantity: 1,
    });
    assert.equal(servicing.destinationName, "Servicing");
  } finally {
    closeContext(context);
  }
});

test("generic issues cannot consume stock protected for production orders", () => {
  const context = createContext();
  try {
    receive(context, "receipt-reservation-protection", { quantity: 10 });
    const componentId = Number((context.host.db.prepare(
      "SELECT id FROM tally_stock_items WHERE tally_guid = ?",
    ).get(context.componentGuid) as any).id);
    const productId = Number((context.host.db.prepare(
      "SELECT id FROM tally_stock_items WHERE tally_guid = ?",
    ).get(context.productGuid) as any).id);
    const timestamp = new Date().toISOString();
    context.host.db.prepare(`
      INSERT INTO planning_product_orders(id, external_reference, product_item_id, quantity, required_date, status, notes, created_at, updated_at)
      VALUES ('ORDER-PROTECTED', 'PO-PROTECTED', ?, 1, '2026-06-30', 'CONFIRMED', '', ?, ?)
    `).run(productId, timestamp, timestamp);
    context.host.db.prepare(`
      INSERT INTO planning_reservations(id, product_order_id, component_item_id, required_quantity, reserved_quantity, status, created_at, updated_at)
      VALUES ('RES-PROTECTED', 'ORDER-PROTECTED', ?, 6, 6, 'ACTIVE', ?, ?)
    `).run(componentId, timestamp, timestamp);

    assert.throws(() => context.stores.recordMaterialOut({
      clientTransactionId: "generic-over-free-stock",
      boxId: "",
      tallyItemGuid: context.componentGuid,
      purpose: "SERVICING",
      quantity: 5,
    }), /free to issue|protected/);

    const issue = context.stores.recordMaterialOut({
      clientTransactionId: "own-order-issue",
      boxId: "",
      tallyItemGuid: context.componentGuid,
      destinationTallyItemGuid: context.productGuid,
      productOrderId: "ORDER-PROTECTED",
      quantity: 5,
    });
    context.operations.registerMaterialOut({
      clientTransactionId: "own-order-issue",
      tallyItemGuid: context.componentGuid,
      destinationTallyItemGuid: context.productGuid,
      productOrderId: "ORDER-PROTECTED",
      quantity: 5,
    }, issue, context.actor);
    assert.equal(Number((context.host.db.prepare(
      "SELECT reserved_quantity FROM planning_reservations WHERE id = 'RES-PROTECTED'",
    ).get() as any).reserved_quantity), 1);
  } finally {
    closeContext(context);
  }
});

test("linked production returns restore reservations only when material is still required", () => {
  const context = createContext();
  try {
    receive(context, "receipt-return-reservation", { quantity: 8 });
    const componentId = Number((context.host.db.prepare(
      "SELECT id FROM tally_stock_items WHERE tally_guid = ?",
    ).get(context.componentGuid) as any).id);
    const productId = Number((context.host.db.prepare(
      "SELECT id FROM tally_stock_items WHERE tally_guid = ?",
    ).get(context.productGuid) as any).id);
    const timestamp = new Date().toISOString();
    context.host.db.prepare(`
      INSERT INTO planning_product_orders(id, external_reference, product_item_id, quantity, required_date, status, notes, created_at, updated_at)
      VALUES ('ORDER-RETURN-RES', 'PO-RETURN-RES', ?, 1, '2026-06-30', 'CONFIRMED', '', ?, ?)
    `).run(productId, timestamp, timestamp);
    context.host.db.prepare(`
      INSERT INTO planning_reservations(id, product_order_id, component_item_id, required_quantity, reserved_quantity, status, created_at, updated_at)
      VALUES ('RES-RETURN-RES', 'ORDER-RETURN-RES', ?, 4, 4, 'ACTIVE', ?, ?)
    `).run(componentId, timestamp, timestamp);

    const issue = context.stores.recordMaterialOut({
      clientTransactionId: "return-reservation-issue",
      boxId: "",
      tallyItemGuid: context.componentGuid,
      destinationTallyItemGuid: context.productGuid,
      productOrderId: "ORDER-RETURN-RES",
      quantity: 3,
    });
    context.operations.registerMaterialOut({
      clientTransactionId: "return-reservation-issue",
      tallyItemGuid: context.componentGuid,
      destinationTallyItemGuid: context.productGuid,
      productOrderId: "ORDER-RETURN-RES",
      quantity: 3,
    }, issue, context.actor);
    assert.equal(Number((context.host.db.prepare(
      "SELECT reserved_quantity FROM planning_reservations WHERE id = 'RES-RETURN-RES'",
    ).get() as any).reserved_quantity), 1);

    const originalMovementId = context.operations.getState().movements.find((movement) => movement.clientTransactionId === "return-reservation-issue")?.id;
    assert.ok(originalMovementId);
    context.operations.productionReturn({
      clientTransactionId: "return-reservation-still-required",
      tallyItemGuid: context.componentGuid,
      quantity: 1,
      originalMovementId,
      productOrderId: "ORDER-RETURN-RES",
      targetCondition: "AVAILABLE",
      requirementDisposition: "STILL_REQUIRED",
    }, context.actor);
    assert.equal(Number((context.host.db.prepare(
      "SELECT reserved_quantity FROM planning_reservations WHERE id = 'RES-RETURN-RES'",
    ).get() as any).reserved_quantity), 2);

    context.operations.productionReturn({
      clientTransactionId: "return-reservation-reduced",
      tallyItemGuid: context.componentGuid,
      quantity: 1,
      originalMovementId,
      productOrderId: "ORDER-RETURN-RES",
      targetCondition: "AVAILABLE",
      requirementDisposition: "REQUIREMENT_REDUCED",
    }, context.actor);
    assert.equal(Number((context.host.db.prepare(
      "SELECT reserved_quantity FROM planning_reservations WHERE id = 'RES-RETURN-RES'",
    ).get() as any).reserved_quantity), 2);
  } finally {
    closeContext(context);
  }
});

test("rejected purchase receipts do not close purchase order demand", () => {
  const context = createContext();
  try {
    const componentId = Number((context.host.db.prepare(
      "SELECT id FROM tally_stock_items WHERE tally_guid = ?",
    ).get(context.componentGuid) as any).id);
    const timestamp = new Date().toISOString();
    const poId = Number(context.host.db.prepare(`
      INSERT INTO purchase_orders(tally_guid, voucher_number, voucher_date, supplier_id, status, synced_at)
      VALUES ('PO-REJECTED', 'PO-REJECTED', '2026-06-20', ?, 'OPEN', ?)
    `).run(context.supplierId, timestamp).lastInsertRowid);
    context.host.db.prepare(`
      INSERT INTO purchase_order_lines(purchase_order_id, stock_item_id, ordered_quantity, received_quantity, rate, value)
      VALUES (?, ?, 10, 0, 100, 1000)
    `).run(poId, componentId);

    const result = context.stores.recordBulkVendorReceipt({
      clientTransactionId: "receipt-partial-rejected",
      supplierId: context.supplierId,
      purchaseOrderId: poId,
      challanNumber: "CH-REJECTED",
      challanDate: "2026-06-21",
      receiptDate: "2026-06-21",
      lines: [{
        tallyItemGuid: context.componentGuid,
        quantity: 10,
        rejectedQuantity: 3,
        acceptedQuantity: 7,
      }],
    });
    context.operations.registerBulkReceipt({
      clientTransactionId: "receipt-partial-rejected",
      supplierId: context.supplierId,
      purchaseOrderId: poId,
      challanNumber: "CH-REJECTED",
      challanDate: "2026-06-21",
      receiptDate: "2026-06-21",
      lines: [{
        tallyItemGuid: context.componentGuid,
        quantity: 10,
        rejectedQuantity: 3,
        acceptedQuantity: 7,
      }],
    }, result, context.actor);

    const line = context.stores.getState().purchaseOrders.find((order) => order.id === poId)?.lines[0];
    assert.equal(line?.acceptedQuantity, 7);
    assert.equal(line?.outstandingQuantity, 3);
    assert.equal(context.stores.getState().purchaseOrders.find((order) => order.id === poId)?.status, "OPEN");
    assert.equal(balance(context, "AVAILABLE").quantity, 7);
  } finally {
    closeContext(context);
  }
});

test("role permissions are enforced independently of renderer visibility, and are admin-configurable", () => {
  const context = createContext();
  try {
    const db = context.host.db;
    assert.ok(permissionsForRole(db, "STORE").includes("STOCK_COUNT"));
    assert.ok(permissionsForRole(db, "ACCOUNTS").includes("TALLY_REVIEW"));
    assert.ok(permissionsForRole(db, "PRODUCTION").includes("PRODUCTION_EXECUTE"));
    assert.ok(permissionsForRole(db, "SALES").includes("CUSTOMER_RETURN_INITIATE"));

    const store: ActorContext = { userId: "u-store", displayName: "Store", username: "store", role: "STORE", auditIdentity: "STORE", permissions: permissionsForRole(db, "STORE") };
    const sales: ActorContext = { userId: "u-sales", displayName: "Sales", username: "sales", role: "SALES", auditIdentity: "SALES", permissions: permissionsForRole(db, "SALES") };
    assert.equal(requirePermission(store, "RECEIVE_MATERIAL"), store);
    assert.throws(() => requirePermission(sales, "STOCK_ADJUST"), /does not have permission/);

    // The mapping is genuinely data-driven: toggling a grant takes effect without a code change.
    db.prepare("UPDATE ops_role_permissions SET enabled = 0 WHERE role_name = 'STORE' AND permission = 'RECEIVE_MATERIAL'").run();
    const storeAfterRevoke: ActorContext = { ...store, permissions: permissionsForRole(db, "STORE") };
    assert.throws(() => requirePermission(storeAfterRevoke, "RECEIVE_MATERIAL"), /does not have permission/);
  } finally {
    closeContext(context);
  }
});

test("a custom role granted the right permission can fill an approval slot, just like the original role would", () => {
  const context = createContext();
  try {
    context.operations.createRole("SALES_JUNIOR", context.actor);
    context.operations.setRolePermission("SALES_JUNIOR", "SALES_ORDER_VIEW", true, context.actor);
    context.operations.setRolePermission("SALES_JUNIOR", "SALES_ORDER_EDIT_CRF", true, context.actor);
    context.operations.setRolePermission("SALES_JUNIOR", "SALES_ORDER_SUBMIT_CRF", true, context.actor);
    context.operations.setRolePermission("SALES_JUNIOR", "SALES_ORDER_APPROVE_CRF_SALES", true, context.actor);
    assert.ok(context.operations.listRoles().some((role) => role.name === "SALES_JUNIOR" && !role.isSystem));

    const db = context.host.db;
    const juniorSales: ActorContext = {
      userId: "u-junior-sales", displayName: "Junior Sales", username: "junior-sales",
      role: "SALES_JUNIOR", auditIdentity: "SALES_JUNIOR", permissions: permissionsForRole(db, "SALES_JUNIOR"),
    };
    const secondJuniorSales: ActorContext = {
      userId: "u-junior-sales-2", displayName: "Junior Sales 2", username: "junior-sales-2",
      role: "SALES_JUNIOR", auditIdentity: "SALES_JUNIOR", permissions: permissionsForRole(db, "SALES_JUNIOR"),
    };
    const accounts: ActorContext = {
      userId: "u-accounts", displayName: "Accounts Rep", username: "accounts",
      role: "ACCOUNTS", auditIdentity: "ACCOUNTS", permissions: permissionsForRole(db, "ACCOUNTS"),
    };

    context.planning.importTallySalesOrderAggregates([{
      guid: "TALLY-SO-CUSTOM-ROLE-1",
      voucherNumber: "SO-CUSTOM-ROLE-1",
      voucherDate: "2026-06-24",
      customerName: "Custom Role Customer",
      reference: "CUSTOMER-PO-CUSTOM-ROLE-1",
      lines: [{ itemName: "Test Product", itemGuid: context.productGuid, quantity: 1, rate: 100, value: 100, orderNumber: "", trackingNumber: "" }],
    }], context.actor);
    const orderId = context.planning.getState().salesOrders.find((o) => o.tallyVoucherGuid === "TALLY-SO-CUSTOM-ROLE-1")!.id;
    context.planning.requestPoApproval(orderId, context.actor);
    const poRequest = context.planning.getState().salesOrders.find((o) => o.id === orderId)!.approvalRequests.find((r) => r.status === "PENDING")!;
    context.planning.decideApproval(poRequest.id, "APPROVE", "", accounts);
    context.planning.submitCrfForApproval(orderId, juniorSales);
    const crfRequest = context.planning.getState().salesOrders.find((o) => o.id === orderId)!.approvalRequests.find((entry) => entry.entityType === "SALES_ORDER_CRF" && entry.status === "PENDING")!;
    context.planning.decideApproval(crfRequest.id, "APPROVE", "", accounts);
    context.planning.decideApproval(crfRequest.id, "APPROVE", "", secondJuniorSales);
    const approved = context.planning.getState().salesOrders.find((o) => o.id === orderId)!;
    assert.equal(approved.orderStage, "IN_FULFILMENT");
  } finally {
    closeContext(context);
  }
});

test("a permission can be restricted to named computers, and is unaffected when unrestricted", () => {
  const context = createContext();
  try {
    const db = context.host.db;
    // Unrestricted by default: any computer name (including none) keeps the permission.
    assert.ok(resolveActorPermissions(db, "STORE", "ANY-COMPUTER").includes("STOCK_COUNT"));
    assert.ok(resolveActorPermissions(db, "STORE", "").includes("STOCK_COUNT"));

    db.prepare("INSERT INTO ops_permission_computer_restrictions(permission, computer_name) VALUES ('STOCK_COUNT', 'STORE-PC-1')").run();
    assert.ok(resolveActorPermissions(db, "STORE", "STORE-PC-1").includes("STOCK_COUNT"));
    assert.ok(resolveActorPermissions(db, "STORE", "store-pc-1").includes("STOCK_COUNT"), "computer name match is case-insensitive");
    assert.ok(!resolveActorPermissions(db, "STORE", "STORE-PC-2").includes("STOCK_COUNT"));
    assert.ok(!resolveActorPermissions(db, "STORE", "").includes("STOCK_COUNT"), "an unidentified caller cannot use a restricted permission");
    // Every other permission the role holds is untouched by this one restriction.
    assert.ok(resolveActorPermissions(db, "STORE", "STORE-PC-2").includes("RECEIVE_MATERIAL"));

    const onAllowedComputer: ActorContext = {
      userId: "u-store", displayName: "Store", username: "store", role: "STORE", auditIdentity: "STORE",
      permissions: resolveActorPermissions(db, "STORE", "STORE-PC-1"),
    };
    const onOtherComputer: ActorContext = { ...onAllowedComputer, permissions: resolveActorPermissions(db, "STORE", "STORE-PC-2") };
    assert.equal(requirePermission(onAllowedComputer, "STOCK_COUNT"), onAllowedComputer);
    assert.throws(() => requirePermission(onOtherComputer, "STOCK_COUNT"), /does not have permission/);
  } finally {
    closeContext(context);
  }
});

test("condition transitions, serial uniqueness, supplier faults, partial resolution, return and scrap stay auditable", () => {
  const context = createContext();
  try {
    receive(context, "receipt-lifecycle", {
      quantity: 6,
      acceptedQuantity: 4,
      pendingInspectionQuantity: 2,
      availableSerialNumbers: ["SER-1", "SER-2", "SER-3", "SER-4"],
      pendingSerialNumbers: ["SER-5", "SER-6"],
    });
    const pending = balance(context, "PENDING_INSPECTION");
    context.operations.transitionCondition({
      clientTransactionId: "inspect-release",
      tallyItemGuid: context.componentGuid,
      lotId: pending.lotId,
      quantity: 1,
      fromCondition: "PENDING_INSPECTION",
      toCondition: "AVAILABLE",
      reason: "Passed inspection",
      serialNumbers: ["SER-5"],
    }, context.actor);
    const fault = context.operations.createFault({
      clientTransactionId: "late-fault",
      tallyItemGuid: context.componentGuid,
      lotId: pending.lotId,
      quantity: 2,
      sourceCondition: "AVAILABLE",
      discoveryPoint: "IN_STORES",
      faultReason: "Failed functional test",
      serialNumbers: ["SER-1", "SER-2"],
    }, context.actor);
    const partial = context.operations.resolveFault({
      clientTransactionId: "fault-partial-credit",
      faultId: fault.id,
      quantity: 1,
      resolution: "CREDIT_NOTE_RECEIVED",
      reference: "CN-1",
      expectedVersion: fault.version,
    }, context.actor);
    assert.equal(partial.status, "PARTIALLY_RESOLVED");
    const returned = context.operations.resolveFault({
      clientTransactionId: "fault-return",
      faultId: fault.id,
      quantity: 1,
      resolution: "RETURNED_TO_SUPPLIER",
      reference: "SRT-1",
      expectedVersion: partial.version,
      serialNumbers: ["SER-1"],
    }, context.actor);
    assert.equal(returned.status, "RESOLVED");
    context.host.db.prepare("UPDATE purchase_lots SET rate = 125, value = quantity_received * 125").run();
    context.operations.scrap({
      clientTransactionId: "scrap-pending",
      tallyItemGuid: context.componentGuid,
      lotId: pending.lotId,
      quantity: 1,
      sourceCondition: "PENDING_INSPECTION",
      reason: "Destroyed during inspection",
      serialNumbers: ["SER-6"],
    }, context.actor);
    assert.equal(context.operations.getState().wastage.totalValue, 125);
    assert.equal(context.operations.getState().wastage.byMaterial[0]?.name, "Test Component");
    assert.throws(() => receive(context, "duplicate-serial", {
      quantity: 1,
      acceptedQuantity: 1,
      availableSerialNumbers: ["SER-3"],
    }), /Serial number.*already exists|UNIQUE/i);
    const replacementFault = context.operations.createFault({
      clientTransactionId: "replacement-fault",
      tallyItemGuid: context.componentGuid,
      lotId: pending.lotId,
      quantity: 1,
      sourceCondition: "AVAILABLE",
      discoveryPoint: "IN_STORES",
      faultReason: "Intermittent failure",
      serialNumbers: ["SER-3"],
    }, context.actor);
    context.operations.resolveFault({
      clientTransactionId: "replacement-received",
      faultId: replacementFault.id,
      quantity: 1,
      resolution: "REPLACEMENT_RECEIVED",
      targetCondition: "PENDING_INSPECTION",
      reference: "REPL-1",
      serialNumbers: ["REPLACEMENT-1"],
      expectedVersion: replacementFault.version,
    }, context.actor);
    const state = context.operations.getState();
    assert.ok(state.balances.some((entry) => entry.condition === "PENDING_INSPECTION" && entry.serialNumbers.includes("REPLACEMENT-1")));
    assert.ok(state.movements.some((movement) => movement.movementType === "SUPPLIER_RETURN"));
    assert.ok(state.movements.some((movement) => movement.movementType === "SCRAP"));
    assert.ok(state.manualTallyReviews.some((entry) => entry.movementType === "SUPPLIER_RETURN"));
    assert.ok(state.manualTallyReviews.some((entry) => entry.movementType === "SCRAP"));
    const supplierReturn = state.supplierReturns[0] as any;
    const updatedReturn = context.operations.updateSupplierReturn({
      returnId: String(supplierReturn.id),
      replacementStatus: "EXPECTED",
      creditStatus: "NOT_EXPECTED",
      notes: "Replacement due next week",
      expectedVersion: Number(supplierReturn.version),
    }, context.actor) as any;
    assert.equal(updatedReturn.replacementStatus, "EXPECTED");
    assert.throws(() => context.operations.updateSupplierReturn({
      returnId: String(supplierReturn.id),
      replacementStatus: "RECEIVED",
      creditStatus: "NOT_EXPECTED",
      expectedVersion: Number(supplierReturn.version),
    }, context.actor), /changed after it was opened/);
  } finally {
    closeContext(context);
  }
});

test("stock counts account for post-snapshot movements and finalize explicit adjustment entries", () => {
  const context = createContext();
  try {
    receive(context, "receipt-count", { quantity: 5 });
    const session = context.operations.createCountSession({
      clientTransactionId: "count-create",
      name: "Cycle count",
      scope: "CYCLE",
      tallyItemGuids: [context.componentGuid],
      includeAvailable: true,
      includeFaulty: false,
    }, context.actor);
    const available = balance(context, "AVAILABLE");
    context.operations.transitionCondition({
      clientTransactionId: "post-count-fault",
      tallyItemGuid: context.componentGuid,
      lotId: available.lotId,
      quantity: 1,
      fromCondition: "AVAILABLE",
      toCondition: "FAULTY",
      reason: "Damaged after snapshot",
    }, context.actor);
    const entry = context.operations.recordCountEntry({
      clientTransactionId: "count-entry",
      sessionId: session.id,
      tallyItemGuid: context.componentGuid,
      condition: "AVAILABLE",
      countedQuantity: 3,
      reason: "COUNT_SHORTAGE",
      notes: "One unit missing",
      expectedVersion: session.version,
    }, context.actor);
    const line = entry.lines.find((candidate) => candidate.condition === "AVAILABLE");
    assert.equal(line?.snapshotExpected, 5);
    assert.equal(line?.postSnapshotMovement, -1);
    assert.equal(line?.currentExpected, 4);
    assert.equal(line?.variance, -1);
    const finalized = context.operations.finalizeCount({
      clientTransactionId: "count-finalize",
      sessionId: session.id,
      expectedVersion: entry.version,
    }, context.actor);
    assert.equal(finalized.status, "FINALIZED");
    assert.ok(context.operations.getState().movements.some((movement) => movement.movementType === "COUNT_ADJUSTMENT_LOSS"));
    assert.equal(balance(context, "AVAILABLE").quantity, 3);
    const gainSession = context.operations.createCountSession({
      clientTransactionId: "count-gain-create",
      name: "Recovered stock",
      scope: "CYCLE",
      tallyItemGuids: [context.componentGuid],
      includeAvailable: true,
      includeFaulty: false,
    }, context.actor);
    const gainEntry = context.operations.recordCountEntry({
      clientTransactionId: "count-gain-entry",
      sessionId: gainSession.id,
      tallyItemGuid: context.componentGuid,
      condition: "AVAILABLE",
      countedQuantity: 5,
      reason: "RECOVERED_STOCK",
      notes: "Two units found behind shelving",
      expectedVersion: gainSession.version,
    }, context.actor);
    context.operations.finalizeCount({
      clientTransactionId: "count-gain-finalize",
      sessionId: gainSession.id,
      expectedVersion: gainEntry.version,
    }, context.actor);
    assert.equal(context.operations.getState().balances
      .filter((entry) => entry.tallyItemGuid === context.componentGuid && entry.condition === "AVAILABLE")
      .reduce((sum, entry) => sum + entry.quantity, 0), 5);
    assert.ok(context.operations.getState().movements.some((movement) => movement.movementType === "COUNT_ADJUSTMENT_GAIN"));
  } finally {
    closeContext(context);
  }
});

test("production completion, customer returns, idempotency, reversals and synchronization exceptions remain linked", () => {
  const context = createContext();
  try {
    receive(context, "receipt-production", { quantity: 8 });
    const componentId = Number((context.host.db.prepare("SELECT id FROM tally_stock_items WHERE tally_guid = ?").get(context.componentGuid) as any).id);
    const productId = Number((context.host.db.prepare("SELECT id FROM tally_stock_items WHERE tally_guid = ?").get(context.productGuid) as any).id);
    const timestamp = new Date().toISOString();
    context.host.db.prepare(`
      INSERT INTO planning_product_orders(id, external_reference, product_item_id, quantity, required_date, status, notes, created_at, updated_at)
      VALUES ('ORDER-1', 'PO-EXEC-1', ?, 2, '2026-06-30', 'CONFIRMED', '', ?, ?)
    `).run(productId, timestamp, timestamp);
    context.host.db.prepare(`
      INSERT INTO planning_reservations(id, product_order_id, component_item_id, required_quantity, reserved_quantity, status, created_at, updated_at)
      VALUES ('RES-1', 'ORDER-1', ?, 4, 4, 'ACTIVE', ?, ?)
    `).run(componentId, timestamp, timestamp);
    context.operations.releaseProductOrder("ORDER-1", "release-1", "Start build", context.actor);
    const issueInput = {
      clientTransactionId: "issue-production",
      boxId: "",
      tallyItemGuid: context.componentGuid,
      destinationTallyItemGuid: context.productGuid,
      quantity: 3,
      productOrderId: "ORDER-1",
      additionalConsumption: true,
      notes: "Extra trial consumption",
    };
    const issue = context.stores.recordMaterialOut(issueInput);
    context.operations.registerMaterialOut(issueInput, issue, context.actor);
    assert.equal(Number((context.host.db.prepare(
      "SELECT reserved_quantity FROM planning_reservations WHERE id = 'RES-1'",
    ).get() as any).reserved_quantity), 1);
    context.planning.saveProductOrder({
      id: "ORDER-1",
      externalReference: "PO-EXEC-1",
      productTallyGuid: context.productGuid,
      quantity: 2,
      requiredDate: "2026-06-30",
      workflowStateId: "pcb-soldering",
    });
    assert.equal(Number((context.host.db.prepare(
      "SELECT reserved_quantity FROM planning_reservations WHERE id = 'RES-1'",
    ).get() as any).reserved_quantity), 1);
    context.operations.productionReturn({
      clientTransactionId: "production-return",
      tallyItemGuid: context.componentGuid,
      quantity: 1,
      originalMovementId: context.operations.getState().movements.find((movement) => movement.movementType === "MATERIAL_ISSUE")?.id,
      productOrderId: "ORDER-1",
      targetCondition: "AVAILABLE",
    }, context.actor);
    context.operations.productionReturn({
      clientTransactionId: "unlinked-production-return",
      tallyItemGuid: context.componentGuid,
      quantity: 1,
      targetCondition: "FAULTY",
      explanation: "Material found after the issue paperwork was unavailable",
    }, context.actor);
    assert.ok(context.operations.getState().balances.some((entry) => entry.tallyItemGuid === context.componentGuid && entry.condition === "FAULTY" && entry.quantity > 0));
    const completion = context.operations.productionCompletion({
      clientTransactionId: "completion-1",
      productOrderId: "ORDER-1",
      tallyItemGuid: context.productGuid,
      completedQuantity: 2,
      availableQuantity: 1,
      faultyQuantity: 1,
      batchNumber: "FG-BATCH",
      availableSerialNumbers: ["FG-1"],
      faultySerialNumbers: ["FG-2"],
    }, context.actor);
    assert.equal(completion.finishedQuantity, 1);
    assert.equal(completion.faultyFinishedQuantity, 1);
    assert.equal(completion.expectedComponents[0]?.issuedQuantity, 3);
    assert.equal(completion.expectedComponents[0]?.returnedQuantity, 1);
    const request = context.operations.initiateCustomerReturn({
      clientTransactionId: "customer-return-request",
      externalReference: "SALE-1",
      tallyItemGuid: context.productGuid,
      quantity: 1,
      serialNumbers: ["CUSTOMER-FG-1"],
    }, context.actor);
    context.operations.receiveCustomerReturn({
      clientTransactionId: "customer-return-receive",
      returnId: String((request as any).id),
      condition: "PENDING_INSPECTION",
      batchNumber: "RETURN-BATCH",
      serialNumbers: ["CUSTOMER-FG-1"],
    }, context.actor);
    const firstException = context.operations.recordSyncException({
      clientTransactionId: "offline-duplicate",
      deviceId: "DEVICE-1",
      operator: "Store User",
      localTimestamp: timestamp,
      operationType: "MATERIAL_OUT",
      tallyItemGuid: context.componentGuid,
      requestedQuantity: 99,
      reason: "Insufficient available stock",
      payload: issueInput,
    });
    const secondException = context.operations.recordSyncException({
      clientTransactionId: "offline-duplicate",
      deviceId: "DEVICE-1",
      operator: "Store User",
      localTimestamp: timestamp,
      operationType: "MATERIAL_OUT",
      tallyItemGuid: context.componentGuid,
      requestedQuantity: 99,
      reason: "Insufficient available stock",
      payload: issueInput,
    });
    assert.equal(firstException.id, secondException.id);
    context.operations.recordAuthorizedShortage(firstException, "authorized-shortage", "Approved exception", context.actor);
    assert.ok(context.operations.getState().movements.some((movement) => movement.status === "EXCEPTION"));
    const completionMovement = context.operations.getState().movements.find((movement) => movement.movementType === "PRODUCTION_COMPLETION");
    assert.ok(completionMovement);
    const reversed = context.operations.reverseMovement({
      clientTransactionId: "reverse-completion",
      movementId: completionMovement.id,
      quantity: 1,
      reason: "Incorrect finished-goods completion",
      serialNumbers: ["FG-1"],
    }, context.actor);
    assert.equal(reversed.movementType, "TRANSACTION_REVERSAL");
    const repeated = context.operations.reverseMovement({
      clientTransactionId: "reverse-completion",
      movementId: completionMovement.id,
      quantity: 1,
      reason: "Incorrect finished-goods completion",
      serialNumbers: ["FG-1"],
    }, context.actor);
    assert.equal(repeated.id, reversed.id);
  } finally {
    closeContext(context);
  }
});
