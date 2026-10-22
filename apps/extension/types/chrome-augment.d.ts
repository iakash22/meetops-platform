// @types/chrome 0.0.280 only declares the callback form of getMediaStreamId.
// Chrome 116+ also returns a Promise when the callback is omitted.
declare namespace chrome.tabCapture {
  export function getMediaStreamId(options?: GetMediaStreamOptions): Promise<string>;
}
