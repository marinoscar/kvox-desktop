import type { KvoxNotificationEventDef, KvoxNotifyPort } from '@marinoscar/kvox-api/ports';

// =============================================================================
// DesktopNotify: KVOX_NOTIFY as an operating-system notification (marinoscar/kvox#583)
// =============================================================================
//
// The slices declare their events (`notes.note_ready`, ...) with a
// `browserTemplate`; this port renders the template only for its HEADING and
// shows that heading with a fixed line of text. The template's body (which
// carries the note's title, a failure reason, ...) is never shown: an OS
// notification centre keeps its history outside the app, so NO NOTE CONTENT
// leaves the window. The notification itself is Electron's `Notification`,
// which only the main process has; {@link DesktopNotifyOptions.show} posts it
// there.
//
// An event that has no `browser` channel, no template, or that a user cannot
// receive by default is dropped. `notify` returns at once and never throws.
// =============================================================================

/** What reaches the operating system: a heading and one fixed line. */
export interface DesktopNotification {
  title: string;
  body: string;
}

/** Options of {@link DesktopNotify}. */
export interface DesktopNotifyOptions {
  /** Shows the notification (the main process's `Notification`). */
  show: (notification: DesktopNotification) => void;
  /** The product name, for the fixed line. */
  appName: string;
  /** Receives one line when a template throws (the event key only). */
  log?: (line: string) => void;
}

/** The longest heading shown. */
const MAX_TITLE = 80;

/** KVOX_NOTIFY over the main process's `Notification`. */
export class DesktopNotify implements KvoxNotifyPort {
  private readonly events = new Map<string, KvoxNotificationEventDef>();

  constructor(private readonly options: DesktopNotifyOptions) {}

  registerEvents(defs: KvoxNotificationEventDef[]): void {
    for (const def of defs) this.events.set(def.key, def);
  }

  notify(eventKey: string, _userId: string, data: unknown): void {
    try {
      const def = this.events.get(eventKey);
      if (!def?.browserTemplate || !def.channels.includes('browser') || def.defaultEnabled === false) return;
      const heading = (def.browserTemplate as unknown as (data: unknown) => { title: string })(data).title || def.label;
      this.options.show({
        title: heading.length > MAX_TITLE ? `${heading.slice(0, MAX_TITLE - 1)}…` : heading,
        body: `Open ${this.options.appName} to see it.`,
      });
    } catch {
      this.options.log?.(`notify: the notification for ${eventKey} could not be shown`);
    }
  }
}
