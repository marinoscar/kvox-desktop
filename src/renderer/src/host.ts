import {
  KvoxApiError,
  SseParser,
  buildKvoxUrl,
  createFetchSseConnect,
  unwrapEnvelope,
  type KvoxHttpMethod,
  type KvoxRequestInit,
  type KvoxResponseWithMeta,
  type KvoxWebHost,
} from '@marinoscar/kvox-web/core/headless';
import { defaultKvoxLinks } from '@marinoscar/kvox-web/shell';

import type { DesktopConnection } from '../../shared/protocol';

// =============================================================================
// KvoxWebHost over the local server (marinoscar/kvox#582)
// =============================================================================
//
// The guide's Desktop sketch ("Wiring the web") made whole: HTTP and SSE to
// http://127.0.0.1:<port>/api with `Authorization: Bearer <per-launch token>`
// on every call. The server answers without the web edition's `{ data }`
// envelope; `unwrapEnvelope` (the package's own helper) is applied anyway so a
// future envelope changes nothing here. Errors become `KvoxApiError` with the
// body's `message`, `code` and `details`. There is nothing to renew: a 401 is
// final (`reauthenticate` answers false).
// =============================================================================

type ErrorBody = { message?: unknown; code?: unknown; details?: unknown; error?: unknown };

async function toError(response: Response): Promise<KvoxApiError> {
  const body = (await response.json().catch(() => ({}))) as ErrorBody;
  const message = Array.isArray(body.message) ? body.message.join('; ') : body.message;
  return new KvoxApiError(
    typeof message === 'string' ? message : `Request failed (${response.status})`,
    response.status,
    typeof body.code === 'string' ? body.code : typeof body.error === 'string' ? body.error : undefined,
    body.details,
  );
}

/**
 * Builds the host once per connection and connected-knowledge state (hooks key
 * on its identity, so a new switch value reaches every slice).
 */
export function createDesktopHost(connection: DesktopConnection, graphEnabled: boolean | undefined): KvoxWebHost {
  const api = `${connection.baseUrl}/api`;
  const authorization = (): string => `Bearer ${connection.token}`;
  // Stable objects: the slices read them per render and memoise on them.
  const viewer = { userId: connection.userId, permissions: new Set(connection.permissions) };
  // Mirrors the server's `ai.graphEnabled` (on by default, the settings card's switch);
  // `undefined` while unknown keeps the graph UI hidden.
  const features = { graphEnabled };

  const send = async (method: string, path: string, init: KvoxRequestInit | undefined, body?: BodyInit, json = false): Promise<Response> => {
    const response = await fetch(`${api}${buildKvoxUrl(path, init?.query)}`, {
      method,
      headers: {
        Authorization: authorization(),
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
      ...(body === undefined ? {} : { body }),
      ...(init?.signal === undefined ? {} : { signal: init.signal }),
    });
    if (!response.ok && response.status !== 304) throw await toError(response);
    return response;
  };

  const readJson = async <T>(response: Response): Promise<T> => {
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text === '' ? undefined : unwrapEnvelope<T>(JSON.parse(text))) as T;
  };

  const request = async <T>(method: KvoxHttpMethod, path: string, init?: KvoxRequestInit): Promise<T> => {
    const hasBody = init?.body !== undefined;
    return readJson<T>(await send(method, path, init, hasBody ? JSON.stringify(init.body) : undefined, hasBody));
  };

  return {
    http: {
      request,
      async requestBlob(method, path, init) {
        const hasBody = init?.body !== undefined;
        const response = await send(method, path, init, hasBody ? JSON.stringify(init.body) : undefined, hasBody);
        return { blob: await response.blob(), headers: response.headers };
      },
      async postFormData<T>(path: string, body: FormData, init?: KvoxRequestInit): Promise<T> {
        // No Content-Type: fetch sets the multipart boundary.
        return readJson<T>(await send('POST', path, init, body));
      },
      async requestWithMeta<T>(_method: 'GET', path: string, init?: KvoxRequestInit): Promise<KvoxResponseWithMeta<T>> {
        const response = await send('GET', path, init);
        if (response.status === 304) return { status: 304, headers: response.headers, data: undefined };
        return { status: response.status, headers: response.headers, data: await readJson<T>(response) };
      },
    },
    sse: {
      connect: createFetchSseConnect({ baseUrl: api, authorization, reauthenticate: async () => false }),
      async post(path, body, options) {
        const response = await fetch(`${api}${path}`, {
          method: 'POST',
          headers: { Authorization: authorization(), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(body),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        if (!response.ok || !response.body) throw await toError(response);
        const parser = new SseParser();
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const frame of parser.push(value)) {
            options.onFrame(frame.event, (frame.data === '' ? null : JSON.parse(frame.data)) as never);
          }
        }
      },
    },
    viewer: () => viewer,
    links: defaultKvoxLinks,
    features: () => features,
  };
}
