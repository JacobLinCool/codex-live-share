import {
  MAX_PEERS,
  MAX_SIGNAL_FRAME_BYTES,
  PEER_ID_PATTERN,
  isColor,
  normalizeDisplayName,
  parseSignalClientMessage,
  type Access,
  type Member,
  type SignalServerMessage,
} from '@codex-live-share/protocol';

export interface StoredMember {
  peerId: string;
  name: string;
  color: string;
  isHost: boolean;
  access: Access;
  secretHash: string;
}

export interface RoomRecord {
  code: string;
  hostPeerId: string;
  createdAt: number;
  ended: boolean;
  /** Hosted mode: the account whose plan covers this room, and that plan's limits. */
  owner?: string | null;
  maxPeople?: number;
  sessionMs?: number | null;
}

export type CreateDecision =
  | { ok: true; owner: string; maxPeople: number; sessionMs: number | null }
  | { ok: false; code: string; message: string };

/** Hosted mode's rules; direct mode has none (any host may create, up to MAX_PEERS). */
export interface RoomPolicy {
  authorizeCreate(request: { authorization: string | null; code: string }): Promise<CreateDecision>;
  onUsage?(room: RoomRecord, peerId: string, relaySeconds: number): Promise<void>;
  onEnded?(room: RoomRecord): Promise<void>;
}

/** What each connection remembers; survives Durable Object hibernation. */
export interface Attachment {
  peerId: string;
  name: string;
  color: string;
  secretHash: string;
  /** False while knocking. */
  admitted: boolean;
  knockedAt: number;
}

export interface RoomSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
  getAttachment(): Attachment | null;
  setAttachment(attachment: Attachment | null): void;
}

export interface RoomStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
}

/** The runtime a room lives in: a Durable Object in hosted mode, the host daemon in direct mode. */
export interface RoomRuntime {
  storage: RoomStorage;
  /** Every live socket of this room. */
  sockets(): RoomSocket[];
  policy?: RoomPolicy;
}

/** Opens the connection being admitted, with its attachment, and returns it. */
export type Accept = (attachment: Attachment) => RoomSocket;

export interface ConnectParams {
  code: string;
  action: string | null;
  peerId: string;
  name: string;
  color: string;
  secret: string;
  /** `Bearer <token>` from the connecting client, if any. */
  authorization?: string | null;
}

export type ConnectResult = { ok: true; socket: RoomSocket } | { ok: false; code: string; message: string };

/**
 * Signaling and admission for one room, independent of where it runs. The
 * room never sees files, plans, or transcripts: it remembers who the host
 * admitted and relays WebRTC negotiation between admitted peers.
 */
export class RoomCore {
  readonly #runtime: RoomRuntime;

  constructor(runtime: RoomRuntime) {
    this.#runtime = runtime;
  }

