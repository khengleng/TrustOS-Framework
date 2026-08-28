import type { NavigationItem } from '@trustos/template-sdk';

/**
 * The mini app menu.
 *
 * Fetched from the API rather than hardcoded here, and filtered *there* by permission before it
 * is sent. A menu assembled in the browser shows every screen and lets the API refuse them one at
 * a time, which teaches users that half the product is broken and tells an attacker the shape of
 * the product.
 *
 * The fallback below is what renders before the fetch returns, and it contains only screens every
 * signed-in user can reach.
 */

export const FALLBACK_MENU: NavigationItem[] = [
  { key: 'home', label: 'Home', href: '/', icon: 'home', order: 0 },
  { key: 'profile', label: 'Profile', href: '/profile', icon: 'user', order: 1 },
  { key: 'settings', label: 'Settings', href: '/settings', icon: 'settings', order: 2 },
];

export async function fetchMenu(apiBaseUrl: string): Promise<NavigationItem[]> {
  try {
    const response = await fetch(`${apiBaseUrl}/miniapp/menu`, { credentials: 'include' });
    if (!response.ok) return FALLBACK_MENU;

    return (await response.json()) as NavigationItem[];
  } catch {
    // A menu that throws leaves a blank screen. The fallback is always reachable.
    return FALLBACK_MENU;
  }
}
