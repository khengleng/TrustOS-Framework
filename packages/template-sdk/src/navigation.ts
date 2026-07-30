import type { PermissionCheck } from './permissions';

/**
 * Navigation.
 *
 * A navigation tree is **data**, and the single reason it is data rather than JSX is that
 * navigation is the one part of an application whose shape must be known on the server. A menu
 * built in the browser from hardcoded links shows the user every screen and lets the API refuse
 * them one at a time — which teaches users that half the product is broken, and leaks the shape
 * of the product to someone who should not see it.
 *
 * So the tree is filtered by permission *before* it is rendered, by the same permission keys the
 * API enforces with. The menu and the guard cannot disagree, because they read the same list.
 *
 * There is deliberately no component here. Templates generate a Next.js admin and a NestJS API
 * out of one SDK; anything importing React would be unusable in half of that.
 */

export interface NavigationItem {
  /** Stable key. Used for the active check and as the React key — never displayed. */
  key: string;
  label: string;
  /** Route path, relative to the application root. Absent for a pure grouping node. */
  href?: string;
  /** Icon name, resolved by the rendering layer. The SDK never owns an icon set. */
  icon?: string;
  /**
   * Permission required to see this item.
   *
   * One key, not a list: an item the user reaches two different ways is two items. An item
   * with no permission is visible to every authenticated user, which is a decision worth
   * making explicitly rather than by omission.
   */
  permission?: string;
  /** A count or status shown beside the label. Resolved by the caller, not fetched here. */
  badge?: string | number;
  children?: NavigationItem[];
  /**
   * Sort weight within its parent. Lower comes first; equal weights keep declaration order.
   *
   * Explicit rather than alphabetical because navigation order is a product decision — the
   * most-used screen goes first, and it is rarely the one starting with "A".
   */
  order?: number;
}

export interface NavigationSection {
  key: string;
  label: string;
  items: NavigationItem[];
  order?: number;
}

/**
 * Removes every item the actor may not reach.
 *
 * A parent with a permission is removed whole — its children go with it, whatever they
 * individually allow, because a child of a hidden parent is unreachable and listing it would be
 * a lie. A grouping node that ends up with no visible children and no `href` of its own is
 * dropped too: an empty menu heading is a dead end that looks like a bug.
 */
export function filterNavigation(items: NavigationItem[], can: PermissionCheck): NavigationItem[] {
  const visible: NavigationItem[] = [];

  for (const item of items) {
    if (item.permission && !can(item.permission)) continue;

    const children = item.children ? filterNavigation(item.children, can) : undefined;

    if (children && children.length === 0 && !item.href) continue;

    visible.push(children ? { ...item, children } : item);
  }

  return sortNavigation(visible);
}

/** Stable sort by `order`, then declaration order. */
export function sortNavigation(items: NavigationItem[]): NavigationItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0) || a.index - b.index)
    .map((entry) => entry.item);
}

export function filterSections(
  sections: NavigationSection[],
  can: PermissionCheck,
): NavigationSection[] {
  return sections
    .map((section) => ({ ...section, items: filterNavigation(section.items, can) }))
    .filter((section) => section.items.length > 0)
    .map((section, index) => ({ section, index }))
    .sort((a, b) => (a.section.order ?? 0) - (b.section.order ?? 0) || a.index - b.index)
    .map((entry) => entry.section);
}

/**
 * The item matching a path, preferring the longest match.
 *
 * Longest-prefix rather than first-match: with `/orders` and `/orders/refunds` both registered,
 * first-match highlights "Orders" while the user is looking at refunds. Everyone notices, nobody
 * files it.
 */
export function findActiveItem(items: NavigationItem[], pathname: string): NavigationItem | null {
  let best: NavigationItem | null = null;

  const walk = (nodes: NavigationItem[]): void => {
    for (const node of nodes) {
      if (node.href && isPathActive(node.href, pathname)) {
        if (!best || node.href.length > (best.href?.length ?? 0)) best = node;
      }
      if (node.children) walk(node.children);
    }
  };

  walk(items);
  return best;
}

/** True when `pathname` is `href` or a descendant of it. `/order` must not match `/orders`. */
export function isPathActive(href: string, pathname: string): boolean {
  if (href === pathname) return true;
  return pathname.startsWith(href.endsWith('/') ? href : `${href}/`);
}

export interface Breadcrumb {
  label: string;
  href?: string;
}

/**
 * The trail from the root to the active item.
 *
 * The last crumb has no `href` — it is the page you are on, and a link to where you already are
 * is a link users click once and never again.
 */
export function breadcrumbsFor(items: NavigationItem[], pathname: string): Breadcrumb[] {
  const trail: NavigationItem[] = [];

  const walk = (nodes: NavigationItem[], ancestors: NavigationItem[]): boolean => {
    for (const node of nodes) {
      const path = [...ancestors, node];
      if (node.href && isPathActive(node.href, pathname) && node.href === pathname) {
        trail.push(...path);
        return true;
      }
      if (node.children && walk(node.children, path)) return true;
    }
    return false;
  };

  walk(items, []);

  return trail.map((item, index) => ({
    label: item.label,
    href: index === trail.length - 1 ? undefined : item.href,
  }));
}