  async connect(params: ConnectParams, accept: Accept): Promise<ConnectResult> {
    const { code, action, peerId, color, secret } = params;
    const name = normalizeDisplayName(params.name);
    if (action !== 'create' && action !== 'join') return fail('INVALID_ACTION', 'Unknown action.');
    if (!PEER_ID_PATTERN.test(peerId)) return fail('INVALID_PEER', 'Invalid peer id.');
    if (!name) return fail('INVALID_NAME', 'A display name is required.');
    if (!isColor(color)) return fail('INVALID_COLOR', 'Invalid color.');
    if (secret.length < 32 || secret.length > 128) return fail('INVALID_SECRET', 'Invalid peer secret.');
    const secretHash = await sha256(secret);
    const storage = this.#runtime.storage;

    let room = await storage.get<RoomRecord>('room');
    const members = (await storage.get<Record<string, StoredMember>>('members')) ?? {};
    const known = members[peerId];
    if (known && known.secretHash !== secretHash) return fail('INVALID_SECRET', 'This peer id belongs to someone else.');

    if (action === 'create') {
      if (room && !room.ended && room.hostPeerId !== peerId) {
        return fail('ROOM_EXISTS', 'This room code is taken. Start again to get a new code.');
      }
      if (!room || room.ended) {
        const policy = this.#runtime.policy;
        const decision = policy ? await policy.authorizeCreate({ authorization: params.authorization ?? null, code }) : null;
        if (decision && !decision.ok) return fail(decision.code, decision.message);
        room = {
          code,
          hostPeerId: peerId,
          createdAt: Date.now(),
          ended: false,
          ...(decision?.ok ? { owner: decision.owner, maxPeople: decision.maxPeople, sessionMs: decision.sessionMs } : {}),
        };
        for (const key of Object.keys(members)) delete members[key];
        members[peerId] = { peerId, name, color, isHost: true, access: 'edit', secretHash };
        await storage.put({ room, members });
      }
    } else {
      if (!room) return fail('ROOM_NOT_FOUND', `Room ${code} does not exist. Check the invite with the host.`);
      if (room.ended) return fail('ROOM_ENDED', `Room ${code} has ended.`);
      if (!members[peerId] && !this.#socketOf(room.hostPeerId)) {
        return fail('HOST_OFFLINE', 'The host is offline, so nobody can admit you. Try again when they are back.');
      }
    }
    const member = members[peerId];
    if (member && member.name !== name) {
      member.name = name;
      await storage.put({ members });
    }
    const others = this.#admitted().filter(({ attachment }) => attachment.peerId !== peerId);
    if (!member && others.length >= MAX_PEERS) return fail('ROOM_FULL', `Room ${code} is full.`);

    // A reconnecting peer replaces its previous socket.
    for (const socket of [...this.#runtime.sockets()]) {
      if (socket.getAttachment()?.peerId !== peerId) continue;
      socket.setAttachment(null);
      socket.close(4001, 'Replaced by a newer connection');
    }

    const attachment: Attachment = { peerId, name, color, secretHash, admitted: Boolean(member), knockedAt: Date.now() };
    const socket = accept(attachment);
    if (member) {
      const self = toMember(member);
      send(socket, { type: 'welcome', self, code: room.code, peers: this.#connectedMembers(members, peerId) });
      this.#broadcast({ type: 'peer-joined', peer: self }, peerId);
      if (self.isHost) {
        for (const { attachment: pending } of this.#pending()) {
          send(socket, { type: 'knock', peer: { peerId: pending.peerId, name: pending.name, color: pending.color, at: pending.knockedAt } });
        }
      }
    } else {
      send(socket, { type: 'waiting' });
      const host = this.#socketOf(room.hostPeerId);
      if (host) send(host, { type: 'knock', peer: { peerId, name, color, at: attachment.knockedAt } });
    }
    return { ok: true, socket };
  }

  async message(socket: RoomSocket, raw: string): Promise<void> {
    const attachment = socket.getAttachment();
    if (!attachment) return;
    if (raw.length > MAX_SIGNAL_FRAME_BYTES) {
      send(socket, { type: 'error', code: 'FRAME_TOO_LARGE', message: 'Signaling frame exceeds 64 KiB.' });
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
    const message = parseSignalClientMessage(value);
    if (!message) {
      send(socket, { type: 'error', code: 'INVALID_MESSAGE', message: 'Invalid signaling message.' });
      return;
    }
    if (message.type === 'ping') {
      send(socket, { type: 'pong' });
      return;
    }
    if (!attachment.admitted) return;

    if (message.type === 'usage') {
      const room = await this.#runtime.storage.get<RoomRecord>('room');
      if (room && message.relaySeconds > 0) await this.#runtime.policy?.onUsage?.(room, attachment.peerId, message.relaySeconds);
      return;
    }

    if (message.type === 'signal') {
      const target = this.#socketOf(message.target);
      if (target?.getAttachment()?.admitted) send(target, { type: 'signal', from: attachment.peerId, payload: message.payload });
      return;
    }

    const storage = this.#runtime.storage;
    const room = await storage.get<RoomRecord>('room');
    if (!room || room.hostPeerId !== attachment.peerId) {
      send(socket, { type: 'error', code: 'NOT_HOST', message: 'Only the host can do that.' });
      return;
    }
    if (message.type === 'end') {
      await this.end();
      return;
    }
    const knocking = this.#socketOf(message.peerId);
    const pending = knocking?.getAttachment();
    if (!knocking || !pending || pending.admitted) {
      send(socket, { type: 'knock-cancelled', peerId: message.peerId });
      return;
    }
    if (message.type === 'deny') {
      send(knocking, { type: 'denied' });
      knocking.setAttachment(null);
      knocking.close(4003, 'Denied by host');
      send(socket, { type: 'knock-cancelled', peerId: message.peerId });
      return;
    }
    const members = (await storage.get<Record<string, StoredMember>>('members')) ?? {};
    const maxPeople = room.maxPeople ?? MAX_PEERS;
    if (Object.keys(members).length >= maxPeople) {
      send(socket, {
        type: 'error',
        code: 'ROOM_FULL',
        message: room.owner ? `Your plan allows ${maxPeople} people in a room. Upgrade to add more.` : `A room holds at most ${maxPeople} people.`,
      });
      return;
    }
    const stored: StoredMember = {
      peerId: pending.peerId,
      name: pending.name,
      color: pending.color,
      isHost: false,
      access: message.access,
      secretHash: pending.secretHash,
    };
    members[stored.peerId] = stored;
    await storage.put({ members });
    knocking.setAttachment({ ...pending, admitted: true });
    const self = toMember(stored);
    send(knocking, { type: 'welcome', self, code: room.code, peers: this.#connectedMembers(members, stored.peerId) });
    this.#broadcast({ type: 'peer-joined', peer: self }, stored.peerId);
  }

  /** Ends the room for everyone, optionally telling them why first. */
  async end(reason?: { code: string; message: string }): Promise<void> {
    const room = await this.#runtime.storage.get<RoomRecord>('room');
    if (room) {
      room.ended = true;
      await this.#runtime.storage.put({ room });
      await this.#runtime.policy?.onEnded?.(room);
    }
    for (const other of [...this.#runtime.sockets()]) {
      if (reason) send(other, { type: 'notice', ...reason });
      send(other, { type: 'ended' });
      other.setAttachment(null);
      other.close(1000, 'Room ended');
    }
  }

  /** Sends a notice to everyone in the room. */
  notify(code: string, message: string): void {
    for (const { socket } of this.#admitted()) send(socket, { type: 'notice', code, message });
  }

  /** Call when a socket closes or errors. Returns true when the room has no live connection left. */
  async closed(socket: RoomSocket): Promise<boolean> {
    const attachment = socket.getAttachment();
    socket.setAttachment(null);
    if (attachment) {
      if (attachment.admitted) {
        this.#broadcast({ type: 'peer-left', peerId: attachment.peerId }, attachment.peerId);
      } else {
        const room = await this.#runtime.storage.get<RoomRecord>('room');
        const host = room ? this.#socketOf(room.hostPeerId) : null;
        if (host) send(host, { type: 'knock-cancelled', peerId: attachment.peerId });
      }
    }
    return !this.#runtime.sockets().some((other) => other !== socket && other.getAttachment());
  }

  #socketOf(peerId: string): RoomSocket | null {
    return this.#runtime.sockets().find((socket) => socket.getAttachment()?.peerId === peerId) ?? null;
  }

  #admitted(): Array<{ socket: RoomSocket; attachment: Attachment }> {
    return this.#runtime.sockets().flatMap((socket) => {
      const attachment = socket.getAttachment();
      return attachment?.admitted ? [{ socket, attachment }] : [];
    });
  }

  #pending(): Array<{ socket: RoomSocket; attachment: Attachment }> {
    return this.#runtime.sockets().flatMap((socket) => {
      const attachment = socket.getAttachment();
      return attachment && !attachment.admitted ? [{ socket, attachment }] : [];
    });
  }

  #connectedMembers(members: Record<string, StoredMember>, except: string): Member[] {
    return this.#admitted()
      .filter(({ attachment }) => attachment.peerId !== except)
      .flatMap(({ attachment }) => (members[attachment.peerId] ? [toMember(members[attachment.peerId]!)] : []));
  }

  #broadcast(message: SignalServerMessage, except: string): void {
    for (const { socket, attachment } of this.#admitted()) if (attachment.peerId !== except) send(socket, message);
  }
}

/** A plain in-memory store, for the host daemon's room in direct mode and for tests. */
export class MemoryStorage implements RoomStorage {
  readonly #data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.#data.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put(entries: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) this.#data.set(key, structuredClone(value));
  }
}

export function serverMessage(message: SignalServerMessage): string {
  return JSON.stringify(message);
}

function send(socket: RoomSocket, message: SignalServerMessage): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The close handler reports the departure.
  }
}

function toMember(stored: StoredMember): Member {
  return { peerId: stored.peerId, name: stored.name, color: stored.color, isHost: stored.isHost, access: stored.access };
}

function fail(code: string, message: string): ConnectResult {
  return { ok: false, code, message };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
