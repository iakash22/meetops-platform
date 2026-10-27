import Constants from 'expo-constants';
import { Link } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../auth/AuthProvider';
import { useActiveOrganization } from '../auth/useActiveOrganization';
import { PushNotificationsCard } from '../notifications/PushNotificationsCard';
import { IS_DEMO_MODE } from '../services';
import { colors, radius, spacing } from '../theme/colors';
import { Button } from '../ui/Button';

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

/** App version from app.json via expo-constants; never throws when the manifest is missing (tests, bare runs). */
export function appVersion(): string {
  return Constants.expoConfig?.version ?? 'unknown';
}

export function AccountScreen() {
  const { state, signOut } = useAuth();
  const { organization, role } = useActiveOrganization();
  const [signingOut, setSigningOut] = useState(false);
  const user = state.status === 'signedIn' ? state.session.user : null;
  const orgCount = state.status === 'signedIn' ? state.session.organizations.length : 0;
  const version = appVersion();

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.section}>Signed in as</Text>
      <View style={styles.card}>
        {user?.name ? <Text style={styles.primary}>{user.name}</Text> : null}
        <Text testID="account-email" style={user?.name ? styles.secondary : styles.primary}>
          {user?.email ?? ''}
        </Text>
      </View>

      <Text style={styles.section}>Organization</Text>
      <View style={[styles.card, styles.row]}>
        <View style={styles.flex}>
          <Text testID="account-org" style={styles.primary}>
            {organization?.name ?? 'No organization'}
          </Text>
          {role ? (
            <Text testID="account-role" style={styles.secondary}>
              {ROLE_LABEL[role] ?? role}
            </Text>
          ) : null}
        </View>
        {orgCount > 1 ? (
          <Link
            href="/organizations"
            testID="account-switch-org"
            style={styles.link}
            accessibilityRole="link"
            accessibilityLabel="Switch organization"
            accessibilityHint={`You belong to ${orgCount} organizations`}
          >
            Switch
          </Link>
        ) : null}
      </View>

      <Text style={styles.section}>Notifications</Text>
      <PushNotificationsCard />

      <View style={styles.signOut}>
        <Button
          testID="sign-out"
          variant="destructive"
          label="Sign out"
          accessibilityHint="Signs you out and removes your session from this device"
          loading={signingOut}
          onPress={() => {
            setSigningOut(true);
            void signOut();
          }}
        />
      </View>

      <Text
        testID="app-version"
        style={styles.version}
        accessibilityLabel={`App version ${version}`}
      >
        MeetOps {version}
        {IS_DEMO_MODE ? ' · Demo mode' : ''}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.xl },
  flex: { flex: 1 },
  section: {
    color: colors.mutedForeground,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.xl,
    gap: spacing.xs,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  primary: { color: colors.foreground, fontSize: 16, fontWeight: '600' },
  secondary: { color: colors.mutedForeground, fontSize: 14 },
  link: { color: colors.link, fontSize: 16, fontWeight: '600', padding: spacing.sm },
  signOut: { marginTop: spacing.sm },
  version: {
    color: colors.mutedForeground,
    fontSize: 12,
    textAlign: 'center',
    marginTop: spacing.xxl,
  },
});
