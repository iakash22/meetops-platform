import { describe, expect, it, vi } from 'vitest';
import { NONCE_ALARM, routeAlarm, WATCHDOG_ALARM } from '../src/lib/alarms.js';

describe('alarm routing', () => {
  it('uses distinct names for the nonce expiry and the recorder watchdog', () => {
    expect(NONCE_ALARM).not.toBe(WATCHDOG_ALARM);
    expect(WATCHDOG_ALARM).toBe('meetops-recorder-watchdog');
  });

  it('the nonce alarm never triggers the watchdog, and vice versa', () => {
    const h = { watchdog: vi.fn(), nonceExpiry: vi.fn() };
    routeAlarm(NONCE_ALARM, h);
    expect(h.nonceExpiry).toHaveBeenCalledTimes(1);
    expect(h.watchdog).not.toHaveBeenCalled();
    routeAlarm(WATCHDOG_ALARM, h);
    expect(h.watchdog).toHaveBeenCalledTimes(1);
    expect(h.nonceExpiry).toHaveBeenCalledTimes(1);
    routeAlarm('other', h);
    expect(h.watchdog).toHaveBeenCalledTimes(1);
    expect(h.nonceExpiry).toHaveBeenCalledTimes(1);
  });
});
