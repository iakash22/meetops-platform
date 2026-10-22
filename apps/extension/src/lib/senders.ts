/** Sender classification for runtime messages (pure, so it can be unit-tested). */
export interface RawSender {
  id?: string | undefined;
  url?: string | undefined;
  /** Set when the sender is a page in a tab (e.g. popup.html opened as a normal tab). */
  tab?: unknown;
}

export interface ExtensionUrls {
  runtimeId: string;
  popupUrl: string;
  offscreenUrl: string;
  /** Service worker script URL; messages from the SW carry it as sender.url and have no tab. */
  backgroundUrl: string;
}

export function classifySender(sender: RawSender, urls: ExtensionUrls) {
  const fromSelf = sender.id === urls.runtimeId;
  return {
    fromSelf,
    // The real action popup has no tab; popup.html opened as a tab has the same URL but a tab.
    fromPopup: fromSelf && sender.url === urls.popupUrl && sender.tab === undefined,
    fromOffscreen: fromSelf && sender.url === urls.offscreenUrl,
    fromBackground: fromSelf && sender.url === urls.backgroundUrl,
  };
}

/** The offscreen recorder only obeys the background service worker. */
export function isTrustedOffscreenSender(sender: RawSender, urls: ExtensionUrls): boolean {
  return classifySender(sender, urls).fromBackground;
}

export function extensionUrls(): ExtensionUrls {
  return {
    runtimeId: chrome.runtime.id,
    popupUrl: chrome.runtime.getURL('/popup.html'),
    offscreenUrl: chrome.runtime.getURL('/offscreen.html'),
    backgroundUrl: chrome.runtime.getURL('/background.js'),
  };
}
