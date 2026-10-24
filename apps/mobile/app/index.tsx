import { StyleSheet, Text, View } from 'react-native';

import { RECORDING_ENABLED } from '../src/config/session';

export default function HomeScreen() {
  return (
    <View style={styles.container} accessibilityRole="summary">
      <Text style={styles.title}>MeetOps</Text>
      <Text testID="recording-status">
        {RECORDING_ENABLED ? 'Recording available' : 'Recording not available yet'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 8 },
});
