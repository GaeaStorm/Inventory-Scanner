import type { SalesOrder } from "./types";

export type ChecklistTargetType =
  | "EXACT_ITEM"
  | "GROUP_SUBTREE"
  | "PRIMARY_GROUP"
  | "TOP_LEVEL_LINES"
  | "CHILDREN_OF_MANUFACTURED"
  | "EACH_MANUFACTURED_PRODUCT";

export interface ChecklistRequirementDefinition {
  id: string;
  targetType: ChecklistTargetType;
  targetValue: string;
}

/**
 * Resolves whether a checklist requirement is matched by the order's actual
 * fulfilment lines. Pure function — no DB access — so template edits can be
 * re-evaluated against a frozen SalesOrder snapshot without side effects.
 */
export function resolveChecklistRequirement(
  requirement: ChecklistRequirementDefinition,
  order: SalesOrder,
): boolean {
  const lines = order.fulfilmentLines;
  switch (requirement.targetType) {
    case "EXACT_ITEM":
      return lines.some((line) => line.itemTallyGuid === requirement.targetValue);
    case "PRIMARY_GROUP":
      return lines.some((line) => line.family === requirement.targetValue);
    case "GROUP_SUBTREE":
      return lines.some((line) => line.itemQualifiedName.toLocaleLowerCase().includes(requirement.targetValue.toLocaleLowerCase()));
    case "TOP_LEVEL_LINES":
      return lines.some((line) => !line.parentFulfilmentLineId);
    case "CHILDREN_OF_MANUFACTURED":
      return lines.some((line) =>
        line.parentFulfilmentLineId
        && lines.find((parent) => parent.id === line.parentFulfilmentLineId)?.family === "MANUFACTURED");
    case "EACH_MANUFACTURED_PRODUCT": {
      const manufacturedLines = lines.filter((line) => line.family === "MANUFACTURED");
      if (manufacturedLines.length === 0) return false;
      return manufacturedLines.every((parent) => lines.some((child) => child.parentFulfilmentLineId === parent.id));
    }
    default:
      return false;
  }
}
