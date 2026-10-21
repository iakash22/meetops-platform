import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';
import type { MeetingStatusEvent, ServerToClientEvents, TranscriptionProgressEvent } from '@meetops/contracts';
import type { RealtimePublisher } from './processor.js';

export const orgRoom = (organizationId: string) => `org:${organizationId}`;
export const meetingRoom = (meetingId: string) => `meeting:${meetingId}`;

type EmitterLike = { to(room: string | string[]): { emit(event: string, payload: unknown): unknown } };

/** Publishes to meeting:{id} and org:{id} (one delivery per socket via room union). */
export function createRealtimePublisher(emitter: EmitterLike): RealtimePublisher {
  const send = (organizationId: string, meetingId: string, event: keyof ServerToClientEvents, payload: unknown) => {
    emitter.to([meetingRoom(meetingId), orgRoom(organizationId)]).emit(event, payload);
  };
  return {
    meetingStatus: (e: MeetingStatusEvent) => send(e.organizationId, e.meetingId, 'meeting:status', e),
    transcriptionProgress: (e: TranscriptionProgressEvent) => send(e.organizationId, e.meetingId, 'transcription:progress', e)
  };
}

export function createRedisEmitter(redis: Redis): EmitterLike {
  return new Emitter(redis);
}
