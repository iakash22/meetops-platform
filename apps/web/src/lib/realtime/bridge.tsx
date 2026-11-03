import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { applyMeetingStatus, applyTaskUpdate, useOrganizationId } from '@/lib/api/queries';
import { RealtimeClient, type RealtimeClientOptions } from './client';
import { isRealtimeEnabled, realtimeEndpoint } from './flag';
import { useRealtimeStore } from './store';

type BridgeProps = {
  /** Defaults to the VITE_REALTIME_ENABLED flag. */
  enabled?: boolean;
  /** Tests inject a fake socket. */
  createSocket?: RealtimeClientOptions['createSocket'];
};

/**
 * Connects the realtime client while a user has an organization selected, and routes server events
 * into the React Query cache. Renders nothing. With the flag off it never connects (polling only).
 */
export function RealtimeBridge({ enabled = isRealtimeEnabled(), createSocket }: BridgeProps) {
  const queryClient = useQueryClient();
  const organizationId = useOrganizationId();
  const setStatus = useRealtimeStore((s) => s.setStatus);

  useEffect(() => {
    if (!enabled || !organizationId) return;
    let everConnected = false;
    const client = new RealtimeClient({
      ...realtimeEndpoint(),
      createSocket,
      onEvent: (name, payload) => {
        // Events for another org (e.g. right after an org switch) are dropped.
        const org = (payload as { organizationId?: unknown } | null)?.organizationId;
        if (org !== undefined && org !== organizationId) return;
        if (name === 'task:update') applyTaskUpdate(queryClient, payload);
        else if (name === 'meeting:status') applyMeetingStatus(queryClient, payload);
      },
      onStatus: (status) => {
        setStatus(status);
        if (status !== 'connected') return;
        // Anything emitted while disconnected was missed: refetch this org's data once.
        if (everConnected)
          void queryClient.invalidateQueries({ queryKey: ['orgs', organizationId] });
        everConnected = true;
      },
    });
    client.start();
    return () => {
      client.stop();
      setStatus('idle');
    };
  }, [enabled, organizationId, queryClient, setStatus, createSocket]);

  return null;
}
