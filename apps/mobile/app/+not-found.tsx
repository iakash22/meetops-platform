import { Link, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '../src/theme/colors';

/** Unknown deep links land here instead of a blank screen. */
export default function NotFound() {
  return (
    <View style={styles.container} testID="not-found">
      <Stack.Screen options={{ title: 'Not found' }} />
      <Text style={styles.title} accessibilityRole="header">
        This link doesn&apos;t go anywhere in MeetOps.
      </Text>
      <Link href="/" replace style={styles.link} accessibilityRole="link" testID="not-found-home">
        Go to meetings
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  title: { color: colors.foreground, fontSize: 18, marginBottom: spacing.md, textAlign: 'center' },
  link: { color: colors.link, fontSize: 16, paddingVertical: spacing.sm },
});
