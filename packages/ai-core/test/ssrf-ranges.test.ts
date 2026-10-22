import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from '../src/security/ssrf.js';

describe('SSRF blocklist (Security lows)', () => {
  it.each([
    '192.0.2.1', '198.51.100.7', '203.0.113.255', // TEST-NET-1/2/3
    '198.18.0.1', '198.19.255.255', // benchmarking
    '100.64.0.1', '100.127.255.254', // CGNAT
    '2002:7f00:1::1', '2002:a9fe:a9fe::', // 6to4 embedding 127.0.0.1 / 169.254.169.254
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001::1', // Teredo
    '2001:db8::1', '2001:db8:ffff::1', // documentation
    '64:ff9b:1::1', '100::1',
  ])('blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '142.250.0.1', '192.0.3.1', '198.51.101.1', '203.0.114.1', '2001:4860:4860::8888', '2606:4700:4700::1111', '2003::1'])(
    'allows public %s',
    (ip) => expect(isPrivateAddress(ip)).toBe(false),
  );
});
