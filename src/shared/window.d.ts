import type { KvoxDesktopBridge } from './protocol';

// `window.kvoxDesktop`, set by the preload script (src/preload/index.ts). Declared once here so the renderer's
// files and the unit tests that import them (tests/unit/theme.test.ts) see the same type.
declare global {
  interface Window {
    kvoxDesktop: KvoxDesktopBridge;
  }
}
