/// <reference types="chrome" />
import { handleBackgroundMessage, type BackgroundDeps } from "../src/lib/background-handler.js";
import { sessionKV } from "../src/lib/storage.js";

const OFFSCREEN_PATH = "/offscreen.html";

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  return contexts.length > 0;
}

const deps: BackgroundDeps = {
  kv: sessionKV(),
  now: () => Date.now(),
  async ensureOffscreen() {
    if (await hasOffscreen()) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Record the tab audio the user explicitly chose to record, after consent."
    });
  },
  async closeOffscreen() {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  },
  async sendToOffscreen(msg) {
    const res = await chrome.runtime.sendMessage<typeof msg, { ok: boolean; error?: string } | undefined>(msg);
    if (!res?.ok) throw new Error(res?.error ?? "Offscreen document did not respond");
    return res;
  }
};

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if ((msg as { target?: string } | null)?.target !== "background") return false;
    const fromSelf = sender.id === chrome.runtime.id;
    const fromOffscreen = fromSelf && sender.url === chrome.runtime.getURL(OFFSCREEN_PATH);
    handleBackgroundMessage(deps, msg, { fromSelf, fromOffscreen }).then(sendResponse, (err: unknown) =>
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
    );
    return true;
  });
});
