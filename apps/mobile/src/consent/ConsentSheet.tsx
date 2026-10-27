import { memo, useEffect, useRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../theme/colors';
import { Button } from '../ui/Button';

export type ConsentStep = 'optIn' | 'notice' | 'mic' | 'micDenied';

interface Props {
  step: ConsentStep;
  busy: boolean;
  /** Notice step only: everyone explicitly agreed (`all_parties_consented`) rather than was told. */
  allAgreed?: boolean;
  onToggleAllAgreed?: () => void;
  onAccept: () => void;
  onCancel: () => void;
}

const COPY: Record<ConsentStep, { title: string; body: string[]; accept: string; hint: string }> = {
  optIn: {
    title: 'Allow meeting recording',
    body: [
      'MeetOps records meeting audio only when you press Start. Recording never starts on its own.',
      'Recordings are tied to you and your organization and can be deleted.',
      'You will confirm a participant notice before every recording.',
    ],
    accept: 'I agree, turn on recording',
    hint: 'Records your opt-in. You can still cancel each recording.',
  },
  notice: {
    title: 'Tell participants first',
    body: [
      'Everyone in this meeting must know it is being recorded. Say so out loud or in the meeting chat before you start.',
      'Your confirmation is logged with the time, meeting and organization.',
    ],
    accept: 'Participants are informed, start',
    hint: 'Logs the notice and starts the recording',
  },
  mic: {
    title: 'Microphone access',
    body: [
      'MeetOps needs the microphone to record the meeting audio you choose to capture.',
      'Your phone will ask next. Audio is only captured while a recording you started is running.',
    ],
    accept: 'Continue',
    hint: 'Shows the system microphone prompt',
  },
  micDenied: {
    title: 'Microphone is off',
    body: [
      'Recording needs microphone access, which is turned off for MeetOps.',
      'Turn it on in Settings, then come back and press Start again.',
    ],
    accept: 'Open Settings',
    hint: 'Opens the MeetOps page in system settings',
  },
};

/** Inline consent step shown over the Record tab (R1 opt-in, R3 participant notice). */
export const ConsentSheet = memo(function ConsentSheet({
  step,
  busy,
  allAgreed = false,
  onToggleAllAgreed,
  onAccept,
  onCancel,
}: Props) {
  const titleRef = useRef<Text>(null);
  const copy = COPY[step];

  // Move screen-reader focus to the new step's title.
  useEffect(() => {
    const node = titleRef.current ? findNodeHandle(titleRef.current) : null;
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, [step]);

  return (
    <View testID={`consent-${step}`} style={styles.sheet} accessibilityViewIsModal>
      <Text ref={titleRef} accessibilityRole="header" style={styles.title}>
        {copy.title}
      </Text>
      {copy.body.map((line) => (
        <Text key={line} style={styles.body}>
          {line}
        </Text>
      ))}
      {step === 'notice' && onToggleAllAgreed ? (
        <Pressable
          testID="consent-all-agreed"
          accessibilityRole="checkbox"
          accessibilityState={{ checked: allAgreed, disabled: busy }}
          disabled={busy}
          onPress={onToggleAllAgreed}
          style={styles.check}
          hitSlop={8}
        >
          <View style={[styles.box, allAgreed && styles.boxOn]}>
            {allAgreed ? <Text style={styles.tick}>✓</Text> : null}
          </View>
          <Text style={styles.body}>Everyone also agreed to be recorded</Text>
        </Pressable>
      ) : null}
      <View style={styles.actions}>
        <Button
          testID={`consent-${step}-accept`}
          label={copy.accept}
          accessibilityHint={copy.hint}
          loading={busy}
          onPress={onAccept}
        />
        <Button
          testID={`consent-${step}-cancel`}
          variant="secondary"
          label="Not now"
          disabled={busy}
          onPress={onCancel}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  sheet: {
    alignSelf: 'stretch',
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.md,
  },
  title: { color: colors.foreground, fontSize: 20, fontWeight: '700' },
  body: { color: colors.foreground, fontSize: 15, lineHeight: 22 },
  check: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  box: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.mutedForeground,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  tick: { color: colors.primaryForeground, fontSize: 14, fontWeight: '700' },
  actions: { gap: spacing.md, marginTop: spacing.sm },
});
