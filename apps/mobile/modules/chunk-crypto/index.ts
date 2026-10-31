import { requireOptionalNativeModule } from 'expo';

/** Android-only Keystore AES-GCM (see android/). Null on iOS, in Jest and in Expo Go. */
interface ChunkCryptoNative {
  seal(plainBase64: string): Promise<string>;
  open(sealedBase64: string): Promise<string>;
  deleteKey(): Promise<void>;
}

export const ChunkCryptoModule = requireOptionalNativeModule<ChunkCryptoNative>('ChunkCrypto');
