import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import type { DesktopConnection } from '../../shared/protocol';
import { App } from './App';

declare global {
  interface Window {
    kvoxDesktop: { connection(): Promise<DesktopConnection> };
  }
}

const root = createRoot(document.getElementById('root')!);

window.kvoxDesktop
  .connection()
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
