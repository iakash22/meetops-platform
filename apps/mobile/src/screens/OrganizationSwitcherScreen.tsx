import { useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../auth/AuthProvider';
import { colors, radius, spacing } from '../theme/colors';
import { Toast } from '../ui/Toast';

/**
 * Organization switcher. Switching wipes local data for the old org (wipe hooks, R4) and swaps to a token scoped to
 * the new org. Real API: `POST /orgs/switch` -> `{ organization, role }`.
 */
export function OrganizationSwitcherScreen() {
  const { state, switchOrganization } = useAuth();
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (state.status !== 'signedIn') return null;
  const activeId = state.identity.organizationId;

  const choose = async (id: string) => {
    if (pending) return;
    if (id === activeId) {
      router.back();
      return;
    }
    setPending(id);
    setError(null);
    try {
      await switchOrganization(id);
      router.back();
    } catch {
      setError('Could not switch organization. Try again.');
    } finally {
      setPending(null);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.note}>
        Switching clears data stored on this device for the current organization.
      </Text>
      <FlatList
        data={state.session.organizations}
        keyExtractor={(o) => o.id}
        renderItem={({ item }) => {
          const active = item.id === activeId;
          return (
            <Pressable
              testID={`org-${item.slug}`}
              accessibilityRole="button"
              accessibilityState={{ selected: active, busy: pending === item.id }}
              accessibilityLabel={`${item.name}${active ? ', current organization' : ''}`}
              onPress={() => void choose(item.id)}
              style={({ pressed }) => [
                styles.row,
                active && styles.activeRow,
                pressed && styles.pressed,
              ]}
            >
              <View style={[styles.avatar, active && styles.activeAvatar]}>
                <Text style={[styles.avatarText, active && styles.activeAvatarText]}>
                  {item.name.slice(0, 1).toUpperCase()}
                </Text>
              </View>
              <Text style={styles.name}>{item.name}</Text>
              {active ? <Text style={styles.activeTag}>Current</Text> : null}
              {pending === item.id ? <Text style={styles.muted}>Switching…</Text> : null}
            </Pressable>
          );
        }}
      />
      <Toast testID="switch-error" message={error} onDismiss={() => setError(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, padding: spacing.xl },
  note: { color: colors.mutedForeground, fontSize: 13, marginBottom: spacing.lg },
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
  activeRow: { borderColor: colors.accent },
  pressed: { backgroundColor: colors.secondary },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeAvatar: { backgroundColor: colors.accent },
  avatarText: { color: colors.foreground, fontSize: 15, fontWeight: '700' },
  activeAvatarText: { color: colors.accentForeground },
  name: { color: colors.foreground, fontSize: 16, flex: 1 },
  activeTag: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  muted: { color: colors.mutedForeground, fontSize: 13, marginLeft: spacing.sm },
});
