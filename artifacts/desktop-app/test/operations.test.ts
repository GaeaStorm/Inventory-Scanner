import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as XLSX from "xlsx";

import { ApplicationDatabase } from "../src/database/application-database";
import { OperationsDatabase } from "../src/operations/database";
import { permissionsForRole, requirePermission } from "../src/operations/permissions";
import type { ActorContext, ConditionBalance } from "../src/operations/types";
import { PlanningDatabase, warrantyStatusForSerial } from "../src/planning/database";
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
    context.stores.setCatalogVisibility({
      groupName: "COMPONENTS",
      ignored: false,
    });
    let state = context.stores.getState();
    assert.equal(state.stockItems.find((item) => item.tallyGuid === context.productGuid)?.isProduct, true);
    assert.equal(state.stockItems.find((item) => item.tallyGuid === context.componentGuid)?.isProduct, false);
    assert.equal(state.stockItems.find((item) => item.tallyGuid === context.componentGuid)?.primaryGroupName, "COMPONENTS");
    assert.equal(state.stockItems.find((item) => item.tallyGuid === context.componentGuid)?.secondaryGroupName, "RESISTORS");
    assert.ok(state.catalogGroups.some((group) => group.name === "COMPONENTS" && group.type === "PRIMARY"));
    assert.ok(state.catalogGroups.some((group) => group.name === "RESISTORS" && group.type === "SECONDARY" && group.primaryName === "COMPONENTS"));

    context.stores.setCatalogVisibility({
      groupName: "COMPONENTS",
      ignored: true,
    });
    state = context.stores.getState();
    assert.equal(state.stockItems.find((item) => item.tallyGuid === context.componentGuid)?.ignored, true);
    assert.equal(context.planning.getState().items.some((item) => item.tallyItemGuid === context.componentGuid), false);
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
    assert.equal(context.operations.moduleVersion, 5);
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
    assert.deepEqual(migrationRows.map((row) => Number(row.version)), [1, 2, 3, 4, 5]);
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

test("role permissions are enforced independently of renderer visibility", () => {
  const store: ActorContext = { userId: "u-store", displayName: "Store", username: "store", role: "STORE", auditIdentity: "STORE" };
  const sales: ActorContext = { userId: "u-sales", displayName: "Sales", username: "sales", role: "SALES", auditIdentity: "SALES" };
  assert.ok(permissionsForRole("STORE").includes("STOCK_COUNT"));
  assert.ok(permissionsForRole("ACCOUNTS").includes("TALLY_REVIEW"));
  assert.ok(permissionsForRole("PRODUCTION").includes("PRODUCTION_EXECUTE"));
  assert.ok(permissionsForRole("SALES").includes("CUSTOMER_RETURN_INITIATE"));
  assert.equal(requirePermission(store, "RECEIVE_MATERIAL"), store);
  assert.throws(() => requirePermission(sales, "STOCK_ADJUST"), /does not have permission/);
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
