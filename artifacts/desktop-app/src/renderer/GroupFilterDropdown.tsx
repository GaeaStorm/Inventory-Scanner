import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface GroupTreeNode {
  name: string;
  path: string[];
  children: GroupTreeNode[];
  /**
   * "group" (default when omitted) is a real Stock Group. "field" is a
   * specification-field-value pseudo-level appended by appendFieldLeaves —
   * looks identical to a group to the end user, who only thinks in terms of
   * groups and the item name; only the underlying data model knows it's
   * actually a field. "item" is the final leaf for one specific Stock Item.
   */
  kind?: "group" | "field" | "item";
  /** Set only on kind "item" nodes — the unique identity to act on (display names can be duplicated, so the path/name alone is never enough). */
  itemGuid?: string;
  /** Set only on kind "field"/"item" nodes — how many of this node's leading path segments are real Stock Groups (the rest are field values, then the item name). */
  groupDepth?: number;
}

/** Builds a nested tree from flat group-path arrays, e.g. ["Components", "Resistors"]. */
export function buildGroupTree(paths: string[][]): GroupTreeNode[] {
  const roots: GroupTreeNode[] = [];
  const index = new Map<string, GroupTreeNode>();
  for (const path of paths) {
    let siblings = roots;
    let prefix: string[] = [];
    for (const segment of path) {
      if (!segment) break;
      prefix = [...prefix, segment];
      const key = prefix.join(" ").toLocaleLowerCase();
      let node = index.get(key);
      if (!node) {
        node = { name: segment, path: prefix, children: [] };
        index.set(key, node);
        siblings.push(node);
      }
      siblings = node.children;
    }
  }
  const sortTree = (nodes: GroupTreeNode[]) => {
    nodes.sort((left, right) => left.name.localeCompare(right.name));
    nodes.forEach((node) => sortTree(node.children));
  };
  sortTree(roots);
  return roots;
}

/** True when `path` is empty (matches everything) or is a prefix of `candidate`. */
export function groupPathMatches(path: string[], candidate: string[]): boolean {
  if (path.length === 0) return true;
  if (candidate.length < path.length) return false;
  return path.every((segment, index) => segment.toLocaleLowerCase() === candidate[index]?.toLocaleLowerCase());
}

/** A picked node's path plus how many leading segments are real Stock Groups — pass this through from GroupFilterDropdown's onChange so filtering can tell groups, field values, and the item name apart. */
export interface GroupFilterValue {
  path: string[];
  groupDepth: number;
}

export function groupFilterValueFromNode(path: string[], node?: GroupTreeNode): GroupFilterValue {
  return { path, groupDepth: node?.groupDepth ?? path.length };
}

export interface FieldDefinitionLike {
  key: string;
  label: string;
  /** The Stock Group this field belongs to, or "" for the global/Primary scope that applies to every item. */
  groupName: string;
  position: number;
}

/**
 * An item's effective specification fields are cumulative down its Stock
 * Group ancestry: the global ("") scope first, then each ancestor group's
 * own fields in path order, then the item's direct group's own fields.
 * Mirrors stores/database.ts's effectiveFieldDefinitions.
 */
export function effectiveFieldDefinitions<T extends FieldDefinitionLike>(all: T[], groupPath: string[]): T[] {
  const scopes = ["", ...groupPath].map((scope) => scope.toLocaleLowerCase());
  return scopes.flatMap((scope) =>
    all.filter((field) => field.groupName.toLocaleLowerCase() === scope).sort((left, right) => left.position - right.position));
}

/**
 * Field-aware version of groupPathMatches: a filter path may drill past real
 * groups into specification-field values and finally the item's own display
 * name (exactly the levels appendFieldLeaves adds), all selected as if they
 * were ordinary nested groups.
 */
export function itemMatchesFilter(
  filter: GroupFilterValue,
  item: { groupPath: string[]; fieldValues: Record<string, string>; displayName: string },
  fieldDefinitions: FieldDefinitionLike[],
): boolean {
  const { path, groupDepth } = filter;
  if (path.length === 0) return true;
  if (!groupPathMatches(path.slice(0, Math.min(groupDepth, path.length)), item.groupPath)) return false;
  if (path.length <= groupDepth) return true;
  if (item.groupPath.length !== groupDepth) return false;
  const itemFields = effectiveFieldDefinitions(fieldDefinitions, item.groupPath);
  for (let index = groupDepth; index < path.length; index += 1) {
    const fieldIndex = index - groupDepth;
    const expected = fieldIndex < itemFields.length
      ? (item.fieldValues[itemFields[fieldIndex].key]?.trim() || "X")
      : item.displayName;
    if (path[index].toLocaleLowerCase() !== expected.toLocaleLowerCase()) return false;
  }
  return true;
}

/**
 * Opt-in extension: appends specification-field-value levels (then a final
 * item leaf) under each real Stock Group node, so a multi-level picker can
 * browse all the way to "...Switches > Toggle > Non-SMD > 6Pin > Red >
 * Item010". Field levels are fully selectable, just like real groups —
 * callers that care about the distinction can check node.kind. Existing
 * callers of buildGroupTree are unaffected unless they call this too.
 */
