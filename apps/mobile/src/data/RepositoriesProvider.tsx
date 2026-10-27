import type { MeetingInsightsApi } from '../api/paths';
import type { SimulatedCapture } from '../record/simulatedRecorder';
import type { UploadQueueEngine } from '../upload/uploadQueueEngine';
import type { MicPermission } from '../consent/micPermission';
import { createContext, useContext, type ReactNode } from 'react';

import type { ConsentApi } from '../consent/consentApi';
import type { MeetingsRepository } from './meetingsRepository';
import type { TasksRepository } from './tasksRepository';
import type { UploadQueue } from './uploadQueue';

export interface Repositories {
  meetings: MeetingsRepository;
  tasks: TasksRepository;
  /** Transcript and report reads (#212). */
  insights: MeetingInsightsApi;
  uploadQueue: UploadQueue;
  /** Recording consent (R1 opt-in local; R3 attestation travels with the upload, contracts v0.4.1). */
  consent: ConsentApi;
  /** Microphone permission (demo until the M4 native recorder). */
  micPermission: MicPermission;
  /**
   * Recording pipeline for the Record tab. Absent = UI preview only (nothing queued).
   * Today it is a SIMULATED capture (no audio) feeding the real upload queue engine.
   */
  recordings?: RecordingPipeline | undefined;
}

export interface RecordingPipeline {
  engine: UploadQueueEngine;
  capture: SimulatedCapture;
  /** Active org of the signed-in user; queue items are bound to it. */
  organizationId: () => string | null;
}

const RepositoriesContext = createContext<Repositories | null>(null);

/** Data sources for screens. The app passes the placeholders from `src/services.ts`; tests pass fakes. */
export function RepositoriesProvider({
  value,
  children,
}: {
  value: Repositories;
  children: ReactNode;
}) {
  return <RepositoriesContext.Provider value={value}>{children}</RepositoriesContext.Provider>;
}

export function useRepositories(): Repositories {
  const value = useContext(RepositoriesContext);
  if (!value) throw new Error('useRepositories must be used inside <RepositoriesProvider>.');
  return value;
}
