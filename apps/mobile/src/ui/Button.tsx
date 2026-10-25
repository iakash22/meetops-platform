import { useRef } from 'react';
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text } from 'react-native';

import { colors, radius, spacing } from '../theme/colors';
import { useReducedMotion } from './useReducedMotion';

interface Props {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
}

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
  testID,
}: Props) {
  const inactive = disabled || loading;
  const reducedMotion = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;

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
        accessibilityState={{ disabled: inactive, busy: loading }}
        disabled={inactive}
        onPress={onPress}
        onPressIn={() => animateTo(0.97)}
        onPressOut={() => animateTo(1)}
        style={({ pressed }) => [
          styles.base,
          variant === 'primary' ? styles.primary : styles.secondary,
          pressed && styles.pressed,
          inactive && styles.dim,
        ]}
      >
        {loading ? (
          <ActivityIndicator
            color={variant === 'primary' ? colors.primaryForeground : colors.foreground}
          />
        ) : (
          <Text style={variant === 'primary' ? styles.primaryText : styles.secondaryText}>
            {label}
          </Text>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: radius.md },
  glow: {
    shadowColor: colors.primary,
    shadowOpacity: 0.45,
    shadowRadius: 14,
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
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  pressed: { opacity: 0.85 },
  dim: { opacity: 0.6 },
  primaryText: { color: colors.primaryForeground, fontSize: 16, fontWeight: '600' },
  secondaryText: { color: colors.foreground, fontSize: 16, fontWeight: '500' },
});
