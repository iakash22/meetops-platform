import '@testing-library/react-native/extend-expect';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { createDemoConsentApi, type ConsentApi } from '../src/consent/consentApi';
import { RepositoriesProvider } from '../src/data/RepositoriesProvider';
import { RecordScreen } from '../src/screens/RecordScreen';
import { makeRepositories } from './support/appRoutes';

async function renderWith(consent: ConsentApi) {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  render(
    <RepositoriesProvider value={makeRepositories({ consent })}>
      <RecordScreen />
    </RepositoriesProvider>,
  );
  await act(async () => {});
}

async function press(testID: string) {
  fireEvent.press(screen.getByTestId(testID));
  await act(async () => {});
}

afterEach(() => jest.restoreAllMocks());

describe('recording consent (R1, R3)', () => {
  it('requires explicit opt-in, then the participant notice, before start', async () => {
    const consent = createDemoConsentApi();
    await renderWith(consent);
    await press('record-button');
    expect(screen.getByTestId('consent-optIn')).toBeOnTheScreen();
    expect(screen.getByTestId('record-status', { includeHiddenElements: true })).toHaveTextContent(
      'Ready',
    );

    await press('consent-optIn-accept');
    expect(screen.getByTestId('consent-notice')).toBeOnTheScreen();
    expect(screen.getByTestId('record-status', { includeHiddenElements: true })).toHaveTextContent(
      'Ready',
    );
    expect(consent.notices).toHaveLength(0);

    await press('consent-notice-accept');
    expect(screen.getByTestId('record-status', { includeHiddenElements: true })).toHaveTextContent(
      'Recording',
    );
    expect(consent.notices).toHaveLength(1);
    expect(consent.notices[0]?.meetingId).toMatch(/^local-/);
  });

  it('asks for the participant notice again for every recording, but opt-in only once', async () => {
    const consent = createDemoConsentApi();
    await renderWith(consent);
    await press('record-button');
    await press('consent-optIn-accept');
    await press('consent-notice-accept');
    await press('record-button'); // stop
    await press('record-done');
    await press('record-button');
    expect(screen.queryByTestId('consent-optIn')).toBeNull();
    expect(screen.getByTestId('consent-notice')).toBeOnTheScreen();
    expect(screen.getByTestId('record-status', { includeHiddenElements: true })).toHaveTextContent(
      'Ready',
    );
  });

  it('cancelling never starts a recording', async () => {
    await renderWith(createDemoConsentApi());
    await press('record-button');
    await press('consent-optIn-cancel');
    expect(screen.queryByTestId('consent-optIn')).toBeNull();
    expect(screen.getByTestId('record-status', { includeHiddenElements: true })).toHaveTextContent(
      'Ready',
    );
  });

  it('fails closed when the notice cannot be logged', async () => {
    const consent: ConsentApi = {
      hasOptedIn: async () => true,
      optIn: async () => undefined,
      confirmParticipantNotice: () => Promise.reject(new Error('offline')),
    };
    await renderWith(consent);
    await press('record-button');
    await press('consent-notice-accept');
    expect(screen.getByTestId('consent-error')).toHaveTextContent(/hasn't started/);
    expect(screen.getByTestId('record-status', { includeHiddenElements: true })).toHaveTextContent(
      'Ready',
    );
  });

  it('demo API refuses a notice without opt-in', async () => {
    await expect(
      createDemoConsentApi().confirmParticipantNotice({ meetingId: 'm', confirmedAt: 'now' }),
    ).rejects.toThrow(/Opt-in/);
  });
});
