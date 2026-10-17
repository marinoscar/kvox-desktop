import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// =============================================================================
// A loopback OpenAI-compatible server for the tests (marinoscar/kvox#584)
// =============================================================================
//
// Speaks just enough Chat Completions (`POST /v1/chat/completions`, streamed or
// not) for the real platform OpenAI-compatible adapter to generate a note: every
// answer is `text`. It records what it received (the Authorization header and the
// body), so a test can show the stored key reached the provider and nothing else.
// `failWith` makes the next request answer an error whose body echoes the key, as
// a careless provider might, to prove the key never reaches an error message.
// =============================================================================

export interface MockRequest {
  path: string;
  authorization: string | undefined;
  body: unknown;
}

export interface OpenAiCompatibleMock {
  /** `http://127.0.0.1:<port>/v1`. */
  baseUrl: string;
  readonly requests: MockRequest[];
  /** The next request answers `status` with a body that echoes its bearer token. */
  failWith(status: number): void;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text === '' ? null : JSON.parse(text));
      } catch {
        resolve(text);
      }
    });
  });
}

/** Starts the mock on 127.0.0.1 at a port the system picks. */
export async function startOpenAiCompatibleMock(text: string): Promise<OpenAiCompatibleMock> {
  const requests: MockRequest[] = [];
  let failNext: number | null = null;
  const server: Server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const authorization = request.headers.authorization;
      requests.push({ path: request.url ?? '', authorization, body });
      if (failNext !== null) {
        const status = failNext;
        failNext = null;
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${authorization ?? ''}`, type: 'invalid_request_error', code: 'invalid_api_key' } }));
        return;
      }
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      const model = (body as { model?: string } | null)?.model ?? 'mock-model';
      const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
      if ((body as { stream?: boolean } | null)?.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const chunk = (delta: object, finish: string | null, extra: object = {}) =>
          `data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
        response.write(chunk({ role: 'assistant', content: '' }, null));
        for (const piece of text.match(/[\s\S]{1,40}/g) ?? []) response.write(chunk({ content: piece }, null));
        response.write(chunk({}, 'stop', { usage }));
        response.end('data: [DONE]\n\n');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: 0,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    failWith(status) {
      failNext = status;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
