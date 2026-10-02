import { EventEmitter } from 'node:events';
import nodeDataChannel, { type DataChannel, type IceServer, type PeerConnection } from 'node-datachannel';
import WebSocket from 'ws';
import {
  createSecret,
  type Identity,
  type Knock,
  type Member,
  type SignalClientMessage,
  type SignalPayload,
  type SignalServerMessage,
} from '@codex-live-share/protocol';
import { STUN_SERVERS } from '@codex-live-share/signal-core';
import { tunnelAwareLookup } from './resolve';

const FRAGMENT_BYTES = 60 * 1_024;
const HIGH_WATER_BYTES = 4 * 1_024 * 1_024;
const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 20_000];
const PING_MS = 25_000;
const METER_MS = 60_000;
const REPORT_MS = 5 * 60_000;
const DISCONNECTED_GRACE_MS = 6_000;

export interface MeshOptions {
  signalUrl: string;
  code: string;
  action: 'create' | 'join';
  self: Identity;
  secret: string;
  /** Hosted mode: ask the service for TURN relay credentials. Direct mode uses STUN only. */
  hosted: boolean;
  /** Hosted mode: the host's Live Share token, sent when creating the room. */
  authToken?: string | null;
  log: (message: string) => void;
}

export interface MeshEvents {
  status: [status: 'connecting' | 'waiting' | 'connected' | 'reconnecting' | 'denied' | 'ended' | 'error', detail: string | null];
  members: [members: Member[]];
  knocks: [knocks: Knock[]];
  open: [peerId: string];
  close: [peerId: string];
  message: [peerId: string, frame: Uint8Array];
  /** Service notices (plan limits) and in-session refusals. */
  notice: [code: string, message: string];
}

interface Link {
  peerId: string;
  pc: PeerConnection;
  channel: DataChannel | null;
  open: boolean;
  queue: Uint8Array[];
  queuedBytes: number;
  partial: Map<number, { chunks: Uint8Array[]; received: number }>;
  nextMessageId: number;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Full mesh of WebRTC data channels between daemons, negotiated through the
 * signal room. For each pair the peer with the smaller id creates the data
 * channel and makes the offer, so offers never collide.
 */
export class PeerMesh extends EventEmitter<MeshEvents> {
  readonly #options: MeshOptions;
  readonly #links = new Map<string, Link>();
  readonly #members = new Map<string, Member>();
  /** Peers the room reported gone while their data channel was still up. */
  readonly #departed = new Set<string>();
  #knocks: Knock[] = [];
  #self: Member | null = null;
  #socket: WebSocket | null = null;
  #iceServers: Array<string | IceServer> = [];
  #attempt = 0;
  #closed = false;
  #ping: ReturnType<typeof setInterval> | null = null;
  #reconnect: ReturnType<typeof setTimeout> | null = null;
  #action: 'create' | 'join';
  #iceRefresh: ReturnType<typeof setTimeout> | null = null;
  #meter: ReturnType<typeof setInterval> | null = null;
  #relaySeconds = 0;
  #relayReportedAt = Date.now();
  #awaitingMembership = true;

  constructor(options: MeshOptions) {
    super();
    this.#options = options;
    this.#action = options.action;
  }

  get self(): Member | null {
    return this.#self;
  }

