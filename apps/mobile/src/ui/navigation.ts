import { colors } from '../theme/colors';

/** Dark stack styling shared by every navigator. */
export const stackScreenOptions = {
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.foreground,
  headerTitleStyle: { color: colors.foreground },
  headerShadowVisible: false,
  contentStyle: { backgroundColor: colors.background },
} as const;

/** Dark bottom tab bar: rose marks the active tab (the one rose element in the chrome). */
export const tabScreenOptions = {
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.foreground,
  headerTitleStyle: { color: colors.foreground },
  headerShadowVisible: false,
  sceneStyle: { backgroundColor: colors.background },
  tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border },
  tabBarActiveTintColor: colors.link,
  tabBarInactiveTintColor: colors.mutedForeground,
  tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
} as const;
