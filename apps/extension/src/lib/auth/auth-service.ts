/**
 * ADR-005 (amendment 1) pairing and token lifecycle for the extension.
 *
 * user click -> nonce (storage.session) -> web pairing page -> onMessageExternal { pairingCode, nonce }
 *   -> POST /auth/extension-token -> ExtensionTokenResponse (nonce echoed) -> tokens in storage.session.
 *
 * Tokens live only in chrome.storage.session (default TRUSTED_CONTEXTS access level; setAccessLevel is never called)
 * and are never logged. The bearer header is attached only to requests whose origin is exactly the API origin.
 */
import { EXTENSION_AUTH_PATHS } from '@meetops/contracts/types';
import type {
  ExtensionRefreshRequest,
  ExtensionRefreshResponse,
  ExtensionRevokeRequest,
  ExtensionTokenRequest,
  ExtensionTokenResponse,
} from '@meetops/contracts/types';
import type { KV } from '../storage.js';
import { NONCE_TTL_MS, REFRESH_SKEW_MS, WEB_PAIR_PATH, type AuthConfig } from './config.js';
import type { AuthStatus, RepairReason } from './messages.js';
import type { Validators } from './validate.js';

export const NONCE_KEY = 'auth.nonce';
export const TOKENS_KEY = 'auth.tokens';
export const REPAIR_KEY = 'auth.repair';
export const DEVICE_ID_KEY = 'auth.deviceId';

interface StoredNonce {
  value: string;
  createdAt: number;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Epoch ms; the refresh family's hard limit (30 days from pairing). */
  refreshExpiresAt: number;
  organizationId: string;
  scopes: string[];
}

export class NotPairedError extends Error {
  constructor(readonly reason?: RepairReason) {
    super(reason ? `Extension must be paired again (${reason})` : 'Extension is not paired');
    this.name = 'NotPairedError';
  }
}

