import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';

import { colors, motion, radius, spacing } from '../theme/colors';
import { useReducedMotion } from './useReducedMotion';

interface Props {
  message: string | null;
  onDismiss: () => void;
  testID?: string;
}

/**
 * Non-field error toast, pinned to the bottom of the screen. Field errors stay inline under their field.
 * Fades in over `motion.base` (200ms) unless the OS asks for reduced motion.
 */
export function Toast({ message, onDismiss, testID }: Props) {
  const reduced = useReducedMotion();
  const opacity = useRef(new Animated.Value(reduced ? 1 : 0)).current;

  useEffect(() => {
    if (!message) return;
    if (reduced) {
      opacity.setValue(1);
      return;
    }
    opacity.setValue(0);
    Animated.timing(opacity, {
      toValue: 1,
      duration: motion.base,
      useNativeDriver: true,
    }).start();
  }, [message, reduced, opacity]);

  if (!message) return null;
  return (
    <Animated.View
      testID={testID}
      style={[styles.toast, { opacity }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      <Text style={styles.text}>{message}</Text>
      <Pressable
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        hitSlop={12}
        testID={testID ? `${testID}-dismiss` : undefined}
      >
        <Text style={styles.dismiss}>Dismiss</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xxl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.popover,
    borderColor: colors.destructive,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  text: { flex: 1, color: colors.destructiveText, fontSize: 14 },
  dismiss: { color: colors.mutedForeground, fontSize: 13, fontWeight: '600' },
});
