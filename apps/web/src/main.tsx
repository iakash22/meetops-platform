import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { createApiClient } from './lib/api/client';
import { createMockDirectoryApi, demoDirectorySeed } from './features/directory/mock-api';
import { createQueryClient } from './lib/query-client';
import './index.css';

const httpApi = createApiClient({ baseUrl: import.meta.env.VITE_API_URL ?? '/api' });
// Mocks first: until BE-3 ships the directory routes, a dev build can opt in to an in-memory
// directory with VITE_DIRECTORY_MOCKS=true. Production builds always use the real API.
const api =
  import.meta.env.DEV && import.meta.env.VITE_DIRECTORY_MOCKS === 'true'
    ? { ...httpApi, directory: createMockDirectoryApi({}, { seedOrg: demoDirectorySeed }) }
    : httpApi;
const queryClient = createQueryClient();

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');
createRoot(root).render(
  <StrictMode>
    <App queryClient={queryClient} api={api} />
  </StrictMode>,
);
