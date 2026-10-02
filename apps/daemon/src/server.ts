import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { encodeControl } from '@codex-live-share/protocol';
import { Daemon, DaemonError, describePlan } from './daemon';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json',
};
const MAX_RPC_BYTES = 256 * 1_024;

export type RpcHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * Localhost-only HTTP server: the web UI's static files, its WebSocket, and a
 * token-protected JSON-RPC endpoint for the MCP server and Codex hooks.
 */
export function createDaemonServer(daemon: Daemon, webRoot: string): Server {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1_024 * 1_024 });
  let connection = 0;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      json(response, 500, { ok: false, code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!isLocalHost(request)) {
      json(response, 403, { ok: false, code: 'FORBIDDEN' });
      return;
    }
    if (url.pathname === '/api/rpc' && request.method === 'POST') {
      if (!authorized(request.headers.authorization?.replace(/^Bearer /u, ''), daemon.token)) {
        json(response, 401, { ok: false, code: 'UNAUTHORIZED' });
        return;
      }
      const body = await readBody(request);
      let call: { method?: unknown; params?: unknown };
      try {
        call = JSON.parse(body) as typeof call;
      } catch {
        json(response, 400, { ok: false, code: 'INVALID_JSON' });
        return;
      }
      try {
        const result = await rpc(daemon, String(call.method), (call.params ?? {}) as Record<string, unknown>);
        json(response, 200, { ok: true, result });
      } catch (error) {
        json(response, 200, {
          ok: false,
          code: error instanceof DaemonError ? error.code : 'FAILED',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (url.pathname === '/api/transcription-token' && request.method === 'POST') {
      if (!authorized(request.headers.authorization?.replace(/^Bearer /u, ''), daemon.token) || !sameOrigin(request)) {
        json(response, 401, { ok: false, code: 'UNAUTHORIZED' });
        return;
      }
      try {
        json(response, 200, { ok: true, ...(await daemon.transcriptionToken()) });
      } catch (error) {
        json(response, 200, {
          ok: false,
          code: error instanceof DaemonError ? error.code : 'TOKEN_FAILED',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    serveStatic(url.pathname, response, webRoot);
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/ws' || !isLocalHost(request) || !sameOrigin(request) || !authorized(url.searchParams.get('t') ?? '', daemon.token)) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => attach(ws));
  });

  function attach(ws: WebSocket): void {
    const id = `local-${++connection}`;
    const send = (frame: Uint8Array) => {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    };
    const sendSession = () => send(encodeControl({ type: 'session', session: daemon.session() }));
    sendSession();
    daemon.hub.add(daemon.localEndpoint(id, send));
    const unsubscribe = daemon.subscribe(sendSession);
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      daemon.hub.receive(id, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    });
    ws.on('close', () => {
      unsubscribe();
      daemon.hub.remove(id);
    });
  }

  return server;
}

export async function rpc(daemon: Daemon, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'status':
      return daemon.status();
    case 'plan_publish': {
      const items = Array.isArray(params['items']) ? params['items'] : [];
      const plan = daemon.publishPlan(
        items.map((item) => (typeof item === 'string'
          ? { text: item }
          : { text: String((item as Record<string, unknown>)['text'] ?? ''), files: toStrings((item as Record<string, unknown>)['files']) })),
        typeof params['session'] === 'string' ? params['session'] : null,
      );
      return describePlan(plan);
    }
    case 'plan_update': {
      const n = Number(params['item']);
      if (!Number.isInteger(n) || n < 1) throw new DaemonError('INVALID_ITEM', '`item` is the 1-based item number.');
      const status = String(params['status']);
      if (!['pending', 'in_progress', 'done', 'dropped'].includes(status)) {
        throw new DaemonError('INVALID_STATUS', 'status must be pending, in_progress, done, or dropped.');
      }
      return describePlan(daemon.updatePlan(String(params['planId']), n - 1, status as 'pending' | 'in_progress' | 'done' | 'dropped'));
    }
    case 'plan_finish':
      return describePlan(daemon.finishPlan(String(params['planId']), params['status'] === 'abandoned' ? 'abandoned' : 'done'));
    case 'read_transcript': {
      const after = typeof params['after'] === 'number' ? params['after'] : undefined;
      const limit = typeof params['limit'] === 'number' ? params['limit'] : undefined;
      const sinceMinutes = typeof params['sinceMinutes'] === 'number' ? params['sinceMinutes'] : undefined;
      return daemon.readTranscript({
        ...(after === undefined ? {} : { after }),
        ...(limit === undefined ? {} : { limit }),
        ...(sinceMinutes === undefined ? {} : { sinceMinutes }),
      });
    }
    case 'hook':
      return daemon.hook(String(params['event']), (params['payload'] ?? {}) as Record<string, unknown>);
    case 'admit': {
      const access = params['access'] === 'view' ? 'view' : params['access'] === 'deny' ? 'deny' : 'edit';
      return { name: daemon.answerKnock(String(params['who'] ?? ''), access), access };
    }
    case 'retarget': {
      const url = String(params['signalUrl'] ?? '');
      if (!/^https:\/\//u.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/u.test(url)) throw new DaemonError('INVALID_URL', 'Not a signal server URL.');
      daemon.retarget(url);
      return daemon.status();
    }
    case 'end':
      return daemon.end();
    case 'stop':
      setTimeout(() => void daemon.stop('stopped'), 10);
      return { stopping: true };
    default:
      throw new DaemonError('UNKNOWN_METHOD', `Unknown method ${method}`);
  }
}

function serveStatic(pathname: string, response: ServerResponse, webRoot: string): void {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/u, '');
  let file = join(webRoot, relative);
  if (!file.startsWith(webRoot + sep) && file !== webRoot) {
    response.writeHead(404).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(webRoot, 'index.html');
  if (!existsSync(file)) {
    response.writeHead(503, { 'Content-Type': 'text/plain' }).end('Web UI is not built. Run `pnpm build`.');
    return;
  }
  const type = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...(type.startsWith('text/html')
      ? {
          'Content-Security-Policy':
            "default-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://api.openai.com https://api.openai.com wss://generativelanguage.googleapis.com; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'self'",
        }
      : {}),
  });
  createReadStream(file).pipe(response);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > MAX_RPC_BYTES) throw new DaemonError('BODY_TOO_LARGE', 'Request too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Blocks DNS-rebinding: only requests addressed to the loopback host are served. */
function isLocalHost(request: IncomingMessage): boolean {
  const host = request.headers.host ?? '';
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/u.test(host);
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  return !origin || origin === `http://${request.headers.host}`;
}

function authorized(given: string | undefined, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function toStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
