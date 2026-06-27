import type { Permission } from "../operations/types";

export type ApprovalEntityType = "SALES_ORDER_PO" | "SALES_ORDER_CRF" | "SALES_ORDER_STAGE";

/**
 * Which permissions must each contribute one APPROVE decision, from a
 * distinct user, before a request is satisfied. Permission-based rather
 * than role-name-based so a custom role granted the right permission
 * (e.g. a future "SALES_JUNIOR" role with SALES_ORDER_APPROVE_CRF_SALES)
 * can fill that slot without any code change.
 */
export const APPROVAL_PERMISSION_REQUIREMENTS: Record<ApprovalEntityType, Permission[]> = {
  SALES_ORDER_PO: ["SALES_ORDER_APPROVE_PO"],
  SALES_ORDER_CRF: ["SALES_ORDER_APPROVE_CRF_ACCOUNTS", "SALES_ORDER_APPROVE_CRF_SALES"],
  SALES_ORDER_STAGE: [],
};

export interface ApprovalDecisionRecord {
  decidedByUserId: string;
  /** The specific required-permission slot this decision was recorded against — fixed at decision time, never re-evaluated against later permission changes. */
  qualifyingPermission: Permission | "";
  decision: "APPROVE" | "REJECT";
}

/**
 * A request is satisfied once every required permission slot has an APPROVE
 * decision from a distinct user — one person cannot satisfy two slots, even
 * if they hold both permissions (e.g. an Accounts+Sales dual-hat user or
 * ADMIN), because each decision is pinned to exactly one slot when recorded.
 */
export function isApprovalSatisfied(
  entityType: ApprovalEntityType,
  decisions: ApprovalDecisionRecord[],
  requiredPermissions = APPROVAL_PERMISSION_REQUIREMENTS[entityType],
): boolean {
  const approvals = decisions.filter((decision) => decision.decision === "APPROVE");
  const usedUserIds = new Set<string>();
  for (const permission of requiredPermissions) {
    const match = approvals.find((decision) => decision.qualifyingPermission === permission && !usedUserIds.has(decision.decidedByUserId));
    if (!match) return false;
    usedUserIds.add(match.decidedByUserId);
  }
  return true;
}

export function hasRejection(decisions: ApprovalDecisionRecord[]): boolean {
  return decisions.some((decision) => decision.decision === "REJECT");
}

/** Picks the first required slot the actor qualifies for that no earlier APPROVE decision on this request has already claimed. */
export function pickQualifyingPermission(
  entityType: ApprovalEntityType,
  actorPermissions: Permission[] | undefined,
  existingDecisions: ApprovalDecisionRecord[],
  requiredPermissions = APPROVAL_PERMISSION_REQUIREMENTS[entityType],
): Permission | null {
  const claimedPermissions = new Set(
    existingDecisions.filter((decision) => decision.decision === "APPROVE").map((decision) => decision.qualifyingPermission),
  );
  return requiredPermissions.find((permission) => actorPermissions?.includes(permission) && !claimedPermissions.has(permission)) ?? null;
}
