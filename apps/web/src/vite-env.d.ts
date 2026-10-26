/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Absolute https URL or same-origin path of the Terms of Service page. */
  readonly VITE_TERMS_URL?: string;
  /** Absolute https URL or same-origin path of the Privacy Policy page. */
  readonly VITE_PRIVACY_URL?: string;
  /** Dev only: 'true' serves the directory (employees/teams/projects) from an in-memory mock. */
  readonly VITE_DIRECTORY_MOCKS?: string;
  /** Dev only: 'true' uses the in-memory integrations API (until the backend routes land). */
  readonly VITE_INTEGRATION_MOCKS?: string;
}
