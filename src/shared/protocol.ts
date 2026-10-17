// =============================================================================
// Messages between the main process and the server utility process
// =============================================================================
//
// The token travels in a message, never in the environment: the server's child
// processes (the migration commands) inherit its environment.
// =============================================================================

/** Main -> server. */
export type ToServer =
  | {
      type: 'start';
      appRoot: string;
      userDataDir: string;
      nodeExecutable: string;
      token: string;
      allowedOrigins: string[];
    }
  | { type: 'stop' };

/** Server -> main. */
export type FromServer =
  | { type: 'ready'; port: number; userId: string; permissions: string[]; timings: Record<string, number> }
  | { type: 'error'; message: string }
  | { type: 'log'; line: string }
  | { type: 'stopped' };

/** What the preload hands the renderer. */
export interface DesktopConnection {
  /** `http://127.0.0.1:<port>`. */
  baseUrl: string;
  /** The per-launch token. */
  token: string;
  userId: string;
  permissions: string[];
}
