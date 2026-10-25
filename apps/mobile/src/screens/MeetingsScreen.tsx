import type { Meeting } from '@meetops/contracts';
import { Link } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../auth/AuthProvider';
import { RECORDING_ENABLED } from '../config/session';
import { meetingsClient } from '../services';
import { colors, radius, spacing } from '../theme/colors';
import { Button } from '../ui/Button';
import { LiveDot } from '../ui/LiveDot';

const STATUS_LABEL: Record<Meeting['status'], string> = {
  scheduled: 'Scheduled',
  recording: 'Live',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

/** Placeholder list: real data needs a list-meetings API route (not in the API yet). */
export function MeetingsScreen() {
  const { state, signOut } = useAuth();
  const organizationId = state.status === 'signedIn' ? state.identity.organizationId : null;
  const orgName =
    state.status === 'signedIn'
      ? (state.session.organizations.find((o) => o.id === organizationId)?.name ?? 'Organization')
      : '';
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    setMeetings(null);
    meetingsClient
      .list(organizationId)
      .then((list) => {
        if (active) setMeetings(list);
      })
      .catch(() => {
        if (active) setMeetings([]);
      });
    return () => {
      active = false;
    };
  }, [organizationId]);

  return (
    <View style={styles.container}>
      <View style={styles.orgRow}>
        <View style={styles.avatar} accessibilityElementsHidden>
          <Text style={styles.avatarText}>{orgName.slice(0, 1).toUpperCase()}</Text>
        </View>
        <View style={styles.flex}>
          <Text style={styles.muted}>Organization</Text>
          <Text testID="active-org" style={styles.orgName}>
            {orgName}
          </Text>
        </View>
        <Link
          href="/organizations"
          testID="switch-org-link"
          style={styles.link}
          accessibilityRole="link"
        >
          Switch
        </Link>
      </View>

      <Text testID="recording-status" style={styles.muted}>
        {RECORDING_ENABLED ? 'Recording available' : 'Recording not available yet'}
      </Text>

      <FlatList
        testID="meetings-list"
        style={styles.list}
        data={meetings ?? []}
        keyExtractor={(m) => m.id}
        ListEmptyComponent={
          <Text style={styles.muted}>
            {meetings === null ? 'Loading meetings…' : 'No meetings yet.'}
          </Text>
        }
        renderItem={({ item }) => (
          <View
            style={[styles.row, item.status === 'recording' && styles.liveRow]}
            testID="meeting-row"
          >
            <Text style={styles.title}>{item.title}</Text>
            <View style={styles.statusRow}>
              {item.status === 'recording' ? <LiveDot testID="live-dot" /> : null}
              <Text style={item.status === 'recording' ? styles.live : styles.muted}>
                {STATUS_LABEL[item.status]}
              </Text>
            </View>
          </View>
        )}
      />
      <Text style={styles.placeholder}>
        Placeholder data. Meetings sync arrives with the meetings API.
      </Text>

      <Button
        testID="sign-out"
        variant="secondary"
        label="Sign out"
        loading={signingOut}
        onPress={() => {
          setSigningOut(true);
          void signOut();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.xl },
  flex: { flex: 1 },
  orgRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.foreground, fontSize: 17, fontWeight: '700' },
  orgName: { color: colors.foreground, fontSize: 17, fontWeight: '600', marginTop: 2 },
  link: { color: colors.primary, fontSize: 16, fontWeight: '600', padding: spacing.sm },
  muted: { color: colors.mutedForeground, fontSize: 14 },
  list: { marginVertical: spacing.lg },
  row: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  liveRow: { borderColor: colors.accent },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  live: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  title: { color: colors.foreground, fontSize: 16, fontWeight: '600', marginBottom: spacing.xs },
  placeholder: {
    color: colors.mutedForeground,
    fontSize: 12,
    marginBottom: spacing.lg,
    textAlign: 'center',
  },
});
