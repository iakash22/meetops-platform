import type { Meeting } from '@meetops/contracts';
import { Link, useRouter } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { useActiveOrganization } from '../auth/useActiveOrganization';
import { useRepositories } from '../data/RepositoriesProvider';
import { useOrgScopedList } from '../data/useOrgScopedList';
import { colors, radius, spacing } from '../theme/colors';
import { LiveDot } from '../ui/LiveDot';
import { SkeletonList } from '../ui/Skeleton';
import { EmptyState, ErrorState } from '../ui/StateViews';

const STATUS_LABEL: Record<Meeting['status'], string> = {
  scheduled: 'Scheduled',
  recording: 'Live',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
  transcription_delayed: 'Transcription delayed',
};

/** Placeholder list: real data needs a list-meetings API route (Backend, not in the API yet). */
export function MeetingsScreen() {
  const { organization, organizationId } = useActiveOrganization();
  const { meetings } = useRepositories();
  const { state, reload } = useOrgScopedList(organizationId, meetings.list);
  const orgName = organization?.name ?? 'Organization';
  const router = useRouter();

  return (
    <View style={styles.container}>
      <View style={styles.orgRow}>
        <View
          style={styles.avatar}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
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
          accessibilityLabel="Switch organization"
        >
          Switch
        </Link>
      </View>

      {state.status === 'loading' ? (
        <SkeletonList testID="meetings-skeleton" label="Loading meetings" />
      ) : state.status === 'error' ? (
        <ErrorState testID="meetings-error" message="Couldn't load meetings." onRetry={reload} />
      ) : (
        <FlatList
          testID="meetings-list"
          data={state.items}
          keyExtractor={(m) => m.id}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
          ListEmptyComponent={
            <EmptyState
              testID="meetings-empty"
              title="No meetings yet"
              body="Meetings you record or upload will show up here."
            />
          }
          ListFooterComponent={
            state.items.length > 0 ? (
              <Text style={styles.placeholder}>
                Placeholder data. Meetings sync arrives with the meetings API.
              </Text>
            ) : null
          }
          renderItem={({ item }) => {
            const live = item.status === 'recording';
            return (
              <Pressable
                style={({ pressed }) => [
                  styles.row,
                  live && styles.liveRow,
                  pressed && styles.pressed,
                ]}
                testID="meeting-row"
                accessibilityRole="button"
                accessibilityLabel={`${item.title}, ${STATUS_LABEL[item.status]}`}
                accessibilityHint="Opens the transcript and report"
                onPress={() =>
                  router.push({
                    pathname: '/meeting/[id]',
                    params: { id: item.id, title: item.title },
                  })
                }
              >
                <Text style={styles.title}>{item.title}</Text>
                <View style={styles.statusRow}>
                  {live ? <LiveDot testID="live-dot" /> : null}
                  <Text style={live ? styles.live : styles.muted}>{STATUS_LABEL[item.status]}</Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.xl, paddingBottom: 0 },
  flex: { flex: 1 },
  pressed: { backgroundColor: colors.secondary },
  orgRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.xl,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.foreground, fontSize: 17, fontWeight: '700' },
  orgName: { color: colors.foreground, fontSize: 17, fontWeight: '600', marginTop: 2 },
  link: { color: colors.link, fontSize: 16, fontWeight: '600', padding: spacing.sm },
  muted: { color: colors.mutedForeground, fontSize: 14 },
  row: {
    minHeight: 44,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  liveRow: { borderColor: colors.primary },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  live: { color: colors.foreground, fontSize: 14, fontWeight: '600' },
  title: { color: colors.foreground, fontSize: 16, fontWeight: '600', marginBottom: spacing.xs },
  placeholder: {
    color: colors.mutedForeground,
    fontSize: 12,
    marginVertical: spacing.lg,
    textAlign: 'center',
  },
});
