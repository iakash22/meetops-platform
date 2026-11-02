import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { createApiClient } from './lib/api/client';
import { createMockDirectoryApi, demoDirectorySeed } from './features/directory/mock-api';
import { createMockIntegrationsApi, setIntegrationsApiOverride } from './features/integrations/api';
import { createQueryClient } from './lib/query-client';
import './styles/bootstrap-theme.css';
import './index.css';

/** Remove the index.html boot splash once React owns #root (avoids a white/blank first paint). */
function clearBootSplash(): void {
  document.getElementById('boot-splash')?.remove();
  document.documentElement.style.backgroundColor = '#0A0A0A';
  document.body.style.backgroundColor = '#0A0A0A';
}

const httpApi = createApiClient({ baseUrl: import.meta.env.VITE_API_URL ?? '/api' });
// Mocks first: until BE-3 ships the directory routes, a dev build can opt in to an in-memory
// directory with VITE_DIRECTORY_MOCKS=true. Production builds always use the real API.
const api =
  import.meta.env.DEV && import.meta.env.VITE_DIRECTORY_MOCKS === 'true'
    ? { ...httpApi, directory: createMockDirectoryApi({}, { seedOrg: demoDirectorySeed }) }
    : httpApi;
// Same for integration settings until the backend routes exist (VITE_INTEGRATION_MOCKS=true, dev only).
if (import.meta.env.DEV && import.meta.env.VITE_INTEGRATION_MOCKS === 'true')
  setIntegrationsApiOverride(
    createMockIntegrationsApi([
      {
        id: '70000000-0000-4000-8000-000000000001',
        organizationId: '00000000-0000-4000-8000-000000000001',
        provider: 'github',
        status: 'active',
        displayName: 'acme',
        externalAccountId: '1',
        connectedById: '10000000-0000-4000-8000-000000000001',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]),
  );
const queryClient = createQueryClient();

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');
createRoot(root).render(
  <StrictMode>
    <App queryClient={queryClient} api={api} />
  </StrictMode>,
);
clearBootSplash();
