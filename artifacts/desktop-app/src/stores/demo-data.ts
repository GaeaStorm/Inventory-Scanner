import type { TallyStoresSnapshot } from "../tally/types";

function dateOffset(days: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function stockItem(
  guid: string,
  name: string,
  parent: string,
  closingQuantity: number,
  hasBom = false,
) {
  return {
    code: guid.replace("DEMO:ITEM:", ""),
    name,
    guid,
    alterId: "1",
    parent,
    category: "",
    partNumber: "",
    description: "Demo Stock Item — replace by synchronizing TallyPrime.",
    openingBalance: "",
    closingBalance: String(closingQuantity),
    openingQuantity: 0,
    closingQuantity,
    openingValue: "",
    closingValue: "",
    openingValueNumber: 0,
    closingValueNumber: null,
    standardCost: "",
    standardPrice: "",
    hasBom,
  };
}

export function createDemoStoresSnapshot(): TallyStoresSnapshot {
  const syncedAt = new Date().toISOString();
  const firstReceiptDate = dateOffset(-30);
  const secondReceiptDate = dateOffset(-12);
  const poDate = dateOffset(-35);

  const items = {
    assembly: stockItem("DEMO:ITEM:FG-001", "Demo Product Assembly", "Finished Products", 0, true),
    serviceKit: stockItem("DEMO:ITEM:FG-002", "Demo Service Kit", "Finished Products", 0, true),
    bolt: stockItem("DEMO:ITEM:RM-001", "M4 Hex Bolt", "Components", 120),
    spacer: stockItem("DEMO:ITEM:RM-002", "Nylon Spacer", "Components", 80),
    pcb: stockItem("DEMO:ITEM:RM-003", "Control PCB", "Components", 24),
    cable: stockItem("DEMO:ITEM:RM-004", "Power Cable", "Components", 45),
    bracket: stockItem("DEMO:ITEM:RM-005", "Aluminium Bracket", "Components", 32),
    insert: stockItem("DEMO:ITEM:RM-006", "Packaging Insert", "Components", 60),
  };

  const line = (
    item: (typeof items)[keyof typeof items],
    quantity: number,
    rate: number,
    orderNumber: string,
  ) => ({
    itemName: item.name,
    itemGuid: item.guid,
    quantity,
    rate,
    value: quantity * rate,
    orderNumber,
    trackingNumber: "",
  });

  return {
    schemaVersion: 2,
    syncedAt,
    endpoint: "demo://local",
    company: "Akademika Demo Company",
    companyGuid: "DEMO:COMPANY:AKADEMIKA",
    companies: [
      {
        name: "Akademika Demo Company",
        guid: "DEMO:COMPANY:AKADEMIKA",
        booksFrom: dateOffset(-365),
        startingFrom: dateOffset(-365),
        endingAt: dateOffset(365),
      },
    ],
    stockGroups: [
      { name: "Components", parent: "Primary", guid: "DEMO:GROUP:COMPONENTS", alterId: "1" },
      { name: "Finished Products", parent: "Primary", guid: "DEMO:GROUP:FINISHED", alterId: "1" },
    ],
    stockCategories: [],
    stockItems: Object.values(items),
    bomComponents: [
      {
        productCode: items.assembly.code,
        productName: items.assembly.name,
        productGuid: items.assembly.guid,
        bomName: "Demo Assembly BOM",
        componentCode: items.bolt.code,
        componentName: items.bolt.name,
        componentGuid: items.bolt.guid,
        quantity: "4",
        quantityNumber: 4,
      },
      {
        productCode: items.assembly.code,
        productName: items.assembly.name,
        productGuid: items.assembly.guid,
        bomName: "Demo Assembly BOM",
        componentCode: items.spacer.code,
        componentName: items.spacer.name,
        componentGuid: items.spacer.guid,
        quantity: "4",
        quantityNumber: 4,
      },
      {
        productCode: items.assembly.code,
        productName: items.assembly.name,
        productGuid: items.assembly.guid,
        bomName: "Demo Assembly BOM",
        componentCode: items.pcb.code,
        componentName: items.pcb.name,
        componentGuid: items.pcb.guid,
        quantity: "1",
        quantityNumber: 1,
      },
      {
        productCode: items.assembly.code,
        productName: items.assembly.name,
        productGuid: items.assembly.guid,
        bomName: "Demo Assembly BOM",
        componentCode: items.bracket.code,
        componentName: items.bracket.name,
        componentGuid: items.bracket.guid,
        quantity: "2",
        quantityNumber: 2,
      },
      {
        productCode: items.serviceKit.code,
        productName: items.serviceKit.name,
        productGuid: items.serviceKit.guid,
        bomName: "Demo Service Kit BOM",
        componentCode: items.cable.code,
        componentName: items.cable.name,
        componentGuid: items.cable.guid,
        quantity: "1",
        quantityNumber: 1,
      },
      {
        productCode: items.serviceKit.code,
        productName: items.serviceKit.name,
        productGuid: items.serviceKit.guid,
        bomName: "Demo Service Kit BOM",
        componentCode: items.insert.code,
        componentName: items.insert.name,
        componentGuid: items.insert.guid,
        quantity: "1",
        quantityNumber: 1,
      },
    ],
    suppliers: [
      { name: "Demo Supplier A", guid: "DEMO:SUPPLIER:A", alterId: "1", parent: "Sundry Creditors" },
      { name: "Demo Supplier B", guid: "DEMO:SUPPLIER:B", alterId: "1", parent: "Sundry Creditors" },
    ],
    purchaseOrders: [
      {
        guid: "DEMO:PO:1001",
        voucherNumber: "PO-DEMO-1001",
        voucherDate: poDate,
        supplierName: "Demo Supplier A",
        supplierGuid: "DEMO:SUPPLIER:A",
        reference: "Demo open PO",
        lines: [
          line(items.bolt, 100, 2.5, "PO-DEMO-1001"),
          line(items.spacer, 80, 1.25, "PO-DEMO-1001"),
          line(items.pcb, 20, 425, "PO-DEMO-1001"),
          line(items.bracket, 30, 35, "PO-DEMO-1001"),
        ],
      },
      {
        guid: "DEMO:PO:1002",
        voucherNumber: "PO-DEMO-1002",
        voucherDate: dateOffset(-18),
        supplierName: "Demo Supplier B",
        supplierGuid: "DEMO:SUPPLIER:B",
        reference: "Demo open PO",
        lines: [
          line(items.bolt, 90, 2.75, "PO-DEMO-1002"),
          line(items.spacer, 70, 1.4, "PO-DEMO-1002"),
          line(items.pcb, 18, 440, "PO-DEMO-1002"),
          line(items.cable, 75, 85, "PO-DEMO-1002"),
          line(items.bracket, 28, 38, "PO-DEMO-1002"),
          line(items.insert, 100, 8, "PO-DEMO-1002"),
        ],
      },
    ],
    grns: [
      {
        guid: "DEMO:GRN:101",
        voucherNumber: "GRN-DEMO-101",
        voucherDate: firstReceiptDate,
        supplierName: "Demo Supplier A",
        supplierGuid: "DEMO:SUPPLIER:A",
        poNumber: "PO-DEMO-1001",
        trackingNumber: "DEMO-TRACK-101",
        challanNumber: "CH-DEMO-101",
        challanDate: firstReceiptDate,
        lines: [
          line(items.bolt, 70, 2.5, "PO-DEMO-1001"),
          line(items.spacer, 50, 1.25, "PO-DEMO-1001"),
          line(items.pcb, 14, 425, "PO-DEMO-1001"),
          line(items.bracket, 20, 35, "PO-DEMO-1001"),
        ],
      },
      {
        guid: "DEMO:GRN:144",
        voucherNumber: "GRN-DEMO-144",
        voucherDate: secondReceiptDate,
        supplierName: "Demo Supplier B",
        supplierGuid: "DEMO:SUPPLIER:B",
        poNumber: "PO-DEMO-1002",
        trackingNumber: "DEMO-TRACK-144",
        challanNumber: "CH-DEMO-144",
        challanDate: secondReceiptDate,
        lines: [
          line(items.bolt, 50, 2.75, "PO-DEMO-1002"),
          line(items.spacer, 30, 1.4, "PO-DEMO-1002"),
          line(items.pcb, 10, 440, "PO-DEMO-1002"),
          line(items.cable, 45, 85, "PO-DEMO-1002"),
          line(items.bracket, 12, 38, "PO-DEMO-1002"),
          line(items.insert, 60, 8, "PO-DEMO-1002"),
        ],
      },
    ],
    warnings: [
      "Demo data is active because Tally returned no Stock Items. Synchronizing a company with real Stock Items replaces this demo database after creating a validated backup.",
    ],
  };
}
