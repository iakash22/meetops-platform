import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

// Last value the OS reported. New components start from it, so a screen mounted after the first
// check (for example the live dot when recording starts) never animates for a frame by mistake.
let lastKnown = false;

/**
 * True when the OS "reduce motion" setting is on. Motion-only effects (press scale, pulsing
 * live dot, skeleton shimmer, record halo) must be skipped when this is true; static styling
 * (colours, glow) stays.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(lastKnown);
  useEffect(() => {
    let mounted = true;
    const update = (value: boolean) => {
      lastKnown = value;
      if (mounted) setReduced(value);
    };
    AccessibilityInfo.isReduceMotionEnabled()
      .then(update)
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', update);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return reduced;
}
