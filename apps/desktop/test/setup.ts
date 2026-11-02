import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Under turbo `pnpm test` contention, jsdom updates often exceed the 1s findBy default.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
});
