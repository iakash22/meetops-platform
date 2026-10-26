import { memo, useEffect, useRef } from 'react';
import { AccessibilityInfo, findNodeHandle, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../theme/colors';
import { Button } from '../ui/Button';

export type ConsentStep = 'optIn' | 'notice';

interface Props {
  step: ConsentStep;
  busy: boolean;
  error: string | null;
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
};

/** Inline consent step shown over the Record tab (R1 opt-in, R3 participant notice). */
export const ConsentSheet = memo(function ConsentSheet({
  step,
  busy,
  error,
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
      {error ? (
        <Text testID="consent-error" accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
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
  error: { color: colors.destructiveText, fontSize: 14 },
  actions: { gap: spacing.md, marginTop: spacing.sm },
});