  get members(): Member[] {
    return [...this.#members.values()];
  }

  get knocks(): Knock[] {
    return this.#knocks;
  }

  get connectedPeers(): string[] {
    return [...this.#links.values()].filter((link) => link.open).map((link) => link.peerId);
  }

  member(peerId: string): Member | undefined {
    return this.#members.get(peerId);
  }

  async start(): Promise<void> {
    await this.#refreshIce();
    this.#connect();
    this.#meter = setInterval(() => this.#meterRelay(), METER_MS);
  }

  /** Hosted rooms hand out TURN credentials that expire; renew them before they do. */
  async #refreshIce(): Promise<void> {
    const { signalUrl, code, self, secret, hosted } = this.#options;
    const result = await fetchIceServers(hosted ? signalUrl : null, { code, peerId: self.peerId, secret }).catch((error: unknown) => {
      this.#options.log(`ICE configuration unavailable, using public STUN: ${String(error)}`);
      return { servers: toNodeIceServers(STUN_SERVERS), expiresIn: null, reason: null };
    });
    this.#iceServers = result.servers;
    if (result.reason) this.#options.log(`No relay: ${result.reason}`);
    if (this.#iceRefresh) clearTimeout(this.#iceRefresh);
    if (result.expiresIn && !this.#closed) {
      this.#iceRefresh = setTimeout(() => void this.#refreshIce(), Math.max(30_000, result.expiresIn * 800));
    }
  }

  /** Hosted mode meters TURN use: count time on links whose selected path is a relay, and report it. */
  #meterRelay(): void {
    for (const link of this.#links.values()) {
      if (!link.open) continue;
      try {
        const pair = link.pc.getSelectedCandidatePair();
        if (pair && (pair.local.type === 'relay' || pair.remote.type === 'relay')) this.#relaySeconds += METER_MS / 1_000;
      } catch {
        // Closing connection.
      }
    }
    if (this.#relaySeconds > 0 && Date.now() - this.#relayReportedAt >= REPORT_MS && this.#socket?.readyState === WebSocket.OPEN) {
      this.#signal({ type: 'usage', relaySeconds: this.#relaySeconds });
      this.#relaySeconds = 0;
      this.#relayReportedAt = Date.now();
    }
  }

  get relayed(): boolean {
    for (const link of this.#links.values()) {
      try {
        const pair = link.open ? link.pc.getSelectedCandidatePair() : null;
        if (pair && (pair.local.type === 'relay' || pair.remote.type === 'relay')) return true;
      } catch {
        // Closing connection.
      }
    }
    return false;
  }

  send(peerId: string, frame: Uint8Array): void {
    const link = this.#links.get(peerId);
    if (link?.open) this.#enqueue(link, frame);
  }

  broadcast(frame: Uint8Array, except?: string): void {
    for (const link of this.#links.values()) if (link.open && link.peerId !== except) this.#enqueue(link, frame);
  }

  /** Where to reconnect to; takes effect now if signaling is currently down. */
  setSignalUrl(url: string): void {
    if (this.#options.signalUrl === url) return;
    this.#options.signalUrl = url;
    if (!this.#closed && this.#socket?.readyState !== WebSocket.OPEN) {
      if (this.#reconnect) clearTimeout(this.#reconnect);
      this.#socket?.close();
      this.#socket = null;
      this.#connect();
    }
  }

  /** Reconnects so the room records the new name and announces it to everyone. */
  rename(name: string): void {
    this.#options.self = { ...this.#options.self, name };
    this.#socket?.close(1000, 'Renamed');
  }

  admit(peerId: string, access: 'edit' | 'view'): void {
    this.#signal({ type: 'admit', peerId, access });
  }

  deny(peerId: string): void {
    this.#signal({ type: 'deny', peerId });
  }

  end(): void {
    this.#signal({ type: 'end' });
  }

  close(): void {
    this.#closed = true;
    if (this.#relaySeconds > 0) this.#signal({ type: 'usage', relaySeconds: this.#relaySeconds });
    if (this.#iceRefresh) clearTimeout(this.#iceRefresh);
    if (this.#meter) clearInterval(this.#meter);
    if (this.#ping) clearInterval(this.#ping);
    if (this.#reconnect) clearTimeout(this.#reconnect);
    this.#socket?.close(1000, 'Daemon stopping');
    for (const peerId of [...this.#links.keys()]) this.#dropLink(peerId);
  }

  #connect(): void {
    const { signalUrl, code, self, secret } = this.#options;
    const url = new URL(`/api/rooms/${code}/connect`, signalUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = new URLSearchParams({ action: this.#action, peerId: self.peerId, name: self.name, color: self.color, secret }).toString();
    this.emit('status', this.#attempt ? 'reconnecting' : 'connecting', null);
    // A quick-tunnel name is resolved without the OS cache (see resolve.ts).
    const headers: Record<string, string> = this.#options.authToken ? { Authorization: `Bearer ${this.#options.authToken}` } : {};
    const socket = new WebSocket(url, { lookup: tunnelAwareLookup as never, handshakeTimeout: 15_000, headers });
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      let message: SignalServerMessage;
      try {
        message = JSON.parse(String(event.data)) as SignalServerMessage;
      } catch {
        return;
      }
      this.#onSignal(message);
    });
    socket.addEventListener('error', () => {
      // Followed by 'close', which schedules the retry.
    });
    socket.addEventListener('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      if (this.#ping) clearInterval(this.#ping);
      if (this.#closed) return;
      const delay = RECONNECT_MS[Math.min(this.#attempt, RECONNECT_MS.length - 1)]!;
      this.#attempt += 1;
      this.emit('status', 'reconnecting', 'Signal server connection lost; peers stay connected.');
      this.#reconnect = setTimeout(() => this.#connect(), delay);
    });
    this.#ping = setInterval(() => this.#signal({ type: 'ping' }), PING_MS);
  }

  #onSignal(message: SignalServerMessage): void {
    switch (message.type) {
      case 'welcome': {
        this.#attempt = 0;
        // Once a room exists, every later connection (including a host's) is a join.
        this.#action = 'join';
        this.#self = message.self;
        // Keep peers whose data channel is still up even if the room lost them.
        const still = [...this.#members.values()].filter((member) => this.#links.get(member.peerId)?.open);
        this.#members.clear();
        for (const member of still) this.#members.set(member.peerId, member);
        this.#members.set(message.self.peerId, message.self);
        for (const peer of message.peers) this.#members.set(peer.peerId, peer);
        this.emit('members', this.members);
        this.emit('status', 'connected', null);
        // Relay credentials are only issued to members; a guest asked while still knocking.
        if (this.#options.hosted && this.#awaitingMembership) {
          this.#awaitingMembership = false;
          void this.#refreshIce();
        }
        for (const peer of message.peers) this.#ensureLink(peer.peerId);
        for (const peerId of [...this.#links.keys()]) if (!this.#members.has(peerId)) this.#dropLink(peerId);
        break;
      }
      case 'waiting':
        this.emit('status', 'waiting', null);
        break;
      case 'knock':
        this.#knocks = [...this.#knocks.filter((knock) => knock.peerId !== message.peer.peerId), message.peer];
        this.emit('knocks', this.#knocks);
        break;
      case 'knock-cancelled':
        this.#knocks = this.#knocks.filter((knock) => knock.peerId !== message.peerId);
        this.emit('knocks', this.#knocks);
        break;
      case 'denied':
        this.#closed = true;
        this.emit('status', 'denied', 'The host declined the request.');
        break;
      case 'peer-joined':
        this.#departed.delete(message.peer.peerId);
        this.#members.set(message.peer.peerId, message.peer);
        this.#knocks = this.#knocks.filter((knock) => knock.peerId !== message.peer.peerId);
        this.emit('knocks', this.#knocks);
        this.emit('members', this.members);
        this.#ensureLink(message.peer.peerId, true);
        break;
      case 'peer-left':
        // The data channel may outlive the signaling socket; only drop it if it is down too.
        if (this.#links.get(message.peerId)?.open) {
          this.#departed.add(message.peerId);
        } else {
          this.#members.delete(message.peerId);
          this.#dropLink(message.peerId);
          this.emit('members', this.members);
        }
        break;
      case 'signal':
        this.#onPeerSignal(message.from, message.payload);
        break;
      case 'ended':
        this.#closed = true;
        this.emit('status', 'ended', 'The host ended the session.');
        break;
      case 'notice':
        this.#options.log(`Notice ${message.code}: ${message.message}`);
        this.emit('notice', message.code, message.message);
        break;
      case 'error':
        // After admission, an error is a refused request (e.g. the room is full), not a broken session.
        if (this.#self && this.#members.has(this.#self.peerId) && message.code === 'ROOM_FULL') {
          this.emit('notice', message.code, message.message);
          break;
        }
        this.emit('status', 'error', message.message);
        if (['ROOM_NOT_FOUND', 'ROOM_ENDED', 'ROOM_EXISTS', 'ROOM_FULL', 'INVALID_SECRET', 'HOST_OFFLINE', 'AUTH_REQUIRED', 'ROOM_LIMIT'].includes(message.code)) {
          this.#closed = true;
        }
        break;
      case 'pong':
        break;
    }
  }

  #ensureLink(peerId: string, fresh = false): void {
    if (!this.#self || peerId === this.#self.peerId) return;
    const existing = this.#links.get(peerId);
    if (existing && !fresh) return;
    if (existing?.open) return;
    if (existing) this.#dropLink(peerId);
    if (this.#self.peerId < peerId) this.#createLink(peerId, true);
  }

  #createLink(peerId: string, initiator: boolean): Link {
    const pc = new nodeDataChannel.PeerConnection(`live-share-${peerId.slice(0, 6)}`, {
      iceServers: this.#iceServers,
      maxMessageSize: 256 * 1_024,
    });
    const link: Link = {
      peerId,
      pc,
      channel: null,
      open: false,
      queue: [],
      queuedBytes: 0,
      partial: new Map(),
      nextMessageId: 1,
      disconnectTimer: null,
    };
    this.#links.set(peerId, link);
    pc.onLocalDescription((sdp, type) => this.#signal({ type: 'signal', target: peerId, payload: { kind: 'description', type, sdp } }));
    pc.onLocalCandidate((candidate, mid) => this.#signal({ type: 'signal', target: peerId, payload: { kind: 'candidate', candidate, mid } }));
    pc.onStateChange((state) => {
      if (this.#links.get(peerId) !== link) return;
      if (state === 'connected' && link.disconnectTimer) {
        clearTimeout(link.disconnectTimer);
        link.disconnectTimer = null;
      }
      if (state === 'failed' || state === 'closed') this.#restart(peerId, link);
      if (state === 'disconnected' && !link.disconnectTimer) {
        link.disconnectTimer = setTimeout(() => this.#restart(peerId, link), DISCONNECTED_GRACE_MS);
      }
    });
    pc.onDataChannel((channel) => this.#attachChannel(link, channel));
    if (initiator) this.#attachChannel(link, pc.createDataChannel('live-share'));
    return link;
  }

  #attachChannel(link: Link, channel: DataChannel): void {
    link.channel = channel;
    channel.setBufferedAmountLowThreshold(HIGH_WATER_BYTES / 4);
    channel.onOpen(() => {
      if (this.#links.get(link.peerId) !== link) return;
      link.open = true;
      this.#options.log(`Connected to ${this.#members.get(link.peerId)?.name ?? link.peerId}`);
      this.emit('open', link.peerId);
    });
    channel.onClosed(() => this.#restart(link.peerId, link));
    channel.onError((error) => this.#options.log(`Data channel error with ${link.peerId}: ${error}`));
    channel.onBufferedAmountLow(() => this.#drain(link));
    channel.onMessage((message) => {
      if (typeof message === 'string') return;
      const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      const frame = this.#reassemble(link, bytes);
      if (frame) this.emit('message', link.peerId, frame);
    });
  }

  #restart(peerId: string, link: Link): void {
    if (this.#links.get(peerId) !== link) return;
    const wasOpen = link.open;
    this.#dropLink(peerId);
    if (wasOpen) this.emit('close', peerId);
    if (this.#departed.delete(peerId)) {
      this.#members.delete(peerId);
      this.emit('members', this.members);
    }
    if (this.#closed || !this.#members.has(peerId)) return;
    setTimeout(() => {
      if (!this.#links.has(peerId) && this.#members.has(peerId)) this.#ensureLink(peerId);
    }, 1_500);
  }

  #dropLink(peerId: string): void {
    const link = this.#links.get(peerId);
    if (!link) return;
    this.#links.delete(peerId);
    if (link.disconnectTimer) clearTimeout(link.disconnectTimer);
    try {
      link.channel?.close();
      link.pc.close();
    } catch {
      // Already closed.
    }
    if (link.open) this.emit('close', peerId);
  }

  #onPeerSignal(from: string, payload: SignalPayload): void {
    if (!this.#self) return;
    let link = this.#links.get(from);
    if (payload.kind === 'description') {
      if (payload.type === 'offer') {
        if (link && this.#self.peerId < from) return; // We are the offerer for this pair.
        if (link) this.#dropLink(from);
        link = this.#createLink(from, false);
      }
      if (!link) return;
      try {
        link.pc.setRemoteDescription(payload.sdp, payload.type as 'offer' | 'answer');
      } catch (error) {
        this.#options.log(`Bad remote description from ${from}: ${String(error)}`);
      }
      return;
    }
    if (!link) return;
    try {
      link.pc.addRemoteCandidate(payload.candidate, payload.mid);
    } catch {
      // Candidates for a replaced connection.
    }
  }

  #signal(message: SignalClientMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  /** Frames: [0][body] whole, or [1][id u32][index u16][count u16][chunk]. */
  #enqueue(link: Link, frame: Uint8Array): void {
    if (frame.byteLength + 1 <= FRAGMENT_BYTES) {
      const whole = new Uint8Array(frame.byteLength + 1);
      whole.set(frame, 1);
      this.#push(link, whole);
    } else {
      const id = link.nextMessageId++ >>> 0;
      const count = Math.ceil(frame.byteLength / FRAGMENT_BYTES);
      for (let index = 0; index < count; index += 1) {
        const chunk = frame.subarray(index * FRAGMENT_BYTES, (index + 1) * FRAGMENT_BYTES);
        const part = new Uint8Array(chunk.byteLength + 9);
        const view = new DataView(part.buffer);
        part[0] = 1;
        view.setUint32(1, id);
        view.setUint16(5, index);
        view.setUint16(7, count);
        part.set(chunk, 9);
        this.#push(link, part);
      }
    }
    this.#drain(link);
  }

  #push(link: Link, part: Uint8Array): void {
    link.queue.push(part);
    link.queuedBytes += part.byteLength;
  }

  #drain(link: Link): void {
    const channel = link.channel;
    if (!channel || !link.open) return;
    while (link.queue.length && channel.bufferedAmount() < HIGH_WATER_BYTES) {
      const part = link.queue.shift()!;
      link.queuedBytes -= part.byteLength;
      try {
        channel.sendMessageBinary(part);
      } catch (error) {
        this.#options.log(`Send to ${link.peerId} failed: ${String(error)}`);
        return;
      }
    }
  }

  #reassemble(link: Link, bytes: Uint8Array): Uint8Array | null {
    if (bytes[0] === 0) return bytes.slice(1);
    if (bytes[0] !== 1 || bytes.byteLength < 9) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const id = view.getUint32(1);
    const index = view.getUint16(5);
    const count = view.getUint16(7);
    let entry = link.partial.get(id);
    if (!entry) {
      entry = { chunks: new Array<Uint8Array>(count), received: 0 };
      link.partial.set(id, entry);
    }
    if (!entry.chunks[index]) {
      entry.chunks[index] = bytes.slice(9);
      entry.received += 1;
    }
    if (entry.received < count) return null;
    link.partial.delete(id);
    const size = entry.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const frame = new Uint8Array(size);
    let offset = 0;
    for (const chunk of entry.chunks) {
      frame.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return frame;
  }
}

export function newPeerSecret(): string {
  return createSecret();
}

interface IceResult {
  servers: Array<string | IceServer>;
  expiresIn: number | null;
  reason: string | null;
}

/** Direct mode (no service URL) never has TURN; hosted members ask the room's service for credentials. */
async function fetchIceServers(serviceUrl: string | null, member: { code: string; peerId: string; secret: string }): Promise<IceResult> {
  if (!serviceUrl) return { servers: toNodeIceServers(STUN_SERVERS), expiresIn: null, reason: null };
  const response = await fetch(new URL('/api/ice-servers', serviceUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(member),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as {
    iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
    expiresIn?: number;
    reason?: string;
  };
  return {
    servers: toNodeIceServers(payload.iceServers ?? STUN_SERVERS),
    expiresIn: typeof payload.expiresIn === 'number' ? payload.expiresIn : null,
    reason: payload.reason ?? null,
  };
}

/** Browser-style RTCIceServer entries to libdatachannel's format. */
export function toNodeIceServers(servers: Array<{ urls: string | string[]; username?: string; credential?: string }>): Array<string | IceServer> {
  const result: Array<string | IceServer> = [];
  for (const server of servers) {
    for (const url of typeof server.urls === 'string' ? [server.urls] : server.urls) {
      const match = /^(stun|stuns|turn|turns):([^:?]+|\[[^\]]+\])(?::(\d+))?(?:\?transport=(udp|tcp))?$/iu.exec(url);
      if (!match) continue;
      const scheme = match[1]!.toLowerCase();
      const hostname = match[2]!;
      const port = Number(match[3] ?? (scheme === 'turns' || scheme === 'stuns' ? 5349 : 3478));
      if (port === 53) continue;
      if (scheme === 'stun' || scheme === 'stuns') {
        result.push(`stun:${hostname}:${port}`);
      } else if (server.username && server.credential) {
        const relayType = scheme === 'turns' ? 'TurnTls' : match[4]?.toLowerCase() === 'tcp' ? 'TurnTcp' : 'TurnUdp';
        result.push({ hostname, port, username: server.username, password: server.credential, relayType });
      }
    }
  }
  return result;
}
