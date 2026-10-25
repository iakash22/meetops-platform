import { colors } from '../theme/colors';

/** Dark stack styling shared by every navigator. */
export const stackScreenOptions = {
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.foreground,
  headerTitleStyle: { color: colors.foreground },
  headerShadowVisible: false,
  contentStyle: { backgroundColor: colors.background },
} as const;
