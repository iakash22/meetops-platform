import type { ExtractedTask, Task, TaskPriority, TaskStatus } from '@meetops/contracts';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../api/client';
import { colors, radius, spacing } from '../theme/colors';
import { Button } from '../ui/Button';
import { TextField } from '../ui/TextField';
import { Toast } from '../ui/Toast';
import {
  buildUpdate,
  PRIORITIES,
  PRIORITY_LABEL,
  STATUSES,
  STATUS_LABEL,
  toEditValues,
  validateEdit,
  type EditValues,
  type FieldErrors,
  type TaskReviewApi,
} from './taskReviewCore';

type Props = { api: TaskReviewApi; organizationId: string };

const message = (e: unknown, fallback: string) =>
  e instanceof ApiError
    ? e.code === 'CONFLICT'
      ? 'Task already reviewed.'
      : e.message || fallback
    : fallback;

/** Phase 4 review of AI-extracted tasks: accept or dismiss, then edit accepted ones (same flow as web #230). */
export function TaskReviewPanel({ api, organizationId }: Props) {
  const [items, setItems] = useState<ExtractedTask[] | null>(null);
  const [accepted, setAccepted] = useState<Task[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api.pending(organizationId)).items);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setItems([]);
      else {
        setItems([]);
        setToast(message(e, "Couldn't load suggested tasks."));
      }
    }
  }, [api, organizationId]);

  useEffect(() => {
    setItems(null);
    setAccepted([]);
    void load();
  }, [load]);

  const act = async (t: ExtractedTask, kind: 'accept' | 'dismiss') => {
    setBusy(t.id);
    try {
      if (kind === 'accept') {
        const task = await api.accept(organizationId, t.id, { title: t.title, priority: 'medium' });
        setAccepted((a) => [task, ...a]);
      } else await api.dismiss(organizationId, t.id);
      setItems((list) => (list ?? []).filter((x) => x.id !== t.id));
    } catch (e) {
      setToast(
        message(e, kind === 'accept' ? "Couldn't accept the task." : "Couldn't dismiss it."),
      );
      if (e instanceof ApiError && e.code === 'CONFLICT')
        setItems((list) => (list ?? []).filter((x) => x.id !== t.id));
    } finally {
      setBusy(null);
    }
  };

  if (items === null) return <Text style={styles.muted}>Loading suggested tasks…</Text>;
  return (
    <View testID="task-review" style={styles.wrap}>
      <Text style={styles.heading} accessibilityRole="header">
        Suggested tasks ({items.length})
      </Text>
      {items.length === 0 ? (
        <Text testID="task-review-empty" style={styles.muted}>
          Nothing to review.
        </Text>
      ) : (
        items.map((t) => (
          <View key={t.id} testID="review-row" style={styles.card}>
            <Text style={styles.title}>{t.title}</Text>
            <View style={styles.actions}>
              <View style={styles.flex}>
                <Button
                  testID={`accept-${t.id}`}
                  label="Accept"
                  accessibilityHint={`Adds ${t.title} to tasks`}
                  loading={busy === t.id}
                  disabled={busy !== null}
                  onPress={() => void act(t, 'accept')}
                />
              </View>
              <View style={styles.flex}>
                <Button
                  testID={`dismiss-${t.id}`}
                  label="Dismiss"
                  variant="secondary"
                  disabled={busy !== null}
                  onPress={() => void act(t, 'dismiss')}
                />
              </View>
            </View>
          </View>
        ))
      )}
      {accepted.map((task) =>
        editing === task.id ? (
          <EditTaskForm
            key={task.id}
            task={task}
            onCancel={() => setEditing(null)}
            onSave={async (body) => {
              const next = await api.update(organizationId, task.id, body);
              setAccepted((a) => a.map((x) => (x.id === next.id ? next : x)));
              setEditing(null);
            }}
            onToast={setToast}
          />
        ) : (
          <View key={task.id} testID="accepted-row" style={styles.card}>
            <Text style={styles.title}>{task.title}</Text>
            <Text style={styles.muted}>
              Accepted · {STATUS_LABEL[task.status]} · {PRIORITY_LABEL[task.priority]}
            </Text>
            <Button
              testID={`edit-${task.id}`}
              label="Edit"
              variant="secondary"
              onPress={() => setEditing(task.id)}
            />
          </View>
        ),
      )}
      <Toast testID="task-review-toast" message={toast} onDismiss={() => setToast(null)} />
    </View>
  );
}

function Chips<T extends string>(props: {
  label: string;
  values: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={props.label} style={styles.chips}>
      {props.values.map((v) => (
        <Pressable
          key={v}
          accessibilityRole="radio"
          accessibilityState={{ checked: v === props.value }}
          onPress={() => props.onChange(v)}
          style={[styles.chip, v === props.value && styles.chipOn]}
        >
          <Text style={styles.chipText}>{props.labels[v]}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function EditTaskForm(props: {
  task: Task;
  onSave: (body: ReturnType<typeof buildUpdate>) => Promise<void>;
  onCancel: () => void;
  onToast: (m: string) => void;
}) {
  const [v, setV] = useState<EditValues>(() => toEditValues(props.task));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<EditValues>) => setV((cur) => ({ ...cur, ...patch }));

  const submit = async () => {
    const errs = validateEdit(v);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const body = buildUpdate(props.task, v);
    if (!Object.keys(body).length) return props.onCancel();
    setSaving(true);
    try {
      await props.onSave(body);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'VALIDATION_FAILED' || e.code === 'BAD_REQUEST'))
        setErrors({ form: e.message || 'Check the fields and try again.' });
      else props.onToast(message(e, "Couldn't save the task."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View testID="edit-task-form" style={styles.card}>
      {errors.form ? (
        <Text testID="edit-form-error" accessibilityRole="alert" style={styles.error}>
          {errors.form}
        </Text>
      ) : null}
      <TextField
        testID="edit-title"
        label="Title"
        value={v.title}
        onChangeText={(title) => set({ title })}
        error={errors.title}
      />
      <TextField
        testID="edit-description"
        label="Description"
        multiline
        value={v.description}
        onChangeText={(description) => set({ description })}
        error={errors.description}
      />
      <TextField
        testID="edit-due"
        label="Due date (YYYY-MM-DD)"
        value={v.due}
        onChangeText={(due) => set({ due })}
        error={errors.dueAt}
      />
      <Chips<TaskPriority>
        label="Priority"
        values={PRIORITIES}
        labels={PRIORITY_LABEL}
        value={v.priority}
        onChange={(priority) => set({ priority })}
      />
      <Chips<TaskStatus>
        label="Status"
        values={STATUSES}
        labels={STATUS_LABEL}
        value={v.status}
        onChange={(status) => set({ status })}
      />
      <View style={styles.actions}>
        <View style={styles.flex}>
          <Button testID="edit-save" label="Save" loading={saving} onPress={() => void submit()} />
        </View>
        <View style={styles.flex}>
          <Button label="Cancel" variant="secondary" onPress={props.onCancel} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.lg },
  flex: { flex: 1 },
  heading: { color: colors.foreground, fontSize: 18, fontWeight: '700', marginBottom: spacing.md },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  title: { color: colors.foreground, fontSize: 16, fontWeight: '600' },
  muted: { color: colors.mutedForeground, fontSize: 13, marginBottom: spacing.sm },
  error: { color: colors.destructiveText, fontSize: 14 },
  actions: { flexDirection: 'row', gap: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.input,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { color: colors.foreground, fontSize: 14 },
});
