import { DurableObject } from 'cloudflare:workers';
import {
  RoomCore,
  serverMessage,
  type Attachment,
  type RoomPolicy,
  type RoomRecord,
  type RoomRuntime,
  type RoomSocket,
  type StoredMember,
} from '@codex-live-share/signal-core';
import { accountOf, authenticate, sha256 } from './auth';
import type { Env } from './index';

/** Rooms without any connection are forgotten after this long. */
const IDLE_ROOM_MS = 24 * 60 * 60 * 1_000;
/** Longest TURN credential we hand out; shorter when the owner's relay quota is nearly used. */
const MAX_TURN_TTL_SECONDS = 3_600;

export type TurnAllowance =
  | { ok: true; relay: true; ttlSeconds: number }
  | { ok: true; relay: false; reason: string }
  | { ok: false };

/**
 * Hosted mode: one Durable Object per room code, running the shared RoomCore
 * over hibernatable WebSockets. Its policy ties the room to the signed-in
 * host's plan: who may create it, how many people, how long, and how much
 * TURN relay everyone in it may use.
 */
export class Room extends DurableObject<Env> {
  readonly #core: RoomCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const policy: RoomPolicy = {
      authorizeCreate: async ({ authorization, code }) => {
        const account = await authenticate(env, authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null);
        if (!account) {
          return { ok: false, code: 'AUTH_REQUIRED', message: 'Hosted mode needs you to sign in (live_share_login), or use direct mode.' };
        }
        const grant = await account.stub.openRoom(code);
        if (!grant.ok) return grant;
        // Local development can shorten limited sessions to test the cutoff (never deploy DEV_AUTH).
        const devSession = env.DEV_AUTH === 'allow' && env.DEV_SESSION_MS ? Number(env.DEV_SESSION_MS) : null;
        const sessionMs = grant.limits.sessionMs !== null && devSession ? devSession : grant.limits.sessionMs;
        return { ok: true, owner: account.id, maxPeople: grant.limits.people, sessionMs };
      },
      onUsage: async (room, _peerId, seconds) => {
        if (!room.owner) return;
        const left = await accountOf(env, room.owner).addRelay(seconds);
        if (left <= 0) {
          this.#core.notify('RELAY_QUOTA', "This month's relay time on the host's plan is used up. People who need the relay may lose their connection.");
        }
      },
      onEnded: async (room) => {
        if (room.owner) await accountOf(env, room.owner).closeRoom(room.code);
      },
    };
    const runtime: RoomRuntime = {
      storage: {
        get: (key) => ctx.storage.get(key),
        put: (entries) => ctx.storage.put(entries),
      },
      sockets: () => ctx.getWebSockets().map(wrap),
      policy,
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
      authorization: request.headers.get('Authorization'),
    }, accept);
    if (!result.ok || !client) return admissionError(result.ok ? 'INTERNAL' : result.code, result.ok ? 'Internal error.' : result.message);

    await this.ctx.storage.delete('emptySince');
    const room = await this.ctx.storage.get<RoomRecord>('room');
    if (room?.owner && room.hostPeerId === url.searchParams.get('peerId')) await accountOf(this.env, room.owner).roomActivity(room.code, true);
    await this.#armAlarm(room);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Whether a member may get TURN credentials, and for how long, given the owner's quota. */
  async turnAllowance(peerId: string, secret: string): Promise<TurnAllowance> {
    const members = (await this.ctx.storage.get<Record<string, StoredMember>>('members')) ?? {};
    const member = members[peerId];
    if (!member || member.secretHash !== (await sha256(secret))) return { ok: false };
    const room = await this.ctx.storage.get<RoomRecord>('room');
    if (!room || room.ended || !room.owner) return { ok: false };
    const left = await accountOf(this.env, room.owner).relayLeft();
    if (left <= 0) return { ok: true, relay: false, reason: "The host's plan has no relay time left this month." };
    return { ok: true, relay: true, ttlSeconds: Math.max(60, Math.min(MAX_TURN_TTL_SECONDS, left)) };
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

  /** One alarm serves two jobs: the plan's session limit, and forgetting idle rooms. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const room = await this.ctx.storage.get<RoomRecord>('room');
    if (room && !room.ended && room.sessionMs && now >= room.createdAt + room.sessionMs) {
      await this.#core.end({
        code: 'SESSION_LIMIT',
        message: `This session reached the ${duration(room.sessionMs)} limit of the host's plan. Start a new one to continue, or upgrade.`,
      });
    }
    const live = this.ctx.getWebSockets().some((socket) => socket.deserializeAttachment());
    if (live) {
      await this.#armAlarm(await this.ctx.storage.get<RoomRecord>('room'));
      return;
    }
    const emptySince = (await this.ctx.storage.get<number>('emptySince')) ?? now;
    if (now - emptySince >= IDLE_ROOM_MS) {
      const current = await this.ctx.storage.get<RoomRecord>('room');
      if (current?.owner) await accountOf(this.env, current.owner).closeRoom(current.code);
      await this.ctx.storage.deleteAll();
    } else {
      await this.ctx.storage.setAlarm(emptySince + IDLE_ROOM_MS);
    }
  }

  async #armAlarm(room: RoomRecord | undefined): Promise<void> {
    if (room && !room.ended && room.sessionMs) await this.ctx.storage.setAlarm(room.createdAt + room.sessionMs);
    else await this.ctx.storage.deleteAlarm();
  }

  async #departed(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    const room = await this.ctx.storage.get<RoomRecord>('room');
    const empty = await this.#core.closed(wrap(socket));
    if (room?.owner && attachment?.peerId === room.hostPeerId && !room.ended) {
      await accountOf(this.env, room.owner).roomActivity(room.code, false);
    }
    if (empty) {
      await this.ctx.storage.put('emptySince', Date.now());
      await this.ctx.storage.setAlarm(Date.now() + IDLE_ROOM_MS);
    }
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

function duration(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round((ms / 3_600_000) * 10) / 10}-hour`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}-minute`;
  return `${Math.round(ms / 1_000)}-second`;
}
