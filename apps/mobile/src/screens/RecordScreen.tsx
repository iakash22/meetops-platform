import type { ConsentAttestationInput } from '@meetops/contracts';
import type { QueueItem } from '../upload/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { createDemoMeetingResolver } from '../consent/meetingResolver';
import { ConsentSheet, type ConsentStep } from '../consent/ConsentSheet';
import { useRepositories } from '../data/RepositoriesProvider';
import type { UploadQueueStatus } from '../data/uploadQueue';
import { setRecordingPhase } from '../record/indicator';
import { formatElapsed, spokenElapsed } from '../record/recorderShell';
import { useRecorderShell } from '../record/useRecorderShell';
import { colors, glow, radius, spacing } from '../theme/colors';
import { Button } from '../ui/Button';
import { LiveDot } from '../ui/LiveDot';
import { Toast } from '../ui/Toast';
import { useReducedMotion } from '../ui/useReducedMotion';

const BUTTON_SIZE = 148;

const STATUS_TEXT = {
  idle: 'Ready',
  recording: 'Recording',
  paused: 'Paused',
  stopped: 'Stopped',
} as const;

/**
 * Record tab. Without a recording pipeline it is a preview (nothing captured). Demo mode uses the simulated capture
 * (no audio) and says so; live mode captures audio with the native recorder, only after consent (R1, R3), with the
 * app-wide banner (R2), and pauses on interruptions until the user resumes (R7).
 */
const INTERRUPTION_POLL_MS = 1000;
const BACKGROUND_RECHECK_MS = 2000;

