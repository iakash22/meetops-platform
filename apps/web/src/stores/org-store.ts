import { create } from 'zustand';
import type { Id, Organization } from '@meetops/contracts';

type OrgState = {
  organizations: Organization[];
  currentOrganizationId: Id | null;
  /** Replace the org list; keep the current org if still present, else use `preferred` or the first. */
  setOrganizations: (orgs: Organization[], preferred?: Id | null) => void;
  setCurrentOrganization: (organizationId: Id) => void;
  reset: () => void;
};

export const useOrgStore = create<OrgState>((set) => ({
  organizations: [],
  currentOrganizationId: null,
  setOrganizations: (organizations, preferred) =>
    set((s) => {
      const has = (id: Id | null | undefined) => !!id && organizations.some((o) => o.id === id);
      const currentOrganizationId = has(s.currentOrganizationId)
        ? s.currentOrganizationId
        : has(preferred)
          ? (preferred ?? null)
          : (organizations[0]?.id ?? null);
      return { organizations, currentOrganizationId };
    }),
  setCurrentOrganization: (currentOrganizationId) => set({ currentOrganizationId }),
  reset: () => set({ organizations: [], currentOrganizationId: null }),
}));

/** localStorage key for the desktop sidebar preference (`'collapsed'` | `'expanded'`). */
export const SIDEBAR_STORAGE_KEY = 'meetops.ui.sidebar';

/** Stored preference; anything missing, unknown or unreadable means expanded. */
export function readSidebarCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(SIDEBAR_STORAGE_KEY) === 'collapsed';
  } catch {
    return false; // storage disabled (privacy mode, sandboxed iframe)
  }
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    // Best effort: the preference just won't survive a reload.
  }
}

type UiState = {
  /** Desktop (lg+) only: icon rail instead of the full sidebar. Persisted. */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /** Below lg: the navigation Sheet. Never persisted. */
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;
};

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: readSidebarCollapsed(),
  toggleSidebar: () =>
    set((s) => {
      const sidebarCollapsed = !s.sidebarCollapsed;
      writeSidebarCollapsed(sidebarCollapsed);
      return { sidebarCollapsed };
    }),
  mobileNavOpen: false,
  setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
}));