export function appendFieldLeaves(
  tree: GroupTreeNode[],
  items: Array<{ groupPath: string[]; fieldValues: Record<string, string>; displayName: string; itemGuid: string }>,
  fieldDefinitions: FieldDefinitionLike[],
): GroupTreeNode[] {
  if (items.length === 0) return tree;
  const findOrCreate = (
    siblings: GroupTreeNode[],
    name: string,
    path: string[],
    kind: "field" | "item",
    groupDepth: number,
    itemGuid?: string,
  ): GroupTreeNode => {
    const key = name.toLocaleLowerCase();
    let node = siblings.find((entry) => entry.kind === kind && entry.name.toLocaleLowerCase() === key
      && (kind !== "item" || entry.itemGuid === itemGuid));
    if (!node) {
      node = { name, path, children: [], kind, groupDepth, itemGuid };
      siblings.push(node);
    }
    return node;
  };
  const groupNodeByPath = new Map<string, GroupTreeNode>();
  const index = (nodes: GroupTreeNode[]) => {
    for (const node of nodes) {
      groupNodeByPath.set(node.path.join(" ").toLocaleLowerCase(), node);
      index(node.children);
    }
  };
  index(tree);
  for (const item of items) {
    if (item.groupPath.length === 0) continue;
    const groupNode = groupNodeByPath.get(item.groupPath.join(" ").toLocaleLowerCase());
    if (!groupNode) continue;
    let siblings = groupNode.children;
    let prefix = [...item.groupPath];
    const groupDepth = item.groupPath.length;
    for (const field of effectiveFieldDefinitions(fieldDefinitions, item.groupPath)) {
      const value = item.fieldValues[field.key]?.trim() || "X";
      prefix = [...prefix, value];
      siblings = findOrCreate(siblings, value, prefix, "field", groupDepth).children;
    }
    findOrCreate(siblings, item.displayName, [...prefix, item.displayName], "item", groupDepth, item.itemGuid);
  }
  return tree;
}

interface Props {
  ariaLabel: string;
  tree: GroupTreeNode[];
  value: string[];
  onChange: (path: string[], node?: GroupTreeNode) => void;
  allLabel?: string;
}

const MENU_WIDTH = 240;
const MENU_MAX_HEIGHT = 320;

export default function GroupFilterDropdown({ ariaLabel, tree, value, onChange, allLabel = "All groups" }: Props) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function isInsideDropdown(target: Node): boolean {
      if (containerRef.current?.contains(target)) return true;
      return target instanceof Element && target.closest(".group-filter-dropdown__portal") != null;
    }
    function onClickOutside(event: MouseEvent) {
      if (!isInsideDropdown(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function choose(path: string[], node?: GroupTreeNode) {
    onChange(path, node);
    setOpen(false);
  }

  function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    // Portaled to document.body and positioned from the trigger's own
    // viewport rect (not a CSS-relative offset), so the menu can never be
    // clipped by an ancestor card's overflow or run off the screen edge.
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      const fitsRight = rect.left + MENU_WIDTH <= window.innerWidth;
      setMenuPosition({
        top: Math.min(rect.bottom + 4, window.innerHeight - MENU_MAX_HEIGHT),
        left: fitsRight ? rect.left : Math.max(0, rect.right - MENU_WIDTH),
      });
    }
    setOpen(true);
  }

  return (
    <div className="group-filter-dropdown" ref={containerRef}>
      <button type="button" className="group-filter-dropdown__trigger" aria-label={ariaLabel} aria-haspopup="true" aria-expanded={open} onClick={toggleOpen}>
        <span>{value.length === 0 ? allLabel : value[value.length - 1]}</span>
        <b className="group-filter-dropdown__caret">▾</b>
      </button>
      {open && menuPosition && createPortal(
        <div
          className="group-filter-dropdown__menu group-filter-dropdown__portal"
          style={{ position: "fixed", top: menuPosition.top, left: menuPosition.left, width: MENU_WIDTH }}
        >
          <button type="button" className={`group-filter-dropdown__item ${value.length === 0 ? "group-filter-dropdown__item--selected" : ""}`} onClick={() => choose([])}>
            {allLabel}
          </button>
          {tree.map((node) => (
            <GroupFilterMenuItem key={node.path.join(" ")} node={node} selected={value} onChoose={choose} />
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

function GroupFilterMenuItem({ node, selected, onChoose }: {
  node: GroupTreeNode;
  selected: string[];
  onChoose: (path: string[], node?: GroupTreeNode) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [submenuPosition, setSubmenuPosition] = useState<{ top: number; left: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const isSelected = selected.join(" ").toLocaleLowerCase() === node.path.join(" ").toLocaleLowerCase();
  const hasChildren = node.children.length > 0;

  function expand() {
    if (!hasChildren) return;
    const rect = rowRef.current?.getBoundingClientRect();
    if (rect) {
      const submenuWidth = 220;
      const fitsRight = rect.right + submenuWidth <= window.innerWidth;
      setSubmenuPosition({
        top: Math.min(rect.top, window.innerHeight - 320),
        left: fitsRight ? rect.right : Math.max(0, rect.left - submenuWidth),
      });
    }
    setExpanded(true);
  }

  return (
    <div
      ref={rowRef}
      className="group-filter-dropdown__row"
      onMouseEnter={expand}
      onMouseLeave={() => setExpanded(false)}
    >
      <button
        type="button"
        className={`group-filter-dropdown__item ${isSelected ? "group-filter-dropdown__item--selected" : ""}`}
        onClick={() => onChoose(node.path, node)}
      >
        <span>{node.name}</span>
        {hasChildren && <b className="group-filter-dropdown__arrow">›</b>}
      </button>
      {hasChildren && expanded && submenuPosition && createPortal(
        <div
          className="group-filter-dropdown__submenu group-filter-dropdown__portal"
          style={{ position: "fixed", top: submenuPosition.top, left: submenuPosition.left }}
          onMouseEnter={expand}
          onMouseLeave={() => setExpanded(false)}
        >
          {node.children.map((child) => (
            <GroupFilterMenuItem key={child.path.join(" ")} node={child} selected={selected} onChoose={onChoose} />
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
