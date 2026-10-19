import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// The Inter @font-face, self-hosted by the brand package: electron-vite emits the woff2 into the bundle
// (CSP `font-src 'self' data:` unchanged; no CDN, ADR-0004).
import '@marinoscar/kvox-web/brand/fonts/inter.css';

import { App } from './App';
import { restoreThemeMode } from './theme';

const root = createRoot(document.getElementById('root')!);

// The saved theme choice is back in localStorage (if it was lost) before ShellRoot reads it.
restoreThemeMode(window.kvoxDesktop)
  .then(() => window.kvoxDesktop.connection())
  .then((connection) => {
    root.render(
      <StrictMode>
        <App connection={connection} />
      </StrictMode>,
    );
  })
  .catch((error: unknown) => {
    root.render(<p role="alert">The local server did not start: {error instanceof Error ? error.message : String(error)}</p>);
  });
