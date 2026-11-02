import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';
import { preloadLazyRoutes } from './fixtures/preload-routes';

// Under turbo `pnpm test` contention, jsdom updates often exceed the 1s findBy default.
configure({ asyncUtilTimeout: 5_000 });

// Load lazy route chunks before any test so cold module loads never land inside a findBy.
beforeAll(preloadLazyRoutes, 30_000);

afterEach(() => {
  cleanup();
});

// jsdom does not implement scrollTo; TanStack Router's scroll restoration calls it.
window.scrollTo = () => {};

// Radix Select relies on pointer capture / scrollIntoView, which jsdom lacks.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