export function RecordScreen() {
  const recorder = useRecorderShell();
  const reducedMotion = useReducedMotion();
  const { uploadQueue, consent, micPermission, recordings, meetingResolver } = useRepositories();
  const resolverRef = useRef(meetingResolver ?? createDemoMeetingResolver());
  resolverRef.current = meetingResolver ?? resolverRef.current;
  const [items, setItems] = useState<QueueItem[]>([]);
  const [saved, setSaved] = useState(false);
  const meetingIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<string | null>(null);
  const stoppedRef = useRef(false);
  const [consentStep, setConsentStep] = useState<ConsentStep | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [allAgreed, setAllAgreed] = useState(false);
  /** Attestation of the current recording; handed to the upload queue when the recording is saved (M5). */
  const attestationRef = useRef<ConsentAttestationInput | null>(null);
  const [queue, setQueue] = useState<UploadQueueStatus | null>(null);
  const halo = useRef(new Animated.Value(0)).current;
  const active = recorder.phase === 'recording' || recorder.phase === 'paused';
  const preview = !recordings;
  const simulated = recordings?.capture.simulated ?? false;
  const recordingIdRef = useRef<string | null>(null);
  const [interrupted, setInterrupted] = useState(false);

  useEffect(() => {
    setRecordingPhase(recorder.phase);
  }, [recorder.phase]);
  // Leaving the screen tree (sign-out) ends any capture and discards it: nothing records without the UI (R7).
  useEffect(
    () => () => {
      setRecordingPhase('idle');
      if (recordingIdRef.current) void recordings?.capture.abort();
    },
    [recordings],
  );

  const { pause: pauseShell } = recorder;
  const pauseForInterruption = useCallback(() => {
    recordings?.capture.pause();
    pauseShell();
    setInterrupted(true);
  }, [pauseShell, recordings]);

  // R7: a call or another app taking the mic pauses with a notice; the user resumes explicitly.
  useEffect(() => {
    if (recorder.phase !== 'recording' || !recordings || simulated) return;
    const id = setInterval(() => {
      if (!recordings.capture.isLive()) pauseForInterruption();
    }, INTERRUPTION_POLL_MS);
    return () => clearInterval(id);
  }, [pauseForInterruption, recorder.phase, recordings, simulated]);

  // Without the microphone foreground service (and its notification), Android capture never continues out of sight.
  useEffect(() => {
    if (Platform.OS !== 'android' || recorder.phase !== 'recording' || simulated) return;
    let watch: ReturnType<typeof setInterval> | null = null;
    const check = () => {
      if (!(recordings?.capture.isBackgroundSafe?.() ?? false)) {
        if (watch) clearInterval(watch);
        watch = null;
        pauseForInterruption();
      }
    };
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        if (watch) clearInterval(watch);
        watch = null;
        return;
      }
      // Keep recording only while the foreground service and its notification stay confirmed; re-check
      // every BACKGROUND_RECHECK_MS in case the service is lost without an event.
      check();
      watch ??= setInterval(check, BACKGROUND_RECHECK_MS);
    });
    return () => {
      sub.remove();
      if (watch) clearInterval(watch);
    };
  }, [pauseForInterruption, recorder.phase, recordings, simulated]);

  // Stop from the Android notification ends capture immediately, same as the in-app Stop (R2, R7).
  const stopRef = useRef(recorder.stop);
  stopRef.current = recorder.stop;
  useEffect(() => recordings?.capture.onStopRequested?.(() => stopRef.current()), [recordings]);

  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      uploadQueue
        .status()
        .then((s) => {
          if (mounted) setQueue(s);
        })
        .catch(() => undefined);
      recordings?.engine
        .items()
        .then((list) => {
          if (mounted) setItems(list);
        })
        .catch(() => undefined);
    };
    refresh();
    const unsubscribe = recordings?.engine.subscribe(refresh);
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [recordings, uploadQueue]);

  // Stop -> save: the simulated capture writes placeholder chunks, then the recording joins the queue.
  useEffect(() => {
    if (recorder.phase !== 'stopped' || stoppedRef.current) return;
    stoppedRef.current = true;
    const consentRecord = attestationRef.current;
    const meetingId = meetingIdRef.current;
    const organizationId = recordings?.organizationId();
    const id = recordingIdRef.current;
    recordingIdRef.current = null;
    if (!recordings || !id) return;
    if (!consentRecord || !meetingId || !organizationId) {
      void recordings.capture.abort();
      return;
    }
    const durationMs = recorder.elapsedMs;
    void (async () => {
      try {
        // The draft travels with the seal, so a kill mid-seal can still be queued at the next launch.
        const draft = {
          id,
          organizationId,
          meetingId,
          mimeType: 'audio/mp4' as const,
          startedAt: startedAtRef.current ?? new Date().toISOString(),
          durationMs,
          consent: consentRecord,
        };
        const chunks = await recordings.capture.capture(id, durationMs, draft);
        await recordings.engine.enqueue({ ...draft, chunks });
        setSaved(true);
        await recordings.engine.process();
      } catch {
        setToast("Couldn't save this recording. Try again.");
      }
    })();
  }, [recorder.elapsedMs, recorder.phase, recordings]);

  // Breathing halo while recording; static when reduced motion is on or not recording.
  useEffect(() => {
    if (reducedMotion || recorder.phase !== 'recording') {
      halo.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(halo, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(halo, { toValue: 0, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [halo, reducedMotion, recorder.phase]);

  const haloStyle = {
    opacity: halo.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.55] }),
    transform: [{ scale: halo.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) }],
  };

  // R1 + R3: `start` is only reachable through explicit opt-in, the mic pre-prompt (when needed), then a
  // per-recording participant notice. The notice's attestation is kept for the recording's upload (contracts G11).
  const toNoticeOrMic = useCallback(async () => {
    const mic = await micPermission.status().catch(() => 'undetermined' as const);
    setConsentStep(mic === 'granted' ? 'notice' : mic === 'denied' ? 'micDenied' : 'mic');
  }, [micPermission]);

  const beginConsent = useCallback(async () => {
    setToast(null);
    setAllAgreed(false);
    const optedIn = await consent.hasOptedIn().catch(() => false);
    if (optedIn) await toNoticeOrMic();
    else setConsentStep('optIn');
  }, [consent, toNoticeOrMic]);

  const { start } = recorder;
  const acceptConsent = useCallback(async () => {
    setConsentBusy(true);
    setToast(null);
    try {
      if (consentStep === 'optIn') {
        await consent.optIn();
        await toNoticeOrMic();
      } else if (consentStep === 'mic') {
        // Only after the in-app pre-prompt; a denial is never retried silently.
        const result = await micPermission.request();
        setConsentStep(result === 'granted' ? 'notice' : 'micDenied');
      } else if (consentStep === 'micDenied') {
        setConsentStep(null);
        await micPermission.openSettings();
      } else {
        // Server meeting id first: no id, no notice, no recording (fail closed).
        const orgId = recordings?.organizationId() ?? null;
        if (recordings && !orgId) throw new Error('No active organization.');
        const meetingId = await resolverRef.current.resolve(orgId ?? '', new Date().toISOString());
        meetingIdRef.current = meetingId;
        attestationRef.current = await consent.confirmParticipantNotice({
          meetingId,
          confirmedAt: new Date().toISOString(),
          method: allAgreed ? 'all_parties_consented' : 'all_parties_notified',
        });
        // Capture starts only now, from the user's confirmation; a failure here means nothing is recorded.
        if (recordings) {
          const id = `rec-${Date.now().toString(36)}`;
          try {
            await recordings.capture.begin(id);
          } catch (e) {
            // Surface why the mic didn't open (prepare/encryption/service failure); nothing was recorded.
            setToast(
              `Couldn't start recording: ${e instanceof Error ? e.message : 'the recorder failed'}. Recording hasn't started.`,
            );
            setConsentStep(null);
            return;
          }
          recordingIdRef.current = id;
        }
        setConsentStep(null);
        setInterrupted(false);
        stoppedRef.current = false;
        setSaved(false);
        startedAtRef.current = new Date().toISOString();
        start();
      }
    } catch {
      // Fail closed: never start without a logged notice.
      setToast(
        consentStep === 'micDenied'
          ? "Couldn't open Settings. Open it from your home screen."
          : "Couldn't save your confirmation. Recording hasn't started. Try again.",
      );
    } finally {
      setConsentBusy(false);
    }
  }, [allAgreed, consent, consentStep, micPermission, recordings, start, toNoticeOrMic]);

  const cancelConsent = useCallback(() => {
    setConsentStep(null);
    setToast(null);
  }, []);

  const toggleAllAgreed = useCallback(() => setAllAgreed((v) => !v), []);

  const onMainPress = () => {
    if (recorder.phase === 'idle') void beginConsent();
    else if (active) recorder.stop();
  };

  const onPauseResume = () => {
    if (recorder.phase === 'paused') {
      recordings?.capture.resume();
      setInterrupted(false);
      recorder.resume();
    } else {
      recordings?.capture.pause();
      recorder.pause();
    }
  };

  const mainLabel = recorder.phase === 'idle' ? 'Start recording' : 'Stop recording';
  const timeText = formatElapsed(recorder.elapsedMs);

  return (
    <View style={styles.container}>
      {interrupted && recorder.phase === 'paused' ? (
        <View testID="record-interrupted" style={styles.notice} accessibilityRole="alert">
          <Text style={styles.noticeTitle}>Recording paused</Text>
          <Text style={styles.noticeBody}>
            Something interrupted the recording, like a call or another app using the microphone.
            Tap Resume to continue.
          </Text>
        </View>
      ) : null}
      {simulated ? (
        <View testID="record-simulated-notice" style={styles.notice} accessible>
          <Text style={styles.noticeTitle}>Simulated recorder</Text>
          <Text style={styles.noticeBody}>
            No audio is captured. Stopping queues a placeholder recording so you can see the upload
            queue. Uploads are simulated and nothing leaves this device.
          </Text>
        </View>
      ) : preview ? (
        <View testID="record-preview-notice" style={styles.notice} accessible>
          <Text style={styles.noticeTitle}>Preview only</Text>
          <Text style={styles.noticeBody}>
            Audio capture isn&apos;t available yet. Nothing is recorded, saved or uploaded.
          </Text>
        </View>
      ) : null}

      <View style={styles.center}>
        <View
          testID="record-status"
          style={styles.statusRow}
          accessibilityLiveRegion="polite"
          accessible
          accessibilityLabel={`Status: ${STATUS_TEXT[recorder.phase]}${preview || simulated ? ', preview' : ''}`}
        >
          {recorder.phase === 'recording' ? <LiveDot testID="record-live-dot" /> : null}
          <Text style={recorder.phase === 'recording' ? styles.statusLive : styles.status}>
            {STATUS_TEXT[recorder.phase]}
          </Text>
        </View>

        <Text
          testID="record-timer"
          style={styles.timer}
          accessibilityRole="timer"
          accessibilityLabel={`Elapsed time ${spokenElapsed(recorder.elapsedMs)}`}
        >
          {timeText}
        </Text>

        {consentStep ? (
          <ConsentSheet
            step={consentStep}
            busy={consentBusy}
            allAgreed={allAgreed}
            onToggleAllAgreed={toggleAllAgreed}
            onAccept={() => void acceptConsent()}
            onCancel={cancelConsent}
          />
        ) : recorder.phase === 'stopped' ? (
          <View style={styles.summary}>
            <Text testID="record-summary" style={styles.summaryText} accessibilityRole="alert">
              {saved && !simulated
                ? `Recording saved at ${timeText}. It's in the upload queue.`
                : saved
                  ? `Simulated recording saved at ${timeText}. It's in the upload queue.`
                  : preview && !recordings
                    ? `Preview ended at ${timeText}. Nothing was saved.`
                    : `Recording stopped at ${timeText}.`}
            </Text>
            <Button
              testID="record-done"
              variant="secondary"
              label="Done"
              onPress={recorder.reset}
            />
          </View>
        ) : (
          <View style={styles.buttonWrap}>
            <Animated.View
              testID="record-halo"
              pointerEvents="none"
              style={[styles.halo, haloStyle]}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
            <Pressable
              testID="record-button"
              accessibilityRole="button"
              accessibilityLabel={mainLabel}
              accessibilityHint={
                preview || simulated ? 'Preview only, no audio is captured' : undefined
              }
              onPress={onMainPress}
              style={({ pressed }) => [styles.recordButton, pressed && styles.recordPressed]}
            >
              <View style={active ? styles.stopGlyph : styles.recordGlyph} />
            </Pressable>
          </View>
        )}

        {active ? (
          <View style={styles.secondaryRow}>
            <Button
              testID="record-pause"
              variant="secondary"
              label={recorder.phase === 'paused' ? 'Resume' : 'Pause'}
              accessibilityHint={
                recorder.phase === 'paused' ? 'Continues the timer' : 'Pauses the timer'
              }
              onPress={onPauseResume}
            />
          </View>
        ) : null}
      </View>

      <View
        testID="upload-queue"
        style={styles.queue}
        accessible
        accessibilityLabel={`Upload queue. ${queueText(queue)}`}
      >
        <View style={[styles.queueDot, queue?.offline && styles.queueDotOffline]} />
        <View style={styles.flex}>
          <Text style={styles.queueTitle}>Upload queue</Text>
          <Text testID="upload-queue-status" style={styles.queueBody}>
            {queueText(queue)}
          </Text>
        </View>
      </View>
      {items.length > 0 ? (
        <View testID="upload-queue-items" style={styles.items}>
          {items.map((item) => (
            <View key={item.id} style={styles.item} testID={`queue-item-${item.id}`}>
              <View style={styles.flex}>
                <Text style={styles.itemTitle}>
                  {formatElapsed(item.durationMs)} recording · {item.uploadedSeqs.length}/
                  {item.chunks.length} parts
                </Text>
                <Text style={item.state === 'failed' ? styles.itemError : styles.queueBody}>
                  {item.state === 'failed'
                    ? (item.lastError ?? 'Upload stopped.')
                    : item.state === 'uploading'
                      ? 'Uploading…'
                      : 'Waiting'}
                </Text>
              </View>
              {item.state === 'failed' ? (
                <Button
                  testID={`queue-retry-${item.id}`}
                  variant="secondary"
                  label="Retry"
                  onPress={() =>
                    void recordings?.engine
                      .retry(item.id)
                      .catch(() => setToast("Couldn't retry the upload. Try again."))
                  }
                />
              ) : null}
              <Button
                testID={`queue-delete-${item.id}`}
                variant="secondary"
                label="Delete"
                onPress={() =>
                  void recordings?.engine
                    .discard(item.id)
                    .catch(() => setToast("Couldn't delete the recording. Try again."))
                }
              />
            </View>
          ))}
        </View>
      ) : null}
      <Toast testID="record-toast" message={toast} onDismiss={() => setToast(null)} />
    </View>
  );
}

