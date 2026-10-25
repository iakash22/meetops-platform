import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../theme/colors';
import { Button } from './Button';

interface EmptyProps {
  title: string;
  body?: string;
  testID?: string;
}

/** Calm, centred empty state. No accent colour: empty is not an alert. */
export function EmptyState({ title, body, testID }: EmptyProps) {
  return (
    <View
      testID={testID}
      style={styles.box}
      accessible
      accessibilityLabel={[title, body].filter(Boolean).join('. ')}
    >
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
    </View>
  );
}

interface ErrorProps {
  message: string;
  onRetry: () => void;
  testID?: string;
}

/** Load failure with a retry. Uses the destructive token (never Neon Rose) and is announced as an alert. */
export function ErrorState({ message, onRetry, testID }: ErrorProps) {
  return (
    <View testID={testID} style={[styles.box, styles.errorBox]}>
      <Text accessibilityRole="alert" style={styles.error}>
        {message}
      </Text>
      <Button
        testID={testID ? `${testID}-retry` : undefined}
        variant="secondary"
        label="Try again"
        onPress={onRetry}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: 'stretch',
    gap: spacing.sm,
  },
  errorBox: { borderColor: colors.destructive, gap: spacing.lg },
  title: { color: colors.foreground, fontSize: 17, fontWeight: '600', textAlign: 'center' },
  body: { color: colors.mutedForeground, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  error: { color: colors.destructive, fontSize: 15, textAlign: 'center' },
});