export class BearerScopeError extends Error {
  constructor(origin: string) {
    super(`Refusing to send credentials to ${origin}`);
    this.name = 'BearerScopeError';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AuthDeps {
  /** chrome.storage.session wrapper: nonce and tokens. */
  session: KV;
  /** Non-secret per-install data (deviceId); chrome.storage.local in production. */
  install: KV;
  config: AuthConfig;
  extensionId: string;
  now: () => number;
  fetch: FetchLike;
  randomBytes: (n: number) => Uint8Array;
  randomUUID: () => string;
  openTab: (url: string) => Promise<void>;
  validators: Validators;
}

/** Minimal sender shape of chrome.runtime.MessageSender used for the origin check. */
export interface ExternalSender {
  origin?: string | undefined;
  url?: string | undefined;
  id?: string | undefined;
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' };

export class AuthService {
  private refreshing: Promise<StoredTokens> | undefined;
  private exchanging = false;

  constructor(private readonly d: AuthDeps) {}

  private async deviceId(): Promise<string> {
    let id = await this.d.install.get<string>(DEVICE_ID_KEY);
    if (typeof id !== 'string' || id.length === 0) {
      id = this.d.randomUUID();
      await this.d.install.set(DEVICE_ID_KEY, id);
    }
    return id;
  }

  async status(): Promise<AuthStatus> {
    const t = await this.d.session.get<StoredTokens>(TOKENS_KEY);
    if (t && t.refreshExpiresAt > this.d.now()) {
      return { state: 'paired', organizationId: t.organizationId, expiresAt: t.expiresAt };
    }
    const reason =
      (await this.d.session.get<RepairReason>(REPAIR_KEY)) ?? (t ? 'expired' : undefined);
    if (reason) return { state: 'repair_required', reason };
    const n = await this.liveNonce();
    return { state: n ? 'pairing' : 'unpaired' };
  }

  private async liveNonce(): Promise<StoredNonce | undefined> {
    const n = await this.d.session.get<StoredNonce>(NONCE_KEY);
    if (!n) return undefined;
    if (this.d.now() - n.createdAt >= NONCE_TTL_MS || n.createdAt > this.d.now()) {
      await this.d.session.remove(NONCE_KEY);
      return undefined;
    }
    return n;
  }

  /**
   * Start pairing. Call only from a user gesture (the popup's Pair click). Generates a fresh single-use nonce
   * (256 bits), replacing any previous one, and opens the web pairing page.
   */
  async startPairing(): Promise<void> {
    const nonce: StoredNonce = {
      value: base64url(this.d.randomBytes(32)),
      createdAt: this.d.now(),
    };
    const deviceId = await this.deviceId();
    await this.d.session.set(NONCE_KEY, nonce);
    const q = new URLSearchParams({
      extensionId: this.d.extensionId,
      deviceId,
      nonce: nonce.value,
    });
    // Fragment, not query: never sent to the server or logged by proxies.
    await this.d.openTab(`${this.d.config.webOrigin}${WEB_PAIR_PATH}#${q.toString()}`);
  }

  /**
   * chrome.runtime.onMessageExternal handler body. Returns true only when the handoff was accepted and tokens stored.
   * Anything invalid is dropped silently (no response detail to the sender).
   */
  /** Exact string match of sender.origin against the configured (production) web origin. */
  acceptsOrigin(sender: ExternalSender): boolean {
    return typeof sender.origin === 'string' && sender.origin === this.d.config.webOrigin;
  }

  async handleExternalMessage(msg: unknown, sender: ExternalSender): Promise<boolean> {
    if (!this.acceptsOrigin(sender)) return false;
    if (!this.d.validators.pairingHandoff(msg)) return false;
    if (this.exchanging) return false;
    const stored = await this.liveNonce();
    if (!stored || stored.value !== msg.nonce) return false;
    this.exchanging = true;
    try {
      // Single use: consume before the network round trip so a replay cannot reuse it.
      await this.d.session.remove(NONCE_KEY);
      const body: ExtensionTokenRequest = {
        extensionId: this.d.extensionId,
        deviceId: await this.deviceId(),
        pairingCode: msg.pairingCode,
        nonce: stored.value,
      };
      const res = await this.post(EXTENSION_AUTH_PATHS.token, body);
      if (!res.ok) return false;
      const json: unknown = await res.json().catch(() => undefined);
      if (!this.d.validators.tokenResponse(json)) return false;
      if (json.nonce !== stored.value) return false; // echo must match
      const previous = await this.d.session.get<StoredTokens>(TOKENS_KEY);
      await this.storeTokens(json);
      if (previous && previous.refreshToken !== json.refreshToken)
        void this.revokeQuietly(previous);
      return true;
    } catch {
      return false;
    } finally {
      this.exchanging = false;
    }
  }

  private async storeTokens(
    r: ExtensionTokenResponse | ExtensionRefreshResponse,
  ): Promise<StoredTokens> {
    const t: StoredTokens = {
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
      expiresAt: Date.parse(r.expiresAt),
      refreshExpiresAt: Date.parse(r.refreshExpiresAt),
      organizationId: r.organizationId,
      scopes: [...r.scopes],
    };
    await this.d.session.set(TOKENS_KEY, t);
    await this.d.session.remove(REPAIR_KEY);
    return t;
  }

  /** Drop all credentials and ask the user to pair again. */
  async requireRepair(reason: RepairReason): Promise<void> {
    await this.d.session.remove(TOKENS_KEY);
    await this.d.session.remove(NONCE_KEY);
    await this.d.session.set(REPAIR_KEY, reason);
  }

  async unpair(): Promise<void> {
    const t = await this.d.session.get<StoredTokens>(TOKENS_KEY);
    await this.d.session.remove(TOKENS_KEY);
    await this.d.session.remove(NONCE_KEY);
    await this.d.session.remove(REPAIR_KEY);
    if (t) await this.revokeQuietly(t);
  }

  private async revokeQuietly(t: StoredTokens): Promise<void> {
    try {
      const body: ExtensionRevokeRequest = {
        extensionId: this.d.extensionId,
        deviceId: await this.deviceId(),
        refreshToken: t.refreshToken,
      };
      const res = await this.post(EXTENSION_AUTH_PATHS.revoke, body);
      if (res.ok) this.d.validators.revokeResponse(await res.json().catch(() => undefined));
    } catch {
      // Best effort: local credentials are already gone.
    }
  }

  /** POST to a token lifecycle route: no cookie, no Authorization header (ADR-005 A1.3.1). */
  private post(path: string, body: unknown): Promise<Response> {
    return this.d.fetch(this.apiUrl(path), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
  }

  private apiUrl(path: string): string {
    if (!path.startsWith('/') || path.startsWith('//')) throw new BearerScopeError(path);
    const u = new URL(path, this.d.config.apiOrigin);
    if (u.origin !== this.d.config.apiOrigin) throw new BearerScopeError(u.origin);
    return u.toString();
  }

  /** A valid access token, refreshing (rotating) it first when it is about to expire. */
  async accessToken(): Promise<string> {
    const t = await this.d.session.get<StoredTokens>(TOKENS_KEY);
    if (!t)
      throw new NotPairedError((await this.d.session.get<RepairReason>(REPAIR_KEY)) ?? undefined);
    if (t.expiresAt - REFRESH_SKEW_MS > this.d.now()) return t.accessToken;
    return (await this.refresh()).accessToken;
  }

  /** Rotate the token pair. Concurrent callers share one request, so a refresh token is never presented twice. */
  refresh(): Promise<StoredTokens> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<StoredTokens> {
    const t = await this.d.session.get<StoredTokens>(TOKENS_KEY);
    if (!t) throw new NotPairedError();
    if (t.refreshExpiresAt <= this.d.now()) {
      await this.requireRepair('expired');
      throw new NotPairedError('expired');
    }
    const body: ExtensionRefreshRequest = {
      extensionId: this.d.extensionId,
      deviceId: await this.deviceId(),
      refreshToken: t.refreshToken,
    };
    const res = await this.post(EXTENSION_AUTH_PATHS.refresh, body);
    if (res.status === 401 || res.status === 403) {
      // Reused/revoked refresh token: the server revoked the family. Pair again.
      await this.requireRepair('refresh_rejected');
      throw new NotPairedError('refresh_rejected');
    }
    if (!res.ok) throw new Error(`Token refresh failed (${res.status})`);
    const json: unknown = await res.json().catch(() => undefined);
    if (!this.d.validators.refreshResponse(json)) throw new Error('Invalid refresh response');
    if (json.organizationId !== t.organizationId) {
      await this.requireRepair('org_switch');
      void this.revokeQuietly({ ...t, refreshToken: json.refreshToken });
      throw new NotPairedError('org_switch');
    }
    if (json.refreshToken === t.refreshToken) throw new Error('Refresh did not rotate the token');
    return this.storeTokens(json);
  }

  /**
   * fetch() to the MeetOps API with `Authorization: Bearer`. Only paths on the API origin are accepted; anything else
   * (including presigned storage PUT URLs) throws BearerScopeError. On 401 it refreshes once and retries; a second 401
   * requires re-pairing.
   */
  async apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = this.apiUrl(path);
    const send = async (token: string) => {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      return this.d.fetch(url, { ...init, headers, credentials: 'omit', redirect: 'error' });
    };
    let res = await send(await this.accessToken());
    if (res.status !== 401) return res;
    res = await send((await this.refresh()).accessToken);
    if (res.status === 401) {
      await this.requireRepair('unauthorized');
      throw new NotPairedError('unauthorized');
    }
    return res;
  }

  /** apiFetch + JSON body validated with the given Value.Check guard; error bodies are validated as ApiErrorEnvelope. */
  async apiJson<T>(path: string, init: RequestInit, check: (v: unknown) => v is T): Promise<T> {
    const res = await this.apiFetch(path, init);
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const code = this.d.validators.apiError(json) ? json.error.code : 'INVALID_RESPONSE';
      throw new Error(`API ${res.status} ${code}`);
    }
    if (!check(json)) throw new Error('API response failed schema validation');
    return json;
  }
}
