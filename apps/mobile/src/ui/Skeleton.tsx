import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { colors, radius, spacing } from '../theme/colors';
import { useReducedMotion } from './useReducedMotion';

interface Props {
  /** Read by screen readers instead of the placeholder shapes, e.g. "Loading meetings". */
  label: string;
  rows?: number;
  testID?: string;
}

/**
 * Loading placeholder shaped like a list of cards. Exposed to assistive tech as one busy element
 * with a label. The shimmer (opacity pulse) is skipped when reduced motion is on.
 */
export function SkeletonList({ label, rows = 3, testID }: Props) {
  const reducedMotion = useReducedMotion();
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reducedMotion) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.5, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reducedMotion]);

  return (
    <View testID={testID} accessible accessibilityLabel={label} accessibilityState={{ busy: true }}>
      {Array.from({ length: rows }, (_, i) => (
        <Animated.View key={i} style={[styles.card, { opacity }]}>
          <View style={[styles.bar, styles.wide]} />
          <View style={[styles.bar, styles.narrow]} />
        </Animated.View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  bar: { height: 12, borderRadius: radius.sm, backgroundColor: colors.secondary },
  wide: { width: '70%' },
  narrow: { width: '35%' },
});
