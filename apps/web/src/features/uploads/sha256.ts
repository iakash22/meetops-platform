/** Standard base64 sha256 (contracts Sha256Base64) of a whole Blob. Shared by the worker and the fallback. */
export async function sha256Base64Of(file: Blob): Promise<string> {
  const bytes = await readBytes(file);
  // Copy into this realm's Uint8Array: WebCrypto rejects ArrayBuffers from another realm (e.g. jsdom FileReader).
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array(new Uint8Array(bytes))),
  );
  let bin = '';
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin);
}

function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsArrayBuffer(file);
  });
}
