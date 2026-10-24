import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';
import type { MeetingStatusEvent, ServerToClientEvents, TranscriptionProgressEvent } from '@meetops/contracts';
import type { RealtimePublisher } from './processor.js';

export const orgRoom = (organizationId: string) => `org:${organizationId}`;
/** Must match apps/realtime: org-prefixed meeting room. */
export const meetingRoom = (organizationId: string, meetingId: string) => `org:${organizationId}:meeting:${meetingId}`;

type EmitterLike = { to(room: string | string[]): { emit(event: string, payload: unknown): unknown } };

/** Publishes to org:{org}:meeting:{id} and org:{org} (one delivery per socket via room union). */
export function createRealtimePublisher(emitter: EmitterLike): RealtimePublisher {
  const send = (organizationId: string, meetingId: string, event: keyof ServerToClientEvents, payload: unknown) => {
    emitter.to([meetingRoom(organizationId, meetingId), orgRoom(organizationId)]).emit(event, payload);
  };
  return {
    meetingStatus: (e: MeetingStatusEvent) => send(e.organizationId, e.meetingId, 'meeting:status', e),
    transcriptionProgress: (e: TranscriptionProgressEvent) => send(e.organizationId, e.meetingId, 'transcription:progress', e)
  };
}

export function createRedisEmitter(redis: Redis): EmitterLike {
  return new Emitter(redis);
}
