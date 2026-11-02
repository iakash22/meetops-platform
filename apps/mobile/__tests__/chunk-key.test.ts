import { readFileSync } from 'fs';
import { join } from 'path';

import type { ChunkCryptoNative } from '../modules/chunk-crypto';
import { createNativeChunkCipher, SOFTWARE_KEY_WARNING } from '../src/record/expoAudio';

const deleteKey = jest.fn(async () => undefined);

function fakeNative(over: Partial<ChunkCryptoNative> = {}): ChunkCryptoNative {
  return {
    seal: async (b) => `s:${b}`,
    open: async (b) => b.replace(/^s:/, ''),
    deleteKey,
    ...over,
  };
}

describe('native chunk cipher (Android Keystore key)', () => {
  it('passes the self-test with a working key', async () => {
    await expect(createNativeChunkCipher(fakeNative()).ready!()).resolves.toBeUndefined();
  });

  it('fails closed when the key round-trip is wrong', async () => {
    const c = createNativeChunkCipher(fakeNative({ open: async () => 'BB==' }));
    await expect(c.ready!()).rejects.toThrow('Encryption self-test failed.');
  });

  it('fails closed when the key is unusable', async () => {
    const c = createNativeChunkCipher(
      fakeNative({ seal: () => Promise.reject(new Error('Recording key unusable')) }),
    );
    await expect(c.ready!()).rejects.toThrow('Recording key unusable');
  });

  it('refuses everything without the native module', async () => {
    const c = createNativeChunkCipher(null);
    await expect(c.ready!()).rejects.toThrow(/unavailable/);
    await expect(c.seal('AA==')).rejects.toThrow(/unavailable/);
    await expect(c.open('AA==')).rejects.toThrow(/unavailable/);
    await expect(c.keyInfo()).resolves.toBeNull();
  });

  it('reports where the key lives, or null on builds without keyInfo', async () => {
    const info = {
      alias: 'meetops_chunk_key_v1',
      algorithm: 'AES-256-GCM',
      securityLevel: 'strongbox' as const,
      keySize: 256,
    };
    await expect(
      createNativeChunkCipher(fakeNative({ keyInfo: async () => info })).keyInfo(),
    ).resolves.toEqual(info);
    await expect(createNativeChunkCipher(fakeNative()).keyInfo()).resolves.toBeNull();
  });

  it('only exposes sealFile when the native build has it', () => {
    expect('sealFile' in createNativeChunkCipher(fakeNative())).toBe(false);
    const sealFile = jest.fn(async () => []);
    const c = createNativeChunkCipher(fakeNative({ sealFile }));
    void c.sealFile!('file:///a', 'file:///d/', 4);
    expect(sealFile).toHaveBeenCalledWith('file:///a', 'file:///d/', 4);
  });

  it('deleteKey reaches the native module (logout wipe)', async () => {
    await createNativeChunkCipher(fakeNative()).deleteKey();
    expect(deleteKey).toHaveBeenCalled();
  });
});

// Native code can't compile here (no Android SDK); these guard the key spec in source until the device check.
describe('ChunkSealer.kt key spec (source guard)', () => {
  const src = readFileSync(
    join(
      __dirname,
      '../modules/chunk-crypto/android/src/main/java/expo/modules/chunkcrypto/ChunkSealer.kt',
    ),
    'utf8',
  );

  it('is AES-256-GCM in the AndroidKeyStore with randomized IVs', () => {
    expect(src).toContain('"AndroidKeyStore"');
    expect(src).toContain('KeyProperties.BLOCK_MODE_GCM');
    expect(src).toContain('.setKeySize(256)');
    expect(src).toContain('.setRandomizedEncryptionRequired(true)');
  });

  it('stays off StrongBox (too slow for bulk audio sealing)', () => {
    expect(src).not.toContain('setIsStrongBoxBacked(true)');
  });

  it('never silently re-keys an alias it cannot load', () => {
    expect(src).toContain('Recording key unusable');
  });

  it('does not bind the key to user auth or an unlocked screen (locked-screen capture)', () => {
    expect(src).not.toMatch(/setUserAuthenticationRequired\(true\)/);
    expect(src).not.toMatch(/setUnlockedDeviceRequired\(true\)/);
  });
});

describe('software-only Keystore key in release builds', () => {
  const info = (securityLevel: 'strongbox' | 'tee' | 'software' | 'unknown') => ({
    alias: 'meetops_chunk_key',
    algorithm: 'AES-256-GCM',
    securityLevel,
    keySize: 256,
  });

  it('warns and still records (ready resolves) when the key is software-only', async () => {
    const warn = jest.fn();
    const c = createNativeChunkCipher(fakeNative({ keyInfo: async () => info('software') }), {
      release: true,
      warn,
    });
    await expect(c.ready!()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      SOFTWARE_KEY_WARNING,
      expect.objectContaining({ securityLevel: 'software' }),
    );
  });

  it('warns once per cipher, not on every ready()', async () => {
    const warn = jest.fn();
    const c = createNativeChunkCipher(fakeNative({ keyInfo: async () => info('software') }), {
      release: true,
      warn,
    });
    await c.ready!();
    await c.ready!();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each(['tee', 'strongbox', 'unknown'] as const)('does not warn for %s', async (level) => {
    const warn = jest.fn();
    const c = createNativeChunkCipher(fakeNative({ keyInfo: async () => info(level) }), {
      release: true,
      warn,
    });
    await c.ready!();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not check in dev builds', async () => {
    const warn = jest.fn();
    const keyInfo = jest.fn(async () => info('software'));
    const c = createNativeChunkCipher(fakeNative({ keyInfo }), { release: false, warn });
    await c.ready!();
    expect(keyInfo).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failing or missing keyInfo never blocks recording', async () => {
    const warn = jest.fn();
    const failing = createNativeChunkCipher(
      fakeNative({ keyInfo: () => Promise.reject(new Error('boom')) }),
      { release: true, warn },
    );
    await expect(failing.ready!()).resolves.toBeUndefined();
    await expect(
      createNativeChunkCipher(fakeNative(), { release: true, warn }).ready!(),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('the default logger goes to console.warn without key material', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await createNativeChunkCipher(fakeNative({ keyInfo: async () => info('software') }), {
        release: true,
      }).ready!();
      expect(spy).toHaveBeenCalledWith(`[chunk-crypto] ${SOFTWARE_KEY_WARNING}`, {
        alias: 'meetops_chunk_key',
        securityLevel: 'software',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('a self-test failure still fails closed before any key check', async () => {
    const keyInfo = jest.fn(async () => info('software'));
    const c = createNativeChunkCipher(fakeNative({ open: async () => 'BB==', keyInfo }), {
      release: true,
      warn: jest.fn(),
    });
    await expect(c.ready!()).rejects.toThrow('Encryption self-test failed.');
    expect(keyInfo).not.toHaveBeenCalled();
  });
});

describe('ADR-015 key-binding note', () => {
  it('records that the key is not bound to user authentication', () => {
    const adr = readFileSync(
      join(__dirname, '..', '..', '..', 'docs/15-decisions/ADR-015-mobile-segment-encryption.md'),
      'utf8',
    );
    expect(adr).toMatch(/not bound to user authentication/);
    expect(adr).toMatch(/does not set\s+`setUnlockedDeviceRequired`/);
  });
});
