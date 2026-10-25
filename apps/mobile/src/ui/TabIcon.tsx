import { StyleSheet, View } from 'react-native';

export type TabIconName = 'meetings' | 'record' | 'tasks' | 'account';

/**
 * Tab glyphs drawn with plain Views (no icon font dependency). Decorative: the tab's
 * accessibility label carries the meaning.
 */
export function TabIcon({ name, color }: { name: TabIconName; color: string }) {
  return (
    <View
      style={styles.box}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={`tab-icon-${name}`}
    >
      {name === 'meetings' ? (
        <View style={[styles.calendar, { borderColor: color }]}>
          <View style={[styles.calendarBar, { backgroundColor: color }]} />
        </View>
      ) : null}
      {name === 'record' ? (
        <View style={[styles.ring, { borderColor: color }]}>
          <View style={[styles.dot, { backgroundColor: color }]} />
        </View>
      ) : null}
      {name === 'tasks' ? (
        <View style={styles.lines}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.lineRow}>
              <View style={[styles.bullet, { borderColor: color }]} />
              <View style={[styles.line, { backgroundColor: color }]} />
            </View>
          ))}
        </View>
      ) : null}
      {name === 'account' ? (
        <View style={styles.person}>
          <View style={[styles.head, { borderColor: color }]} />
          <View style={[styles.body, { borderColor: color }]} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  calendar: { width: 20, height: 18, borderWidth: 2, borderRadius: 4, overflow: 'hidden' },
  calendarBar: { height: 4 },
  ring: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  lines: { gap: 3 },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  bullet: { width: 5, height: 5, borderWidth: 1.5, borderRadius: 1 },
  line: { width: 13, height: 2, borderRadius: 1 },
  person: { alignItems: 'center' },
  head: { width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
  body: {
    width: 18,
    height: 9,
    borderTopLeftRadius: 9,
    borderTopRightRadius: 9,
    borderWidth: 2,
    borderBottomWidth: 0,
    marginTop: 2,
  },
});
