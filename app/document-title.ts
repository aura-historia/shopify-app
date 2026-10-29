export const APP_TITLE = "Aura Historia Partner Connect";

// Keep titles static. Public callback and login URLs carry OAuth codes, state
// and error text, none of which may reach browser tabs, history or bookmarks.
export function documentTitle(page: string) {
  return `${page} · ${APP_TITLE}`;
}
