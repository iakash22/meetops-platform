import { Tabs } from 'expo-router';

import { TabIcon, type TabIconName } from '../../../src/ui/TabIcon';
import { tabScreenOptions } from '../../../src/ui/navigation';

const TABS: { name: string; title: string; icon: TabIconName }[] = [
  { name: 'index', title: 'Meetings', icon: 'meetings' },
  { name: 'record', title: 'Record', icon: 'record' },
  { name: 'tasks', title: 'Tasks', icon: 'tasks' },
  { name: 'account', title: 'Account', icon: 'account' },
];

/** Bottom tabs for signed-in users. The guard lives in the parent `(app)` layout. */
export default function TabsLayout() {
  return (
    <Tabs screenOptions={tabScreenOptions}>
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: tab.title,
            tabBarAccessibilityLabel: `${tab.title} tab`,
            tabBarButtonTestID: `tab-${tab.icon}`,
            tabBarIcon: ({ color }) => <TabIcon name={tab.icon} color={color} />,
          }}
        />
      ))}
    </Tabs>
  );
}
