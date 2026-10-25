/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the MeetOps API. Display-only in M1 (sign-in is mocked). Never put secrets in VITE_* vars. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