function queueText(queue: UploadQueueStatus | null): string {
  if (!queue) return 'Checking…';
  const extra = [
    queue.failed ? `${queue.failed} need${queue.failed === 1 ? 's' : ''} attention.` : '',
    queue.expiringSoon
      ? `${queue.expiringSoon} will be deleted from this device within a day.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const base = queue.offline
    ? `Offline. ${pendingText(queue.pending)} Uploads resume when you're back online.`
    : pendingText(queue.pending);
  return extra ? `${base} ${extra}` : base;
}

function pendingText(n: number): string {
  if (n === 0) return 'Nothing waiting to upload.';
  return `${n} recording${n === 1 ? '' : 's'} waiting to upload.`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.xl },
  flex: { flex: 1 },
  notice: {
    backgroundColor: colors.card,
    borderColor: colors.warning,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  noticeTitle: { color: colors.warning, fontSize: 14, fontWeight: '700' },
  noticeBody: { color: colors.foreground, fontSize: 14, lineHeight: 20 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.xl },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  status: { color: colors.mutedForeground, fontSize: 15, fontWeight: '600' },
  statusLive: { color: colors.accent, fontSize: 15, fontWeight: '700' },
  timer: {
    color: colors.foreground,
    fontSize: 56,
    fontWeight: '300',
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
  buttonWrap: {
    width: BUTTON_SIZE + 40,
    height: BUTTON_SIZE + 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: {
    position: 'absolute',
    width: BUTTON_SIZE + 32,
    height: BUTTON_SIZE + 32,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
  },
  recordButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: glow.primary.color,
    shadowOpacity: glow.primary.opacity,
    shadowRadius: glow.primary.radius * 2,
    shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },
  recordPressed: { opacity: 0.85 },
  recordGlyph: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    backgroundColor: colors.primaryForeground,
  },
  stopGlyph: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.primaryForeground,
  },
  secondaryRow: { width: 200 },
  summary: { alignSelf: 'stretch', gap: spacing.lg },
  summaryText: { color: colors.foreground, fontSize: 15, textAlign: 'center' },
  queue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  queueDot: {
    width: 10,
    height: 10,
    borderRadius: radius.full,
    backgroundColor: colors.mutedForeground,
  },
  items: { gap: spacing.sm, marginTop: spacing.sm },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  itemTitle: { color: colors.foreground, fontSize: 14, fontWeight: '600' },
  itemError: { color: colors.destructiveText, fontSize: 13, marginTop: 2 },
  queueDotOffline: { backgroundColor: colors.warning },
  queueTitle: { color: colors.foreground, fontSize: 15, fontWeight: '600' },
  queueBody: { color: colors.mutedForeground, fontSize: 13, marginTop: 2 },
});
