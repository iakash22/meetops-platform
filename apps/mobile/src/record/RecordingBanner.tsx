import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, spacing } from '../theme/colors';
import { useRecordingPhase } from './indicator';

/** Persistent in-app banner (R2) on every signed-in screen while a capture is recording or paused. */
export function RecordingBanner() {
  const phase = useRecordingPhase();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  if (phase !== 'recording' && phase !== 'paused') return null;
  const text = phase === 'recording' ? 'Recording in progress' : 'Recording paused';
  return (
    <Pressable
      testID="recording-banner"
      accessibilityRole="button"
      accessibilityLabel={`${text}. Open the Record tab.`}
      accessibilityLiveRegion="polite"
      onPress={() => router.navigate('/record')}
      style={[
        styles.banner,
        { paddingTop: insets.top + spacing.sm },
        phase === 'paused' && styles.paused,
      ]}
    >
      <Text style={[styles.text, phase === 'paused' && styles.pausedText]}>
        {text} · Open to stop
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.destructive,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  },
  paused: { backgroundColor: colors.secondary },
  text: { color: colors.destructiveForeground, fontWeight: '600' },
  pausedText: { color: colors.secondaryForeground },
});
