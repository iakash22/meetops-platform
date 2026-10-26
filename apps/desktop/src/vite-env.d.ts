/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the MeetOps API. Display-only in M1 (sign-in is mocked). Never put secrets in VITE_* vars. */
  readonly VITE_API_BASE_URL?: string;
  /** 'true' | 'false'. Mocked sign-in toggle (see lib/config.ts isMockAuthEnabled). Not a secret. */
  readonly VITE_DESKTOP_MOCK_AUTH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
