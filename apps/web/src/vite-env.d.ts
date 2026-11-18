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
  /** 'true' shows the GitHub/Jira Connect buttons (needs the #226 connect routes on the API). */
  readonly VITE_INTEGRATION_CONNECT?: string;
  /** 'true' connects to apps/realtime for live task/meeting updates (polling stays as the fallback). */
  readonly VITE_REALTIME_ENABLED?: string;
  /** Realtime origin, e.g. https://rt.example.com (default: same origin). */
  readonly VITE_REALTIME_URL?: string;
  /** Socket.IO path (REALTIME_SOCKET_PATH), default /socket.io. */
  readonly VITE_REALTIME_PATH?: string;
}
