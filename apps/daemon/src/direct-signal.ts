import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  LANDING_HEADERS,
  LEGAL_REPO_BASE,
  RoomCore,
  STUN_SERVERS,
  landingPage,
  serverMessage,
  type Attachment,
  type RoomSocket,
  type RoomStorage,
} from '@codex-live-share/signal-core';
import { writePrivateJson } from './config';

const MAX_CONNECTS_PER_MINUTE = 60;

/**
 * Direct mode's signal server: the same RoomCore the hosted Worker runs, for
 * exactly one room, inside the host's daemon. It is the only thing exposed
 * through the tunnel; the UI and RPC server stay on loopback.
 */
export class DirectSignal {
  readonly #code: string;
  readonly #server: Server;
  readonly #sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1_024 });
  readonly #live = new Map<WebSocket, RoomSocket>();
  readonly #core: RoomCore;
  #connects: number[] = [];
  port = 0;

  constructor(code: string, statePath: string) {
    this.#code = code;
    this.#core = new RoomCore({ storage: new FileStorage(statePath), sockets: () => [...this.#live.values()] });
    this.#server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const origin = publicOrigin(request);
      if (url.pathname === '/healthz') {
        response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok');
      } else if (url.pathname === '/api/ice-servers' && request.method === 'POST') {
        // No TURN in direct mode: nothing of ours sits between the peers.
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: true, iceServers: STUN_SERVERS }));
      } else if (url.pathname === `/j/${this.#code}` || url.pathname === `/j/${this.#code}/`) {
        response.writeHead(200, LANDING_HEADERS).end(landingPage(this.#code, origin, LEGAL_REPO_BASE));
      } else {
        response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      }
    });
    this.#server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== `/api/rooms/${this.#code}/connect` || !this.#allowConnect()) {
        socket.destroy();
        return;
      }
      this.#sockets.handleUpgrade(request, socket, head, (ws) => void this.#attach(ws, url));
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.#server.address();
    this.port = address && typeof address === 'object' ? address.port : 0;
    return this.port;
  }

  close(): void {
    for (const ws of this.#live.keys()) ws.close(1001, 'Host stopped');
    this.#server.close();
  }

  async #attach(ws: WebSocket, url: URL): Promise<void> {
    let attachment: Attachment | null = null;
    const socket: RoomSocket = {
      send: (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text);
      },
      close: (code, reason) => {
        this.#live.delete(ws);
        ws.close(code, reason);
      },
      getAttachment: () => attachment,
      setAttachment: (value) => {
        attachment = value;
      },
    };
    const result = await this.#core.connect({
      code: this.#code,
      action: url.searchParams.get('action'),
      peerId: url.searchParams.get('peerId') ?? '',
      name: url.searchParams.get('name') ?? '',
      color: url.searchParams.get('color') ?? '',
      secret: url.searchParams.get('secret') ?? '',
    }, (value) => {
      attachment = value;
      this.#live.set(ws, socket);
      return socket;
    });
    if (!result.ok) {
      ws.send(serverMessage({ type: 'error', code: result.code, message: result.message }));
      ws.close(4000, result.code);
      return;
    }
    ws.on('message', (data: Buffer) => void this.#core.message(socket, data.toString('utf8')));
    ws.on('close', () => {
      if (!this.#live.has(ws)) return;
      this.#live.delete(ws);
      void this.#core.closed(socket);
    });
  }

  #allowConnect(): boolean {
    const now = Date.now();
    this.#connects = this.#connects.filter((at) => now - at < 60_000);
    if (this.#connects.length >= MAX_CONNECTS_PER_MINUTE) return false;
    this.#connects.push(now);
    return true;
  }
}

/** Keeps who the host admitted across daemon restarts, so returning guests need not knock again. */
class FileStorage implements RoomStorage {
  #data: Record<string, unknown>;

  constructor(private readonly path: string) {
    try {
      this.#data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      this.#data = {};
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.#data[key];
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put(entries: Record<string, unknown>): Promise<void> {
    Object.assign(this.#data, structuredClone(entries));
    writePrivateJson(this.path, this.#data);
  }
}

/** The tunnel forwards with the public host; locally there is none worth showing. */
function publicOrigin(request: IncomingMessage): string {
  const raw = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '').split(',')[0]!.trim();
  // The host ends up in HTML; accept only a plain hostname.
  const host = /^[a-z0-9.-]+(:\d{1,5})?$/iu.test(raw) ? raw : 'localhost';
  return `${host.endsWith('.trycloudflare.com') ? 'https' : 'http'}://${host}`;
}
