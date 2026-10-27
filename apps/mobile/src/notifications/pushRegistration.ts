/**
 * Push device registration (ADR-013: Expo Push for mobile; user-scoped `PushDevice`, token encrypted at rest and
 * revoked with the session).
 *
 * Two seams keep this independent of the native module and of the auth transport (ADR-005 mobile amendment, #193):
 * - `PushTokenProvider` asks the OS for permission and returns the Expo push token. The real one wraps
 *   `expo-notifications` (not a dependency yet; adding it is a lockfile-owning follow-up).
 * - `PushDeviceApi` registers or revokes the token with the API. The HTTP version goes through the app's
 *   authenticated client, so it works whether mobile auth ends up as bearer header tokens or something else.
 *
 * Rules: we only ask for OS permission after an explicit tap, never on launch; we never log the token.
 */
export type PushPermission = 'granted' | 'denied' | 'undetermined';
export type PushPlatform = 'ios' | 'android';

export interface PushTokenProvider {
  getPermission(): Promise<PushPermission>;
  /** Shows the OS prompt. Only call this from a user action. */
  requestPermission(): Promise<PushPermission>;
  /** Expo push token (`ExponentPushToken[...]`). Only call this when permission is granted. */
  getToken(): Promise<string>;
}

/**
 * Mobile (expo) variant of `RegisterPushDeviceRequest` from @meetops/contracts v0.10.0 (#263). Kept local and
 * identical until #263 merges into integration/phase-1; then import it from contracts.
 */
export interface RegisterPushDeviceRequest {
  provider: 'expo';
  token: string;
  platform: PushPlatform;
  deviceName?: string;
}

/** `PushDevice` (201 response of `POST /me/push-devices`). */
export interface RegisteredPushDevice {
  id: string;
  platform: PushPlatform;
  createdAt: string;
}

export const PUSH_DEVICE_PATHS = {
  pushDevices: '/me/push-devices',
  pushDevice: '/me/push-devices/:id',
} as const;

export interface PushDeviceApi {
  register(body: RegisterPushDeviceRequest): Promise<RegisteredPushDevice>;
  /** `DELETE /me/push-devices/:id`. Always 204 (idempotent). */
  unregister(id: string): Promise<void>;
}

export type PushRegistrationState =
  | { status: 'off' }
  | { status: 'denied' }
  | { status: 'on'; device: RegisteredPushDevice }
  | { status: 'error'; message: string };

export interface PushRegistrationService {
  current(): Promise<PushRegistrationState>;
  enable(): Promise<PushRegistrationState>;
  disable(): Promise<PushRegistrationState>;
}

export function createPushRegistrationService(
  provider: PushTokenProvider,
  api: PushDeviceApi,
  platform: PushPlatform,
): PushRegistrationService {
  let device: RegisteredPushDevice | null = null;
  return {
    async current() {
      if (device) return { status: 'on', device };
      return (await provider.getPermission()) === 'denied'
        ? { status: 'denied' }
        : { status: 'off' };
    },
    async enable() {
      try {
        let permission = await provider.getPermission();
        if (permission !== 'granted') permission = await provider.requestPermission();
        if (permission !== 'granted') return { status: 'denied' };
        const token = await provider.getToken();
        device = await api.register({ provider: 'expo', token, platform });
        return { status: 'on', device };
      } catch {
        return { status: 'error', message: 'Could not turn on notifications. Try again.' };
      }
    },
    async disable() {
      try {
        if (device) await api.unregister(device.id);
        device = null;
        return { status: 'off' };
      } catch {
        return { status: 'error', message: 'Could not turn off notifications. Try again.' };
      }
    },
  };
}

/** Demo provider: simulates the OS prompt. No native module, nothing leaves the device. */
export function createDemoPushTokenProvider(answer: PushPermission = 'granted'): PushTokenProvider {
  let permission: PushPermission = 'undetermined';
  return {
    getPermission: () => Promise.resolve(permission),
    requestPermission: () => {
      permission = answer;
      return Promise.resolve(permission);
    },
    getToken: () => Promise.resolve('ExponentPushToken[demo]'),
  };
}

/** Demo API: keeps the registration in memory. */
export function createDemoPushDeviceApi(): PushDeviceApi {
  let n = 0;
  return {
    register: (body) =>
      Promise.resolve({
        id: `demo-device-${++n}`,
        platform: body.platform,
        createdAt: new Date().toISOString(),
      }),
    unregister: () => Promise.resolve(),
  };
}

type Requester = <T>(
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  expect?: number,
) => Promise<T>;

const isDevice = (v: unknown): v is RegisteredPushDevice =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { id?: unknown }).id === 'string' &&
  typeof (v as { createdAt?: unknown }).createdAt === 'string' &&
  ['ios', 'android'].includes((v as { platform?: unknown }).platform as string);

/** HTTP `PushDeviceApi` over the authenticated mobile requester (Bearer). */
export function createHttpPushDeviceApi(request: Requester): PushDeviceApi {
  return {
    async register(body) {
      const device = await request<unknown>('POST', PUSH_DEVICE_PATHS.pushDevices, body, 201);
      // Only report "on" once the server has confirmed with a well-formed PushDevice.
      if (!isDevice(device)) throw new Error('Unexpected push device response');
      return device;
    },
    async unregister(id) {
      await request<void>(
        'DELETE',
        PUSH_DEVICE_PATHS.pushDevice.replace(':id', encodeURIComponent(id)),
        undefined,
        204,
      );
    },
  };
}
