import type { ExtensionPairRequest, PairingCodeMessage } from '@meetops/contracts';
import { PAIRING_CODE_MESSAGE_TYPE } from '@meetops/contracts/types';

/** Mirrors contracts ExtensionPairRequest field formats (ADR-005 A1.1). Server re-validates. */
const EXTENSION_ID = /^[a-p]{32}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const PAIRING_CODE = /^[A-Za-z0-9_-]{32,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** SafeDisplayText-style: printable, no HTML-significant, control, or bidi/format characters. */
const UNSAFE_LABEL_CHARS = new Set(['<', '>', '"', "'", '&']);
function isUnsafeLabelChar(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    c <= 0x1f ||
    (c >= 0x7f && c <= 0x9f) ||
    (c >= 0x200b && c <= 0x200f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    (c >= 0x202a && c <= 0x202e) ||
    c === 0x2060 ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0xfeff ||
    c === 0x061c ||
    UNSAFE_LABEL_CHARS.has(ch)
  );
}

export type PairSearch = {
  extensionId?: string;
  deviceId?: string;
  nonce?: string;
  deviceLabel?: string;
};

export function parsePairSearch(search: Record<string, unknown>): PairSearch {
  const out: PairSearch = {};
  for (const key of ['extensionId', 'deviceId', 'nonce', 'deviceLabel'] as const) {
    const v = search[key];
    if (typeof v === 'string' && v) out[key] = v;
  }
  return out;
}

/** Build the pair request from the URL, or null if anything is missing or malformed. */
export function toPairRequest(search: PairSearch): ExtensionPairRequest | null {
  const { extensionId, deviceId, nonce, deviceLabel } = search;
  if (!extensionId || !EXTENSION_ID.test(extensionId)) return null;
  if (!deviceId || !UUID.test(deviceId)) return null;
  if (!nonce || !NONCE.test(nonce)) return null;
  const label = deviceLabel?.trim();
  const validLabel =
    label && label.length <= 100 && ![...label].some(isUnsafeLabelChar) ? label : undefined;
  return { extensionId, deviceId, nonce, ...(validLabel ? { deviceLabel: validLabel } : {}) };
}

/** The strict PairingCodeMessage: exactly these three keys. */
export function buildPairingMessage(pairingCode: string, nonce: string): PairingCodeMessage {
  return { type: PAIRING_CODE_MESSAGE_TYPE, pairingCode, nonce };
}

export function isValidPairingCode(code: unknown): code is string {
  return typeof code === 'string' && PAIRING_CODE.test(code);
}

type ChromeRuntime = {
  sendMessage: (
    extensionId: string,
    message: unknown,
    callback: (response: unknown) => void,
  ) => void;
  lastError?: { message?: string } | undefined;
};

export class ExtensionUnavailableError extends Error {
  constructor(readonly reason: 'no-runtime' | 'not-reachable') {
    super(reason === 'no-runtime' ? 'chrome.runtime unavailable' : 'Extension not reachable');
    this.name = 'ExtensionUnavailableError';
  }
}

export function getChromeRuntime(): ChromeRuntime | null {
  const rt = (globalThis as { chrome?: { runtime?: Partial<ChromeRuntime> } }).chrome?.runtime;
  return rt && typeof rt.sendMessage === 'function' ? (rt as ChromeRuntime) : null;
}

/** Send the message via chrome.runtime.sendMessage(extensionId, …). Rejects if the extension can't be reached. */
export function sendPairingMessage(
  extensionId: string,
  message: PairingCodeMessage,
): Promise<unknown> {
  const rt = getChromeRuntime();
  if (!rt) return Promise.reject(new ExtensionUnavailableError('no-runtime'));
  return new Promise((resolve, reject) => {
    try {
      rt.sendMessage(extensionId, message, (response) => {
        if (rt.lastError) reject(new ExtensionUnavailableError('not-reachable'));
        else resolve(response);
      });
    } catch {
      reject(new ExtensionUnavailableError('not-reachable'));
    }
  });
}
