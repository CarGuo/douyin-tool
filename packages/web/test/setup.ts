import '@testing-library/jest-dom';
import { webcrypto } from 'node:crypto';
import { beforeEach } from 'vitest';

// jsdom does not ship SubtleCrypto. PinGate / pinSecurity rely on it,
// so we mount Node's webcrypto onto globalThis for tests.
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
}

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});
