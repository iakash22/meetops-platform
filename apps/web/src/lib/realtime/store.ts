import { create } from 'zustand';
import type { RealtimeStatus } from './client';

type RealtimeState = { status: RealtimeStatus; setStatus: (s: RealtimeStatus) => void };

/** Connection status, read by the polling hooks to decide whether polling is the fallback. */
export const useRealtimeStore = create<RealtimeState>((set) => ({
  status: 'idle',
  setStatus: (status) => set({ status }),
}));

export const isRealtimeConnected = () => useRealtimeStore.getState().status === 'connected';
