import { describe, expect, it } from 'vitest';
import { classifySender, isTrustedOffscreenSender } from '../src/lib/senders.js';

const urls = {
  runtimeId: 'ext',
  popupUrl: 'chrome-extension://ext/popup.html',
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
