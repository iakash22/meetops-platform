import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../theme/colors';
import { Button } from '../ui/Button';
import {
  createDemoPushDeviceApi,
  createDemoPushTokenProvider,
  createPushRegistrationService,
  type PushRegistrationService,
  type PushRegistrationState,
} from './pushRegistration';

const demoService = createPushRegistrationService(
  createDemoPushTokenProvider(),
  createDemoPushDeviceApi(),
  Platform.OS === 'ios' ? 'ios' : 'android',
);

const COPY: Record<PushRegistrationState['status'], string> = {
  off: 'Get notified when meeting notes and tasks are ready. Your phone will ask for permission first.',
  on: 'Notifications are on for this device.',
  denied: 'Notifications are blocked. Turn them on for MeetOps in your phone settings.',
  error: '',
};

export function PushNotificationsCard({
  service = demoService,
}: {
  service?: PushRegistrationService;
}) {
  const [state, setState] = useState<PushRegistrationState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void service.current().then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, [service]);

  const run = (action: () => Promise<PushRegistrationState>) => {
    setBusy(true);
    void action().then((s) => {
      setState(s);
      setBusy(false);
    });
  };

  if (!state) return null;
  const on = state.status === 'on';
  return (
    <View style={styles.card} testID="push-card">
      <Text testID="push-status" style={styles.body}>
        {state.status === 'error' ? state.message : COPY[state.status]}
      </Text>
      {state.status !== 'denied' ? (
        <Button
          testID="push-toggle"
          variant={on ? 'secondary' : 'primary'}
          label={on ? 'Turn off notifications' : 'Turn on notifications'}
          loading={busy}
          onPress={() => run(() => (on ? service.disable() : service.enable()))}
        />
      ) : null}
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
    marginBottom: spacing.xl,
    gap: spacing.md,
  },
  body: { color: colors.foreground, fontSize: 14 },
});
