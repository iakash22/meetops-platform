/// <reference lib="webworker" />
import { sha256Base64Of } from './sha256';

/** Hashes off the main thread so a 1.4 GB file never blocks input or paint. */
self.onmessage = async (e: MessageEvent<Blob>) => {
  try {
    self.postMessage({ ok: true, digest: await sha256Base64Of(e.data) });
  } catch {
    self.postMessage({ ok: false });
  }
};
