import { sha256Base64Of } from './sha256';

/**
 * sha256 (standard base64) of a file, computed in a module Web Worker. Falls back to the main thread
 * only where Worker is unavailable (tests, very old browsers). The worker is terminated on finish/abort.
 */
export function hashFile(file: Blob, signal?: AbortSignal): Promise<string> {
  if (typeof Worker === 'undefined') return sha256Base64Of(file);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sha256.worker.ts', import.meta.url), { type: 'module' });
    const done = () => worker.terminate();
    signal?.addEventListener(
      'abort',
      () => {
        done();
        reject(new DOMException('Hash aborted', 'AbortError'));
      },
      { once: true },
    );
    worker.onmessage = (e: MessageEvent<{ ok: boolean; digest?: string }>) => {
      done();
      if (e.data.ok && e.data.digest) resolve(e.data.digest);
      else reject(new Error('Could not read the file.'));
    };
    worker.onerror = () => {
      done();
      reject(new Error('Could not read the file.'));
    };
    worker.postMessage(file);
  });
}
