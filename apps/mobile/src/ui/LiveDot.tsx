import { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';

import { colors } from '../theme/colors';
import { useReducedMotion } from './useReducedMotion';

/** Neon Rose dot for live/recording states. Pulses gently unless reduced motion is on. */
export function LiveDot({ testID }: { testID?: string }) {
  const reducedMotion = useReducedMotion();
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reducedMotion) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 800, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reducedMotion]);

  return (
    <Animated.View testID={testID} accessibilityElementsHidden style={[styles.dot, { opacity }]} />
  );
}

const styles = StyleSheet.create({
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
});
