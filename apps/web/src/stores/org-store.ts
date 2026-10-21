import { create } from 'zustand';
import type { Organization } from '@/lib/api/types';

type OrgState = {
  organizations: Organization[];
  currentOrgId: string | null;
  setOrganizations: (orgs: Organization[]) => void;
  setCurrentOrg: (orgId: string) => void;
};

export const useOrgStore = create<OrgState>((set) => ({
  organizations: [],
  currentOrgId: null,
  setOrganizations: (organizations) =>
    set((s) => ({ organizations, currentOrgId: s.currentOrgId ?? organizations[0]?.id ?? null })),
  setCurrentOrg: (currentOrgId) => set({ currentOrgId }),
}));

type UiState = { sidebarOpen: boolean; toggleSidebar: () => void };

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}));
