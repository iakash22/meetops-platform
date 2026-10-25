import type { Task } from '@meetops/contracts';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { useActiveOrganization } from '../auth/useActiveOrganization';
import { useRepositories } from '../data/RepositoriesProvider';
import { useOrgScopedList } from '../data/useOrgScopedList';
import { colors, radius, spacing } from '../theme/colors';
import { SkeletonList } from '../ui/Skeleton';
import { EmptyState, ErrorState } from '../ui/StateViews';

const STATUS_LABEL: Record<Task['status'], string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
};

const PRIORITY_LABEL: Record<Task['priority'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

/** Read-only placeholder list. Real data needs a list-tasks API route (Backend, not in the API yet). */
export function TasksScreen() {
  const { organizationId } = useActiveOrganization();
  const { tasks } = useRepositories();
  const { state, reload } = useOrgScopedList(organizationId, tasks.list);

  return (
    <View style={styles.container}>
      {state.status === 'loading' ? (
        <SkeletonList testID="tasks-skeleton" label="Loading tasks" />
      ) : state.status === 'error' ? (
        <ErrorState testID="tasks-error" message="Couldn't load tasks." onRetry={reload} />
      ) : (
        <FlatList
          testID="tasks-list"
          data={state.items}
          keyExtractor={(t) => t.id}
          ListEmptyComponent={
            <EmptyState
              testID="tasks-empty"
              title="No tasks yet"
              body="Action items from your meetings will show up here."
            />
          }
          ListFooterComponent={
            state.items.length > 0 ? (
              <Text style={styles.placeholder}>
                Placeholder data. Task sync arrives with the tasks API.
              </Text>
            ) : null
          }
          renderItem={({ item }) => {
            const done = item.status === 'done' || item.status === 'cancelled';
            return (
              <View
                testID="task-row"
                style={styles.row}
                accessible
                accessibilityLabel={`${item.title}, ${STATUS_LABEL[item.status]}, ${PRIORITY_LABEL[item.priority]} priority`}
              >
                <View style={[styles.check, done && styles.checkDone]} />
                <View style={styles.flex}>
                  <Text style={[styles.title, done && styles.titleDone]}>{item.title}</Text>
                  <Text style={styles.meta}>
                    {STATUS_LABEL[item.status]} · {PRIORITY_LABEL[item.priority]}
                  </Text>
                </View>
              </View>
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  check: {
    width: 20,
    height: 20,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.input,
  },
  checkDone: { backgroundColor: colors.primary, borderColor: colors.primary },
  title: { color: colors.foreground, fontSize: 16, fontWeight: '600' },
  titleDone: { color: colors.mutedForeground, textDecorationLine: 'line-through' },
  meta: { color: colors.mutedForeground, fontSize: 13, marginTop: spacing.xs },
  placeholder: {
    color: colors.mutedForeground,
    fontSize: 12,
    marginVertical: spacing.lg,
    textAlign: 'center',
  },
});
