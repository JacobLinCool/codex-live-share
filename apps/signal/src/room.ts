import { DurableObject } from 'cloudflare:workers';
import { RoomCore, serverMessage, type Attachment, type RoomRuntime, type RoomSocket } from '@codex-live-share/signal-core';
import type { Env } from './index';

/** Rooms without any connection are forgotten after this long. */
const IDLE_ROOM_MS = 24 * 60 * 60 * 1_000;

/**
 * Hosted mode: one Durable Object per room code, running the shared RoomCore
 * over hibernatable WebSockets so idle rooms cost nothing.
 */
export class Room extends DurableObject<Env> {
  readonly #core: RoomCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const runtime: RoomRuntime = {
      storage: {
        get: (key) => ctx.storage.get(key),
        put: (entries) => ctx.storage.put(entries),
      },
      sockets: () => ctx.getWebSockets().map(wrap),
    };
    this.#core = new RoomCore(runtime);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    let client: WebSocket | null = null;
    const accept = (attachment: Attachment): RoomSocket => {
      const pair = new WebSocketPair();
      client = pair[0];
      pair[1].serializeAttachment(attachment);
      this.ctx.acceptWebSocket(pair[1]);
      return wrap(pair[1]);
    };
    const result = await this.#core.connect({
      code: url.pathname.split('/')[3] ?? '',
      action: url.searchParams.get('action'),
      peerId: url.searchParams.get('peerId') ?? '',
      name: url.searchParams.get('name') ?? '',
      color: url.searchParams.get('color') ?? '',
      secret: url.searchParams.get('secret') ?? '',
    }, accept);
    if (!result.ok || !client) return admissionError(result.ok ? 'INTERNAL' : result.code, result.ok ? 'Internal error.' : result.message);
    await this.ctx.storage.deleteAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.#core.message(wrap(socket), typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    const reserved = [1004, 1005, 1006, 1015].includes(code);
    try {
      socket.close(reserved ? 1000 : code, reserved ? '' : reason);
    } catch {
      // Already closed.
    }
    await this.#departed(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await this.#departed(socket);
  }

  override async alarm(): Promise<void> {
    if (!this.ctx.getWebSockets().some((socket) => socket.deserializeAttachment())) await this.ctx.storage.deleteAll();
  }

  async #departed(socket: WebSocket): Promise<void> {
    if (await this.#core.closed(wrap(socket))) await this.ctx.storage.setAlarm(Date.now() + IDLE_ROOM_MS);
  }
}

function wrap(socket: WebSocket): RoomSocket {
  return {
    send: (text) => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
    getAttachment: () => (socket.deserializeAttachment() as Attachment | null) ?? null,
    setAttachment: (attachment) => socket.serializeAttachment(attachment),
  };
}

/** Errors go over a short-lived socket because WebSocket clients cannot read HTTP error bodies. */
function admissionError(code: string, message: string): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].send(serverMessage({ type: 'error', code, message }));
  pair[1].close(4000, code);
  return new Response(null, { status: 101, webSocket: pair[0] });
}
