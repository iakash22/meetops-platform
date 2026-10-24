/** chrome.alarms names and routing. Each alarm has its own name so handlers never cross-fire. */
export const WATCHDOG_ALARM = 'meetops-recorder-watchdog';
export { NONCE_ALARM } from './auth/auth-service.js';
import { NONCE_ALARM } from './auth/auth-service.js';

export interface AlarmHandlers {
  watchdog: () => void;
  nonceExpiry: () => void;
}

/** Dispatch an alarm by exact name; unknown names are ignored. */
export function routeAlarm(name: string, h: AlarmHandlers): void {
  if (name === WATCHDOG_ALARM) h.watchdog();
  else if (name === NONCE_ALARM) h.nonceExpiry();
}
