/// <reference types="chrome" />
import {
  handleBackgroundMessage,
  serialized,
  type BackgroundDeps,
} from '../src/lib/background-handler.js';
import { classifySender, extensionUrls } from '../src/lib/senders.js';
import { sessionKV } from '../src/lib/storage.js';

const OFFSCREEN_PATH = '/offscreen.html';

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

const deps: BackgroundDeps = {
  kv: sessionKV(),
  now: () => Date.now(),
  async capturedTabIds() {
    const tabs = await new Promise<chrome.tabCapture.CaptureInfo[]>((resolve) => {
      chrome.tabCapture.getCapturedTabs(resolve);
    });
    return tabs.filter((t) => t.status === 'active' || t.status === 'pending').map((t) => t.tabId);
  },
  async setBadge(text) {
    await chrome.action.setBadgeText({ text });
    if (text)
      await chrome.action.setBadgeBackgroundColor({ color: text === '!' ? '#b45309' : '#dc2626' });
  },
  async ensureOffscreen() {
    if (await hasOffscreen()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Record the tab audio the user explicitly chose to record, after consent.',
    });
  },
  async closeOffscreen() {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  },
  async sendToOffscreen(msg) {
    const res = await chrome.runtime.sendMessage<
      typeof msg,
      { ok: boolean; error?: string } | undefined
    >(msg);
    if (!res?.ok) throw new Error(res?.error ?? 'Offscreen document did not respond');
    return res;
  },
};

const handle = serialized(handleBackgroundMessage);

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if ((msg as { target?: string } | null)?.target !== 'background') return false;
    const { fromSelf, fromOffscreen, fromPopup } = classifySender(sender, extensionUrls());
    handle(deps, msg, { fromSelf, fromOffscreen, fromPopup }).then(sendResponse, (err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  });
});
