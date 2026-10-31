import { requireOptionalNativeModule } from 'expo';

/** AES-256-GCM: Android Keystore (android/), iOS Keychain + CryptoKit (ios/). Null in Jest and Expo Go. */
interface ChunkCryptoNative {
  seal(plainBase64: string): Promise<string>;
  open(sealedBase64: string): Promise<string>;
  deleteKey(): Promise<void>;
  /**
   * Seals a whole file off the JS thread into `<destDir><seq>.chunk` ("MOCHUNK1" || iv || ciphertext+tag), atomically
   * per chunk (tmp + rename) with a progress journal so a re-run after a kill resumes. Never deletes the source.
   * Absent on builds before this method existed (JS falls back to per-chunk seal()).
   */
  sealFile?(
    sourceUri: string,
    destDir: string,
    chunkBytes: number,
  ): Promise<{ seq: number; sizeBytes: number; sha256: string }[]>;
}

export const ChunkCryptoModule = requireOptionalNativeModule<ChunkCryptoNative>('ChunkCrypto');
