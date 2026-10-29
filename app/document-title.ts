export const APP_TITLE = "Aura Historia Partner Connect";

// Keep titles static. Public login and callback URLs carry OAuth codes, state
// and attacker-controllable error text, none of which belongs in a title.
export function documentTitle(page: string) {
  return `${page} · ${APP_TITLE}`;
}
