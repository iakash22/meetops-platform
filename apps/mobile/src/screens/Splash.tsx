import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from '../theme/colors';

/** Shown while the stored session is restored, so guards never flash the wrong screen. */
export function Splash() {
  return (
    <View style={styles.container} testID="splash" accessibilityLabel="Loading">
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});
