import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { createApiClient } from './lib/api/client';
import { createQueryClient } from './lib/query-client';
import './index.css';

const api = createApiClient({ baseUrl: import.meta.env.VITE_API_URL ?? '/api' });
const queryClient = createQueryClient();

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');
createRoot(root).render(
  <StrictMode>
    <App queryClient={queryClient} api={api} />
  </StrictMode>,
);
