/** Messaging contracts between popup, background service worker and offscreen document. */
import { CONSENT_METHODS, CONSENT_VERSION_PATTERN } from '@meetops/contracts/types';
import type { ConsentAttestationInput, ConsentMethod } from '@meetops/contracts/types';
import { UUID_RE } from './upload.js';

/** popup -> background */
export type PopupToBackground =
  | { target: 'background'; type: 'GET_STATUS' }
  /**
   * The user ticked the consent confirmation for this meeting and pressed Record. The background records it
   * (bound to tab + meeting, short TTL, one-shot) and turns it into the contracts v0.4.1 attestation at start.
   */
  | {
      target: 'background';
      type: 'ACK_CONSENT';
      tabId: number;
      meetingId: string;
      method: ConsentMethod;
    }
  | {
      target: 'background';
      type: 'START_RECORDING';
      tabId: number;
      streamId: string;
      /**
       * UUID of the meeting this recording belongs to (InitRecordingSession.meetingId).
       * Comes from resolveMeetingId() (src/lib/meeting.ts): the API's meetings/resolve when HTTP uploads are on.
       */
      meetingId: string;
    }
  /** Stops an active recording, or dismisses an 'error' state. */
  | { target: 'background'; type: 'STOP_RECORDING' }
  | { target: 'background'; type: 'DISMISS_WARNING' }
  /** Retry recordings held after a server refusal (409/413). */
  | { target: 'background'; type: 'RETRY_HELD_UPLOADS' }
  /** Delete held recordings locally. Sent only after the user confirmed in the popup. */
  | { target: 'background'; type: 'DISCARD_HELD_UPLOADS'; confirmed: true };

/** background -> offscreen */
export type BackgroundToOffscreen =
  | {
      target: 'offscreen';
      type: 'OFFSCREEN_START';
      streamId: string;
      startedAt: number;
      meetingId: string;
      /** Contracts v0.4.1: the user's attestation for this meeting, sent on recording-session init. */
      consent: ConsentAttestationInput;
    }
  | { target: 'offscreen'; type: 'OFFSCREEN_STOP' }
  /** Stop and throw the recording away (local chunks deleted, upload session aborted). */
  | { target: 'offscreen'; type: 'OFFSCREEN_DISCARD' };

/** Storage-cap events from the persistent chunk queue. */
export type StorageEvent =
  /** lostPending > 0 means not-yet-uploaded audio was lost: the recording is incomplete. */
  | { kind: 'evicted'; count: number; bytes: number; lostPending: number }
  | { kind: 'refused'; seq: number };

/** offscreen -> background (events) */
export type OffscreenToBackground =
  | { target: 'background'; type: 'REC_STARTED'; sessionId: string }
  | { target: 'background'; type: 'REC_CHUNK'; seq: number }
  | { target: 'background'; type: 'REC_HEARTBEAT'; sessionId: string }
  | { target: 'background'; type: 'REC_STORAGE'; event: StorageEvent }
  | { target: 'background'; type: 'REC_STOPPED'; chunkCount: number }
  | { target: 'background'; type: 'REC_ERROR'; error: string };

export type BackgroundMessage = PopupToBackground | OffscreenToBackground;

/** Local capture state of the extension (distinct from the server-side RecordingStatus). */
export type CaptureStatus = 'idle' | 'starting' | 'recording' | 'stopping' | 'error';

export interface StatusPayload {
  status: CaptureStatus;
  tabId?: number;
  startedAt?: number;
  chunks?: number;
  lastError?: string;
  /** User-visible storage warning (eviction / refused chunk). */
  storageWarning?: string;
  /** Audio was lost to the storage cap: the recording will be aborted, not submitted. */
  incomplete?: boolean;
  /** Recordings the server refused (409/413), kept on this device for a user retry. */
  heldRecordings?: number;
  /** Of heldRecordings, closed by the server for good (e.g. consent_revoked): discard only, no retry. */
  heldClosed?: number;
  /** Storage cap hit while recordings are held. */
  heldStorageFull?: boolean;
}

export type BackgroundResponse = ({ ok: true } & StatusPayload) | { ok: false; error: string };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

const isConsentMethod = (v: unknown): v is ConsentMethod =>
  typeof v === 'string' && (CONSENT_METHODS as readonly string[]).includes(v);

const CONSENT_VERSION_RE = new RegExp(CONSENT_VERSION_PATTERN);

/** Shape check for an attestation crossing the offscreen boundary (the API validates it again). */
export function isConsentAttestation(v: unknown): v is ConsentAttestationInput {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    Object.keys(c).length === 3 &&
    typeof c.consentVersion === 'string' &&
    CONSENT_VERSION_RE.test(c.consentVersion) &&
    typeof c.attestedAt === 'string' &&
    !Number.isNaN(Date.parse(c.attestedAt)) &&
    isConsentMethod(c.method)
  );
}

function isStorageEvent(v: unknown): v is StorageEvent {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  if (e.kind === 'evicted') return isNum(e.count) && isNum(e.bytes) && isNum(e.lostPending);
  if (e.kind === 'refused') return isNum(e.seq);
  return false;
}

export function isBackgroundMessage(msg: unknown): msg is BackgroundMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.target !== 'background') return false;
  switch (m.type) {
    case 'GET_STATUS':
    case 'STOP_RECORDING':
    case 'DISMISS_WARNING':
    case 'RETRY_HELD_UPLOADS':
      return true;
    case 'DISCARD_HELD_UPLOADS':
      return m.confirmed === true;
    case 'ACK_CONSENT':
      return isNum(m.tabId) && isUuid(m.meetingId) && isConsentMethod(m.method);
    case 'START_RECORDING':
      return isNum(m.tabId) && isStr(m.streamId) && isUuid(m.meetingId);
    case 'REC_STARTED':
    case 'REC_HEARTBEAT':
      return isStr(m.sessionId);
    case 'REC_CHUNK':
      return isNum(m.seq);
    case 'REC_STORAGE':
      return isStorageEvent(m.event);
    case 'REC_STOPPED':
      return isNum(m.chunkCount);
    case 'REC_ERROR':
      return typeof m.error === 'string';
    default:
      return false;
  }
}

export function isOffscreenMessage(msg: unknown): msg is BackgroundToOffscreen {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m.target !== 'offscreen') return false;
  if (m.type === 'OFFSCREEN_STOP' || m.type === 'OFFSCREEN_DISCARD') return true;
  return (
    m.type === 'OFFSCREEN_START' &&
    isStr(m.streamId) &&
    isNum(m.startedAt) &&
    isUuid(m.meetingId) &&
    isConsentAttestation(m.consent)
  );
}
