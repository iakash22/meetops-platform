import { handleMessage, type RecorderState } from "../src/lib/messages";

export default defineBackground(() => {
  let state: RecorderState = { status: "idle" };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only accept messages from this extension's own pages (the popup).
    if (sender.id !== chrome.runtime.id) return false;
    const result = handleMessage(state, msg);
    state = result.state;
    sendResponse(result.response);
    return false;
  });
});
