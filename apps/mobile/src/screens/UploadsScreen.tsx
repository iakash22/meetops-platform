import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useRepositories } from '../data/RepositoriesProvider';
import type { UploadQueueStatus } from '../data/uploadQueue';
import { colors, radius, spacing } from '../theme/colors';
import { Button } from '../ui/Button';
import { SkeletonList } from '../ui/Skeleton';
import { EmptyState, ErrorState } from '../ui/StateViews';

type Load =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: UploadQueueStatus };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Upload queue status (offline, pending, failed, expiring). Read-only: it never starts, retries or deletes uploads;
 * the scheduler owns that. Shows counts only, never file names or audio.
 */
export function UploadsScreen() {
  const { uploadQueue } = useRepositories();
  const [state, setState] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    uploadQueue.status().then(
      (value) => live && setState({ status: 'ready', value }),
      () => live && setState({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [uploadQueue, attempt]);

  if (state.status === 'loading')
    return (
      <View style={styles.screen}>
        <SkeletonList testID="uploads-loading" label="Loading upload status" />
      </View>
    );
  if (state.status === 'error')
    return (
      <View style={styles.screen}>
        <ErrorState
          testID="uploads-error"
          message="Couldn't read the upload queue."
          onRetry={reload}
        />
      </View>
    );

  const { pending, offline, failed = 0, expiringSoon = 0 } = state.value;
  const nothing = pending === 0 && failed === 0;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {offline ? (
        <View
          testID="uploads-offline"
          style={[styles.card, styles.warnCard]}
          accessibilityRole="alert"
        >
          <Text style={styles.title}>You're offline</Text>
          <Text style={styles.body}>
            Recordings stay encrypted on this device and upload when you're back online.
          </Text>
        </View>
      ) : null}

      {nothing ? (
        <EmptyState
          testID="uploads-empty"
          title="All recordings uploaded"
          body="Nothing is waiting on this device."
        />
      ) : (
        <>
          {pending > 0 ? (
            <View testID="uploads-pending" style={styles.card}>
              <Text style={styles.title}>{plural(pending, 'recording', 'recordings')} waiting</Text>
              <Text style={styles.body}>
                {offline
                  ? 'Uploads resume when you reconnect.'
                  : 'Uploading in the background while the app is open.'}
              </Text>
            </View>
          ) : null}
          {failed > 0 ? (
            <View testID="uploads-failed" style={[styles.card, styles.errorCard]}>
              <Text accessibilityRole="alert" style={styles.errorTitle}>
                {plural(failed, 'recording', 'recordings')} couldn't upload
              </Text>
              <Text style={styles.body}>Open the Record tab to review them.</Text>
            </View>
          ) : null}
          {expiringSoon > 0 ? (
            <View testID="uploads-expiring" style={[styles.card, styles.warnCard]}>
              <Text style={styles.title}>
                {plural(expiringSoon, 'recording is', 'recordings are')} about to expire
              </Text>
              <Text style={styles.body}>
                Recordings are kept on this device for 7 days, then deleted. Connect to upload them
                in time.
              </Text>
            </View>
          ) : null}
        </>
      )}

      <View style={styles.refresh}>
        <Button testID="uploads-refresh" variant="secondary" label="Refresh" onPress={reload} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: spacing.xl },
  content: { gap: spacing.lg, paddingBottom: spacing.xxl },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  warnCard: { borderColor: colors.warning },
  errorCard: { borderColor: colors.destructive },
  title: { color: colors.foreground, fontSize: 16, fontWeight: '600' },
  errorTitle: { color: colors.destructiveText, fontSize: 16, fontWeight: '600' },
  body: { color: colors.mutedForeground, fontSize: 14, lineHeight: 20 },
  refresh: { marginTop: spacing.sm },
});
