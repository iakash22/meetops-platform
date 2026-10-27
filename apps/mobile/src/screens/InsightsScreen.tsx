import type { Report, Transcript } from '@meetops/contracts';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../api/client';
import type { MeetingInsightsApi } from '../api/paths';
import { colors, radius, spacing } from '../theme/colors';
import { SkeletonList } from '../ui/Skeleton';
import { EmptyState, ErrorState } from '../ui/StateViews';
import { Toast } from '../ui/Toast';

type Tab = 'transcript' | 'report';
type Load<T> =
  | { status: 'loading' }
  | { status: 'not-ready' }
  | { status: 'error'; message: string }
  | { status: 'ready'; value: T };

export const isNotReady = (e: unknown) => e instanceof ApiError && e.status === 404;

/** m:ss or h:mm:ss for transcript offsets. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function useInsight<T>(load: () => Promise<T>) {
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    load().then(
      (value) => live && setState({ status: 'ready', value }),
      (e: unknown) =>
        live &&
        setState(
          isNotReady(e)
            ? { status: 'not-ready' }
            : { status: 'error', message: e instanceof Error ? e.message : "Couldn't load." },
        ),
    );
    return () => {
      live = false;
    };
  }, [load, attempt]);
  return { state, retry: () => setAttempt((n) => n + 1) };
}

function Panel<T>({
  what,
  load,
  render,
}: {
  what: string;
  load: () => Promise<T>;
  render: (v: T) => ReactNode;
}) {
  const { state, retry } = useInsight(load);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => setToast(state.status === 'error' ? state.message : null), [state]);
  if (state.status === 'loading')
    return <SkeletonList testID={`${what}-loading`} label={`Loading ${what}`} />;
  if (state.status === 'not-ready')
    return (
      <EmptyState
        testID={`${what}-not-ready`}
        title="Not ready yet"
        body={`The ${what} appears here once processing finishes.`}
      />
    );
  if (state.status === 'error')
    return (
      <View style={styles.flex}>
        <ErrorState
          testID={`${what}-error`}
          message={`Couldn't load the ${what}.`}
          onRetry={retry}
        />
        <Toast testID={`${what}-toast`} message={toast} onDismiss={() => setToast(null)} />
      </View>
    );
  return <>{render(state.value)}</>;
}

function TranscriptView({ t }: { t: Transcript }) {
  return (
    <FlatList
      testID="transcript-list"
      data={t.segments}
      keyExtractor={(s) => s.id}
      initialNumToRender={20}
      maxToRenderPerBatch={20}
      windowSize={9}
      removeClippedSubviews
      ListEmptyComponent={<EmptyState testID="transcript-empty" title="This transcript is empty" />}
      renderItem={({ item }) => (
        <View style={styles.segment}>
          <Text style={styles.offset}>{formatOffset(item.startMs)}</Text>
          <Text style={styles.text}>
            {item.speaker ? <Text style={styles.speaker}>{item.speaker}: </Text> : null}
            {item.text}
          </Text>
        </View>
      )}
    />
  );
}

function Section({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.heading} accessibilityRole="header">
        {title}
      </Text>
      {items.map((x, i) => (
        <Text key={i} style={styles.text}>
          {'\u2022'} {x}
        </Text>
      ))}
    </View>
  );
}

function ReportView({ r }: { r: Report }) {
  if (!r.summary && !r.decisions.length && !r.risks.length && !r.actionItems.length)
    return <EmptyState testID="report-empty" title="This report has no content" />;
  return (
    <ScrollView testID="report-view" contentContainerStyle={styles.report}>
      {r.summary ? <Text style={styles.text}>{r.summary}</Text> : null}
      <Section title="Decisions" items={r.decisions} />
      <Section title="Risks" items={r.risks} />
      <Section
        title="Action items"
        items={r.actionItems.map((a) =>
          [a.title, a.assigneeHint && `(${a.assigneeHint})`, a.dueHint && `due ${a.dueHint}`]
            .filter(Boolean)
            .join(' '),
        )}
      />
    </ScrollView>
  );
}

/** Transcript and report for one meeting (#212). An API 404 means "not ready yet", not an error. */
export function InsightsScreen({
  api,
  organizationId,
  meetingId,
}: {
  api: MeetingInsightsApi;
  organizationId: string;
  meetingId: string;
}) {
  const [tab, setTab] = useState<Tab>('transcript');
  const loadTranscript = useCallback(
    () => api.transcript(organizationId, meetingId),
    [api, organizationId, meetingId],
  );
  const loadReport = useCallback(
    () => api.report(organizationId, meetingId),
    [api, organizationId, meetingId],
  );
  return (
    <View style={styles.container}>
      <View style={styles.tabs} accessibilityRole="tablist">
        {(['transcript', 'report'] as const).map((t) => (
          <Pressable
            key={t}
            testID={`tab-${t}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t }}
            onPress={() => setTab(t)}
            style={[styles.tab, tab === t && styles.tabActive]}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === 'transcript' ? 'Transcript' : 'Report'}
            </Text>
          </Pressable>
        ))}
      </View>
      {tab === 'transcript' ? (
        <Panel
          key="transcript"
          what="transcript"
          load={loadTranscript}
          render={(t: Transcript) => <TranscriptView t={t} />}
        />
      ) : (
        <Panel
          key="report"
          what="report"
          load={loadReport}
          render={(r: Report) => <ReportView r={r} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.xl, paddingBottom: 0 },
  flex: { flex: 1 },
  tabs: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
  tab: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  tabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { color: colors.foreground, fontSize: 15, fontWeight: '500' },
  tabTextActive: { color: colors.primaryForeground },
  segment: { flexDirection: 'row', gap: spacing.md, paddingVertical: spacing.sm },
  offset: { width: 64, color: colors.mutedForeground, fontVariant: ['tabular-nums'] },
  text: { flex: 1, color: colors.foreground, fontSize: 15, lineHeight: 22 },
  speaker: { fontWeight: '600' },
  report: { gap: spacing.lg, paddingBottom: spacing.xxl },
  section: { gap: spacing.xs },
  heading: { color: colors.foreground, fontSize: 16, fontWeight: '600' },
});
