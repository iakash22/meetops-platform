import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { RECORDING_ENABLED } from '../config/session';
import { newLocalMeetingId } from '../consent/consentApi';
import { ConsentSheet, type ConsentStep } from '../consent/ConsentSheet';
import { useRepositories } from '../data/RepositoriesProvider';
import type { UploadQueueStatus } from '../data/uploadQueue';
import { formatElapsed, spokenElapsed } from '../record/recorderShell';
import { useRecorderShell } from '../record/useRecorderShell';
import { colors, glow, radius, spacing } from '../theme/colors';
import { Button } from '../ui/Button';
import { LiveDot } from '../ui/LiveDot';
import { useReducedMotion } from '../ui/useReducedMotion';

const BUTTON_SIZE = 148;

const STATUS_TEXT = {
  idle: 'Ready',
  recording: 'Recording',
  paused: 'Paused',
  stopped: 'Stopped',
} as const;

/**
 * Record tab UI shell. Preview only while RECORDING_ENABLED is false: the timer and controls work,
 * but no audio is captured, stored or uploaded, and the screen says so.
 */
export function RecordScreen() {
  const recorder = useRecorderShell();
  const reducedMotion = useReducedMotion();
  const { uploadQueue, consent } = useRepositories();
  const [consentStep, setConsentStep] = useState<ConsentStep | null>(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [queue, setQueue] = useState<UploadQueueStatus | null>(null);
  const halo = useRef(new Animated.Value(0)).current;
  const active = recorder.phase === 'recording' || recorder.phase === 'paused';
  const preview = !RECORDING_ENABLED;

  useEffect(() => {
    let mounted = true;
    uploadQueue
      .status()
      .then((s) => {
        if (mounted) setQueue(s);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [uploadQueue]);

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

  // R1 + R3: `start` is only reachable through explicit opt-in, then a per-recording participant notice.
  const beginConsent = useCallback(async () => {
    setConsentError(null);
    const optedIn = await consent.hasOptedIn().catch(() => false);
    setConsentStep(optedIn ? 'notice' : 'optIn');
  }, [consent]);

  const { start } = recorder;
  const acceptConsent = useCallback(async () => {
    setConsentBusy(true);
    setConsentError(null);
    try {
      if (consentStep === 'optIn') {
        await consent.optIn();
        setConsentStep('notice');
      } else {
        await consent.confirmParticipantNotice({
          meetingId: newLocalMeetingId(),
          confirmedAt: new Date().toISOString(),
        });
        setConsentStep(null);
        start();
      }
    } catch {
      // Fail closed: never start without a logged notice.
      setConsentError("Couldn't save your confirmation. Recording hasn't started. Try again.");
    } finally {
      setConsentBusy(false);
    }
  }, [consent, consentStep, start]);

  const cancelConsent = useCallback(() => {
    setConsentStep(null);
    setConsentError(null);
  }, []);

  const onMainPress = () => {
    if (recorder.phase === 'idle') void beginConsent();
    else if (active) recorder.stop();
  };

  const mainLabel = recorder.phase === 'idle' ? 'Start recording' : 'Stop recording';
  const timeText = formatElapsed(recorder.elapsedMs);

  return (
    <View style={styles.container}>
      {preview ? (
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
          accessibilityLabel={`Status: ${STATUS_TEXT[recorder.phase]}${preview ? ', preview' : ''}`}
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
            error={consentError}
            onAccept={() => void acceptConsent()}
            onCancel={cancelConsent}
          />
        ) : recorder.phase === 'stopped' ? (
          <View style={styles.summary}>
            <Text testID="record-summary" style={styles.summaryText} accessibilityRole="alert">
              {preview
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
              accessibilityHint={preview ? 'Preview only, no audio is captured' : undefined}
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
              onPress={recorder.phase === 'paused' ? recorder.resume : recorder.pause}
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
  queueDotOffline: { backgroundColor: colors.warning },
  queueTitle: { color: colors.foreground, fontSize: 15, fontWeight: '600' },
  queueBody: { color: colors.mutedForeground, fontSize: 13, marginTop: 2 },
});
