import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig, swcPlugin } from 'electron-vite';

// =============================================================================
// electron-vite: main + server (one build, two entries), preload, renderer
// =============================================================================
//
// main     out/main/index.js   the Electron main process
//          out/main/server.js  the server utility process (Nest + PGlite)
//          out/main/node-script-host.js  a migration command's utility process
//          Runtime dependencies stay external (`build.externalizeDeps`, the
//          default) and ship in node_modules; SWC compiles the decorators with
//          their metadata, which Nest's dependency injection reads.
// preload  out/preload/index.js
// renderer out/renderer         React + the kvox-web screens, bundled
// =============================================================================

export default defineConfig({
  main: {
    plugins: [swcPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          server: resolve(__dirname, 'src/server/index.ts'),
          'node-script-host': resolve(__dirname, 'src/main/node-script-host.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
});
