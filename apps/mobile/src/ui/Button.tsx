import { useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  type ViewStyle,
} from 'react-native';

import { colors, glow, radius, spacing } from '../theme/colors';
import { useReducedMotion } from './useReducedMotion';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive';

interface Props {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  /** Screen-reader hint describing the result of the press. */
  accessibilityHint?: string;
  testID?: string;
}

const FILL: Record<ButtonVariant, { base: ViewStyle; pressed: ViewStyle; text: string }> = {
  primary: {
    base: { backgroundColor: colors.primary },
    pressed: { backgroundColor: colors.primaryPressed },
    text: colors.primaryForeground,
  },
  secondary: {
    base: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
    pressed: { backgroundColor: colors.secondary },
    text: colors.foreground,
  },
  // Outlined so a destructive action is clearly marked without dominating the screen.
  destructive: {
    base: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.destructive },
    pressed: { backgroundColor: colors.secondary },
    text: colors.destructive,
  },
};

/**
 * Primary CTA has a subtle Cerulean glow (static shadow) and a small press scale.
 * The scale animation is skipped when the OS asks for reduced motion.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  accessibilityHint,
  testID,
}: Props) {
  const inactive = disabled || loading;
  const reducedMotion = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const fill = FILL[variant];

  const animateTo = (toValue: number) => {
    if (reducedMotion) return;
    Animated.spring(scale, { toValue, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  };

  return (
    <Animated.View
      style={[
        styles.wrap,
        variant === 'primary' && !inactive && styles.glow,
        { transform: [{ scale }] },
      ]}
    >
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: inactive, busy: loading }}
        disabled={inactive}
        onPress={onPress}
        onPressIn={() => animateTo(0.97)}
        onPressOut={() => animateTo(1)}
        style={({ pressed }) => [
          styles.base,
          fill.base,
          pressed && fill.pressed,
          inactive && styles.dim,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={fill.text} />
        ) : (
          <Text style={[styles.text, { color: fill.text }]}>{label}</Text>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: radius.md },
  glow: {
    shadowColor: glow.primary.color,
    shadowOpacity: glow.primary.opacity,
    shadowRadius: glow.primary.radius,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  base: {
    minHeight: 52,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  dim: { opacity: 0.6 },
  text: { fontSize: 16, fontWeight: '600' },
});
