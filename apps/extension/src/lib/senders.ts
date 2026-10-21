/** Sender classification for runtime messages (pure, so it can be unit-tested). */
export interface RawSender {
  id?: string | undefined;
  url?: string | undefined;
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
    fromPopup: fromSelf && sender.url === urls.popupUrl,
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
