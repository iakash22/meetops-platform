import { readFileSync } from 'fs';
import { join } from 'path';

import type { ChunkCryptoNative } from '../modules/chunk-crypto';
import { createNativeChunkCipher } from '../src/record/expoAudio';

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
