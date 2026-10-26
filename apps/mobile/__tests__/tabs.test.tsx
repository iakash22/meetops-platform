import '@testing-library/react-native/extend-expect';
import { render } from '@testing-library/react-native';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { Animated, StyleSheet } from 'react-native';

import { colors } from '../src/theme/colors';
import { tabScreenOptions } from '../src/ui/navigation';
import { TabIcon } from '../src/ui/TabIcon';
import { account, makeManager, routes } from './support/appRoutes';

interface HostNode {
  type: unknown;
  props: { style?: unknown; testID?: string };
}

async function signedIn(initialUrl = '/') {
  const ctx = makeManager();
  await ctx.manager.signIn(account);
  renderRouter(routes(ctx.manager), { initialUrl });
  await act(async () => {});
  return ctx;
}

// Skeleton shimmer and live-dot pulse are covered in ui/record tests; stub loops here to keep act() quiet.
beforeEach(() => {
  jest
    .spyOn(Animated, 'loop')
    .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() });
});
afterEach(async () => {
  // Let placeholder repositories of tabs that mounted late settle inside act().
  await act(async () => {});
  jest.restoreAllMocks();
});

describe('bottom tabs', () => {
  it('renders the four tabs with accessibility labels', async () => {
    await signedIn();
    const tabs: [string, string][] = [
      ['tab-meetings', 'Meetings tab'],
      ['tab-record', 'Record tab'],
      ['tab-tasks', 'Tasks tab'],
      ['tab-account', 'Account tab'],
    ];
    for (const [id, label] of tabs) {
      const tab = await screen.findByTestId(id);
      expect(tab).toHaveProp('accessibilityLabel', label);
    }
    expect(screen.getByTestId('tab-meetings')).toBeSelected();
    expect(screen.getByTestId('tab-tasks')).not.toBeSelected();
    expect(await screen.findAllByTestId('meeting-row')).toHaveLength(4);
  });

  it('navigates between tabs', async () => {
    await signedIn();
    await screen.findAllByTestId('meeting-row');

    fireEvent.press(screen.getByTestId('tab-record'));
    await waitFor(() => expect(screen).toHavePathname('/record'));
    expect(await screen.findByTestId('record-button')).toBeTruthy();
    expect(screen.getByTestId('tab-record')).toBeSelected();

    fireEvent.press(screen.getByTestId('tab-tasks'));
    await waitFor(() => expect(screen).toHavePathname('/tasks'));
    expect(await screen.findAllByTestId('task-row')).toHaveLength(3);

    fireEvent.press(screen.getByTestId('tab-account'));
    await waitFor(() => expect(screen).toHavePathname('/account'));
    expect(await screen.findByTestId('account-email')).toHaveTextContent(account.email);

    fireEvent.press(screen.getByTestId('tab-meetings'));
    await waitFor(() => expect(screen).toHavePathname('/'));
  });

  it('tints the active tab rose and inactive tabs muted on a dark bar', () => {
    expect(tabScreenOptions.tabBarActiveTintColor).toBe(colors.link);
    expect(tabScreenOptions.tabBarInactiveTintColor).toBe(colors.mutedForeground);
    expect(tabScreenOptions.tabBarStyle.backgroundColor).toBe(colors.card);
    const icon = render(<TabIcon name="tasks" color={colors.link} />);
    const colorsUsed = icon
      .getByTestId('tab-icon-tasks', { includeHiddenElements: true })
      .findAll((n: HostNode) => typeof n.type === 'string' && n.props.testID === undefined)
      .map(
        (n: HostNode) =>
          StyleSheet.flatten(n.props.style as object) as {
            borderColor?: string;
            backgroundColor?: string;
          },
      )
      .flatMap((st: { borderColor?: string; backgroundColor?: string }) => [
        st.borderColor,
        st.backgroundColor,
      ])
      .filter(Boolean);
    expect(colorsUsed.length).toBeGreaterThan(0);
    expect(colorsUsed.every((c: string | undefined) => c === colors.link)).toBe(true);
  });

  it('account shows org, role and app version, and opens the switcher', async () => {
    await signedIn('/account');
    expect(await screen.findByTestId('account-org')).toHaveTextContent('Demo Organization');
    expect(screen.getByTestId('account-role')).toBeTruthy();
    expect(screen.getByTestId('app-version')).toHaveTextContent(/MeetOps \S+/);
    expect(screen.getByTestId('sign-out')).toHaveProp('accessibilityLabel', 'Sign out');
    fireEvent.press(screen.getByTestId('account-switch-org'));
    await waitFor(() => expect(screen).toHavePathname('/organizations'));
    fireEvent.press(await screen.findByTestId('org-second-org'));
    await waitFor(() => expect(screen).toHavePathname('/account'));
    expect(await screen.findByTestId('account-org')).toHaveTextContent('Second Org');
  });

  it('sign out from the account tab wipes tokens and runs wipe hooks', async () => {
    const { manager, store } = await signedIn('/account');
    const wipe = jest.fn();
    manager.registerWipeHook(wipe);
    fireEvent.press(await screen.findByTestId('sign-out'));
    await waitFor(() => expect(screen).toHavePathname('/login'));
    expect(await store.load()).toBeNull();
    expect(wipe).toHaveBeenCalledTimes(1);
  });
});
