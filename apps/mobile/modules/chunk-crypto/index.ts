import { requireOptionalNativeModule } from 'expo';

/** AES-256-GCM: Android Keystore (android/), iOS Keychain + CryptoKit (ios/). Null in Jest and Expo Go. */
interface ChunkCryptoNative {
  seal(plainBase64: string): Promise<string>;
  open(sealedBase64: string): Promise<string>;
  deleteKey(): Promise<void>;
}

export const ChunkCryptoModule = requireOptionalNativeModule<ChunkCryptoNative>('ChunkCrypto');
