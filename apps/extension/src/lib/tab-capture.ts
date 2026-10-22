/// <reference types="chrome" />

/**
 * Typed wrapper over the promise form of chrome.tabCapture.getMediaStreamId.
 * Must be called from a user gesture (popup click / action invocation).
 */
export async function getTabStreamId(targetTabId: number): Promise<string> {
  const id = await chrome.tabCapture.getMediaStreamId({ targetTabId });
  if (typeof id !== 'string' || id.length === 0)
    throw new Error('tabCapture returned no stream id');
  return id;
}
