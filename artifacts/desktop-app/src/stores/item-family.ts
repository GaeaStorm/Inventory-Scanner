export type ItemFamily = "MANUFACTURED" | "RESALE" | "SERVICE" | "RAW_MATERIAL" | "UNKNOWN";

const FAMILY_BY_PRIMARY_GROUP: Record<string, ItemFamily> = {
  "manufactured products": "MANUFACTURED",
  "resale goods": "RESALE",
  service: "SERVICE",
  "raw materials": "RAW_MATERIAL",
};

/**
 * Classifies an item by the top-level Stock Group in its hierarchy, matching
 * Tally's four confirmed primary groups. Used to derive Sales Order
 * fulfilment-line workflow family from item identity rather than letting
 * users pick a conflicting type manually.
 */
export function resolvePrimaryGroupFamily(groupPath: string[]): ItemFamily {
  const primary = (groupPath[0] ?? "").trim().toLocaleLowerCase();
  return FAMILY_BY_PRIMARY_GROUP[primary] ?? "UNKNOWN";
}

/**
 * Builds the display-only qualified name ("Raw Material > Electronic > IC >
 * SMD > ABCDE"). Never use this value to look up an item — identity is
 * always the GUID/id, this is purely for display and snapshots.
 */
export function formatQualifiedItemName(groupPath: string[], name: string): string {
  const segments = [...groupPath.map((segment) => segment.trim()), name.trim()].filter(Boolean);
  return segments.join(" > ");
}

export interface QualifiedNameCollision {
  qualifiedName: string;
  itemIds: number[];
}

/**
 * Surfaces active items that resolve to the identical qualified name so a
 * sync can flag a real data-entry collision instead of silently allowing
 * two indistinguishable catalogue entries.
 */
export function findQualifiedNameCollisions(
  items: Array<{ id: number; name: string; groupPath: string[] }>,
): QualifiedNameCollision[] {
  const idsByQualifiedName = new Map<string, number[]>();
  for (const item of items) {
    const qualifiedName = formatQualifiedItemName(item.groupPath, item.name);
    const ids = idsByQualifiedName.get(qualifiedName) ?? [];
    ids.push(item.id);
    idsByQualifiedName.set(qualifiedName, ids);
  }
  return [...idsByQualifiedName.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([qualifiedName, itemIds]) => ({ qualifiedName, itemIds }));
}
