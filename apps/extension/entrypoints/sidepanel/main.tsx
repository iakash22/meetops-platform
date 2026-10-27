import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../popup/App.js';
import '../popup/theme.css';

/**
 * Side panel: the same consent-first UI as the popup (sign-in, the consent notice before any capture, the
 * recording indicator, recent meetings and pending tasks). It adds no capture path of its own; starting a
 * capture still goes through the popup's user gesture and the consent acknowledgement.
 */
const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
