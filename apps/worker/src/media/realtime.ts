import { Emitter } from '@socket.io/redis-emitter';
import type { Redis } from 'ioredis';
import type {
  MeetingStatusEvent,
  ServerToClientEvents,
  TranscriptionProgressEvent,
} from '@meetops/contracts';
import type { RealtimePublisher } from './processor.js';
import type { ProcessingStatusEvent, UploadStatusEvent } from './types.js';

/** Must match apps/realtime organizationRoom: organizations:{organizationId}. */
export const organizationRoom = (organizationId: string) => `organizations:${organizationId}`;
/** Must match apps/realtime meetingRoom: organizations:{organizationId}:meetings:{meetingId}. */
export const meetingRoom = (organizationId: string, meetingId: string) =>
  `organizations:${organizationId}:meetings:${meetingId}`;

export type EmitterLike = {
  to(room: string | string[]): { emit(event: string, payload: unknown): unknown };
};

/** Publishes to organizations:{org}:meetings:{id} and organizations:{org} (one delivery per socket via room union). */
export function createRealtimePublisher(emitter: EmitterLike): RealtimePublisher {
  const send = (
    organizationId: string,
    meetingId: string,
    event: keyof ServerToClientEvents | MediaEventName,
    payload: unknown,
  ) => {
    emitter
      .to([meetingRoom(organizationId, meetingId), organizationRoom(organizationId)])
      .emit(event, payload);
  };
  return {
    meetingStatus: (e: MeetingStatusEvent) =>
      send(e.organizationId, e.meetingId, 'meeting:status', e),
    transcriptionProgress: (e: TranscriptionProgressEvent) =>
      send(e.organizationId, e.meetingId, 'transcription:progress', e),
    processingStatus: (e: ProcessingStatusEvent) =>
      send(e.organizationId, e.meetingId, 'processing:status', e),
  };
}

type MediaEventName = 'upload:status' | 'processing:status';

/** Publisher for upload status (used by the upload-complete path; same rooms as the realtime server). */
export function publishUploadStatus(emitter: EmitterLike, e: UploadStatusEvent): void {
  emitter
    .to([meetingRoom(e.organizationId, e.meetingId), organizationRoom(e.organizationId)])
    .emit('upload:status', e);
}

export function createRedisEmitter(redis: Redis): EmitterLike {
  return new Emitter(redis);
}
