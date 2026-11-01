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

/**
 * Android-only segment recorder (android/SegmentRecorderModule.kt, ADR-015): ADTS AAC in short segments, each sealed
 * into `<dir><seq>.chunk` as it closes. Null on iOS, in Jest and in Expo Go (iOS stays on expo-audio + sealFile).
 */
export interface SegmentChunk {
  seq: number;
  sizeBytes: number;
  sha256: string;
}
export interface SegmentRecorderNative {
  start(dir: string, segmentMs: number): Promise<void>;
  pause(): void;
  resume(): void;
  isRecording(): boolean;
  stop(): Promise<SegmentChunk[]>;
  abort(): Promise<void>;
  recover(dir: string): Promise<SegmentChunk[]>;
}

export const SegmentRecorderModule =
  requireOptionalNativeModule<SegmentRecorderNative>('SegmentRecorder');
