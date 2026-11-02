import { requireOptionalNativeModule } from 'expo';

export interface ChunkKeyInfo {
  alias: string;
  algorithm: string;
  /** `strongbox` and `tee` are hardware-backed; `software` (emulators, old devices) is not. */
  securityLevel: 'strongbox' | 'tee' | 'software' | 'unknown';
  keySize: number;
}

/** AES-256-GCM: Android Keystore (android/), iOS Keychain + CryptoKit (ios/). Null in Jest and Expo Go. */
export interface ChunkCryptoNative {
  seal(plainBase64: string): Promise<string>;
  open(sealedBase64: string): Promise<string>;
  deleteKey(): Promise<void>;
  /** Android only (absent on iOS and older builds): where the Keystore key lives. Never key material. */
  keyInfo?(): Promise<ChunkKeyInfo>;
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
/**
 * stop() result. `markerFailed`: the seal succeeded but the native-stop "stopped" sentinel couldn't be written, so a
 * kill before JS writes the manifest would discard the recording at launch. Older builds resolve a bare array.
 */
export interface SegmentStopResult {
  chunks: SegmentChunk[];
  markerFailed: boolean;
}
export interface SegmentRecorderNative {
  start(dir: string, segmentMs: number): Promise<void>;
  pause(): void;
  resume(): void;
  isRecording(): boolean;
  stop(): Promise<SegmentStopResult | SegmentChunk[]>;
  abort(): Promise<void>;
  recover(dir: string): Promise<SegmentChunk[]>;
  /** A native Stop (notification Stop, swipe-away) began for this capture folder. Absent on older builds. */
  stoppedNatively?(dir: string): boolean;
}

export const SegmentRecorderModule =
  requireOptionalNativeModule<SegmentRecorderNative>('SegmentRecorder');
