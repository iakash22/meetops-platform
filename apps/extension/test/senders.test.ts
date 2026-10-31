import { describe, expect, it } from 'vitest';
import {
  classifySender,
  isTrustedOffscreenSender,
  mayUseAuthAndTaskReads,
} from '../src/lib/senders.js';

const urls = {
  runtimeId: 'ext',
  popupUrl: 'chrome-extension://ext/popup.html',
  sidePanelUrl: 'chrome-extension://ext/sidepanel.html',
  offscreenUrl: 'chrome-extension://ext/offscreen.html',
  backgroundUrl: 'chrome-extension://ext/background.js',
};

describe('sender checks', () => {
  it('offscreen trusts only the service worker', () => {
    expect(isTrustedOffscreenSender({ id: 'ext', url: urls.backgroundUrl }, urls)).toBe(true);
    expect(isTrustedOffscreenSender({ id: 'ext', url: urls.popupUrl }, urls)).toBe(false);
    expect(
      isTrustedOffscreenSender({ id: 'ext', url: 'chrome-extension://ext/x.html' }, urls),
    ).toBe(false);
    expect(isTrustedOffscreenSender({ id: 'ext' }, urls)).toBe(false);
    expect(isTrustedOffscreenSender({ id: 'other', url: urls.backgroundUrl }, urls)).toBe(false);
  });

  it('classifies popup and offscreen pages', () => {
    expect(classifySender({ id: 'ext', url: urls.popupUrl }, urls)).toMatchObject({
      fromPopup: true,
      fromOffscreen: false,
    });
    expect(classifySender({ id: 'ext', url: urls.offscreenUrl }, urls)).toMatchObject({
      fromPopup: false,
      fromOffscreen: true,
    });
    expect(classifySender({ id: 'x', url: urls.popupUrl }, urls)).toMatchObject({
      fromSelf: false,
      fromPopup: false,
    });
  });
});

describe('popup sender must not be a tab', () => {
  it('rejects popup.html opened as a normal tab', () => {
    expect(classifySender({ id: 'ext', url: urls.popupUrl, tab: { id: 5 } }, urls).fromPopup).toBe(
      false,
    );
    expect(classifySender({ id: 'ext', url: urls.popupUrl }, urls).fromPopup).toBe(true);
  });
});

describe('side panel sender', () => {
  const side = { id: 'ext', url: urls.sidePanelUrl };

  it('may sign in and read tasks, like the popup', () => {
    expect(mayUseAuthAndTaskReads(classifySender(side, urls))).toBe(true);
    expect(mayUseAuthAndTaskReads(classifySender({ id: 'ext', url: urls.popupUrl }, urls))).toBe(
      true,
    );
  });

  it('is never treated as the popup, so it cannot start a recording', () => {
    expect(classifySender(side, urls)).toMatchObject({ fromSidePanel: true, fromPopup: false });
  });

  it('rejects sidepanel.html opened as a tab, other extensions and other pages', () => {
    for (const s of [
      { ...side, tab: { id: 1 } },
      { id: 'other', url: urls.sidePanelUrl },
      { id: 'ext', url: urls.offscreenUrl },
      { id: 'ext', url: 'chrome-extension://ext/x.html' },
    ])
      expect(mayUseAuthAndTaskReads(classifySender(s, urls))).toBe(false);
  });
});
