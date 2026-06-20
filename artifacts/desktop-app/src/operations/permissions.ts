import type { ActorContext, Permission, UserRole } from "./types";

const allPermissions: Permission[] = [
  "AUTH_MANAGE_USERS", "CATALOG_MANAGE", "RECEIVE_MATERIAL", "INSPECT_STOCK",
  "MARK_FAULTY", "SUPPLIER_RETURN", "MATERIAL_ISSUE", "PRODUCTION_RETURN",
  "STOCK_COUNT", "STOCK_ADJUST", "SCRAP_STOCK", "SYNC_EXCEPTION_RESOLVE",
  "QR_MANAGE", "PURCHASING_MANAGE", "TALLY_REVIEW", "RESTOCK_VIEW",
  "RESTOCK_MANAGE", "BOM_MANAGE", "PRODUCT_ORDER_MANAGE", "PRODUCTION_EXECUTE",
  "CUSTOMER_RETURN_INITIATE", "CUSTOMER_RETURN_RECEIVE", "TRANSACTION_REVERSE",
  "SETTINGS_MANAGE", "INVENTORY_VIEW",
];

const permissionsByRole: Record<UserRole, Permission[]> = {
  STORE: [
    "RECEIVE_MATERIAL", "INSPECT_STOCK", "MARK_FAULTY", "SUPPLIER_RETURN",
    "MATERIAL_ISSUE", "PRODUCTION_RETURN", "STOCK_COUNT", "STOCK_ADJUST",
    "SCRAP_STOCK", "SYNC_EXCEPTION_RESOLVE", "QR_MANAGE",
    "CUSTOMER_RETURN_RECEIVE", "INVENTORY_VIEW", "RESTOCK_VIEW",
  ],
  ACCOUNTS: [
    "PURCHASING_MANAGE", "TALLY_REVIEW", "RESTOCK_VIEW", "RESTOCK_MANAGE",
    "INVENTORY_VIEW",
  ],
  PRODUCTION: [
    "MATERIAL_ISSUE", "PRODUCTION_RETURN", "SCRAP_STOCK", "PRODUCT_ORDER_MANAGE",
    "PRODUCTION_EXECUTE", "INVENTORY_VIEW", "RESTOCK_VIEW",
  ],
  SALES: [
    "CUSTOMER_RETURN_INITIATE", "INVENTORY_VIEW", "RESTOCK_VIEW",
  ],
  ADMIN: allPermissions,
};

export function permissionsForRole(role: UserRole): Permission[] {
  return [...permissionsByRole[role]];
}

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return permissionsByRole[role].includes(permission);
}

export function requirePermission(actor: ActorContext | null | undefined, permission: Permission): ActorContext {
  if (!actor) throw new Error("Sign in before performing this operation.");
  if (!hasPermission(actor.role, permission)) {
    throw new Error(`${actor.role} does not have permission to perform this operation.`);
  }
  return actor;
}
