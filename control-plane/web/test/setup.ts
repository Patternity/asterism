import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  document.cookie = 'asterism_csrf=; Max-Age=0; path=/';
});
