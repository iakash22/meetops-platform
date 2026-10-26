// Kept out of settings-page.tsx so the router can validate ?tab without loading the page chunk.
export const SETTINGS_TABS = ['employees', 'teams', 'integrations', 'consent'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export type SettingsSearch = { tab?: SettingsTab };

/** `?tab=` is untrusted: anything but a known tab falls back to the default. */
export function parseSettingsSearch(search: Record<string, unknown>): SettingsSearch {
  const tab = SETTINGS_TABS.find((t) => t === search.tab);
  return tab ? { tab } : {};
}
