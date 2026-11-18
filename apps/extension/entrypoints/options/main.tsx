import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../popup/theme.css';
import { OptionsApp } from './OptionsApp';

const root = document.getElementById('root');
if (!root) throw new Error('options root missing');
createRoot(root).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
);
