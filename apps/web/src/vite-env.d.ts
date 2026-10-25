/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Dev only: 'true' serves the directory (employees/teams/projects) from an in-memory mock. */
  readonly VITE_DIRECTORY_MOCKS?: string;
}
