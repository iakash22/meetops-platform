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

type UiState = { sidebarOpen: boolean; toggleSidebar: () => void };

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}));
