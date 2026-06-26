import type { DatabaseSync } from "node:sqlite";

import type { ActorContext, Permission, UserRole } from "./types";

export const allPermissions: Permission[] = [
  "AUTH_MANAGE_USERS", "CATALOG_MANAGE", "RECEIVE_MATERIAL", "INSPECT_STOCK",
  "MARK_FAULTY", "SUPPLIER_RETURN", "MATERIAL_ISSUE", "PRODUCTION_RETURN",
  "STOCK_COUNT", "STOCK_ADJUST", "SCRAP_STOCK", "SYNC_EXCEPTION_RESOLVE",
  "QR_MANAGE", "SCANNER_PAIRING_MANAGE", "PURCHASING_MANAGE", "TALLY_REVIEW", "RESTOCK_VIEW",
  "RESTOCK_MANAGE", "BOM_MANAGE", "PRODUCT_ORDER_MANAGE", "PRODUCTION_EXECUTE",
  "CUSTOMER_RETURN_INITIATE", "CUSTOMER_RETURN_RECEIVE", "TRANSACTION_REVERSE",
  "SETTINGS_MANAGE", "INVENTORY_VIEW",
  "SALES_ORDER_VIEW", "SALES_ORDER_APPROVE_PO", "SALES_ORDER_EDIT_CRF",
  "SALES_ORDER_SUBMIT_CRF", "SALES_ORDER_APPROVE_CRF_ACCOUNTS",
  "SALES_ORDER_APPROVE_CRF_SALES", "SALES_ORDER_CHECKLIST_CONFIGURE",
  "SALES_ORDER_CHECKLIST_WAIVE", "SALES_ORDER_LINE_PROGRESS", "SALES_ORDER_PRINT_CRF",
];

/**
 * Default role->permission grants. Used only to seed ops_role_permissions on
 * first migration (and as the starting point shown when an admin creates a
 * new system-role row again after a reset) — at runtime, permissionsForRole()
 * always reads the database, never this map directly.
 */
export const defaultPermissionsByRole: Record<UserRole, Permission[]> = {
  STORE: [
    "RECEIVE_MATERIAL", "INSPECT_STOCK", "MARK_FAULTY", "SUPPLIER_RETURN",
    "MATERIAL_ISSUE", "PRODUCTION_RETURN", "STOCK_COUNT", "STOCK_ADJUST",
    "SCRAP_STOCK", "SYNC_EXCEPTION_RESOLVE", "QR_MANAGE", "SCANNER_PAIRING_MANAGE",
    "CUSTOMER_RETURN_RECEIVE", "INVENTORY_VIEW", "RESTOCK_VIEW",
    "SALES_ORDER_VIEW", "SALES_ORDER_LINE_PROGRESS",
  ],
  ACCOUNTS: [
    "PURCHASING_MANAGE", "TALLY_REVIEW", "RESTOCK_VIEW", "RESTOCK_MANAGE",
    "INVENTORY_VIEW",
    "SALES_ORDER_VIEW", "SALES_ORDER_APPROVE_PO", "SALES_ORDER_APPROVE_CRF_ACCOUNTS",
  ],
  PRODUCTION: [
    "MATERIAL_ISSUE", "PRODUCTION_RETURN", "SCRAP_STOCK", "PRODUCT_ORDER_MANAGE",
    "PRODUCTION_EXECUTE", "INVENTORY_VIEW", "RESTOCK_VIEW",
    "SALES_ORDER_VIEW", "SALES_ORDER_LINE_PROGRESS",
  ],
  SALES: [
    "CUSTOMER_RETURN_INITIATE", "INVENTORY_VIEW", "RESTOCK_VIEW",
    "SALES_ORDER_VIEW", "SALES_ORDER_EDIT_CRF", "SALES_ORDER_SUBMIT_CRF",
    "SALES_ORDER_APPROVE_CRF_SALES", "SALES_ORDER_PRINT_CRF",
  ],
  ADMIN: allPermissions,
};

/** Reads the admin-configurable mapping. Empty result for a role with no granted permissions (e.g. a brand-new custom role) is a valid, intentional answer, not a fallback condition. */
export function permissionsForRole(db: DatabaseSync, role: UserRole): Permission[] {
  const rows = db.prepare(
    "SELECT permission FROM ops_role_permissions WHERE role_name = ? AND enabled = 1",
  ).all(role) as Array<{ permission: string }>;
  return rows.map((row) => row.permission as Permission);
}

export function hasPermission(db: DatabaseSync, role: UserRole, permission: Permission): boolean {
  return permissionsForRole(db, role).includes(permission);
}

/**
 * Drops any permission that is restricted to a set of named computers when
 * the caller's computer isn't one of them. A permission with no restriction
 * rows at all is always kept — restriction is opt-in per permission.
 */
export function filterByComputerRestriction(db: DatabaseSync, permissions: Permission[], computerName: string): Permission[] {
  if (permissions.length === 0) return permissions;
  const restrictedPermissions = new Set(
    (db.prepare("SELECT DISTINCT permission FROM ops_permission_computer_restrictions").all() as Array<{ permission: string }>)
      .map((row) => row.permission),
  );
  if (restrictedPermissions.size === 0) return permissions;
  const normalizedComputerName = computerName.trim().toLocaleLowerCase();
  return permissions.filter((permission) => {
    if (!restrictedPermissions.has(permission)) return true;
    const allowedComputers = (db.prepare(
      "SELECT computer_name FROM ops_permission_computer_restrictions WHERE permission = ?",
    ).all(permission) as Array<{ computer_name: string }>).map((row) => row.computer_name.trim().toLocaleLowerCase());
    return allowedComputers.includes(normalizedComputerName);
  });
}

/** The single entry point actor-resolution should use: role permissions, then computer restrictions applied on top. */
export function resolveActorPermissions(db: DatabaseSync, role: UserRole, computerName: string): Permission[] {
  return filterByComputerRestriction(db, permissionsForRole(db, role), computerName);
}

export function requirePermission(actor: ActorContext | null | undefined, permission: Permission): ActorContext {
  if (!actor) throw new Error("Sign in before performing this operation.");
  if (!actor.permissions?.includes(permission)) {
    throw new Error(`${actor.role} does not have permission to perform this operation.`);
  }
  return actor;
}
