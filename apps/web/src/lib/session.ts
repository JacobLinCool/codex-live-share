import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import {
  FRAME_AWARENESS,
  FRAME_CONTROL,
  FRAME_SYNC,
  decodeControl,
  encodeControl,
  isRecord,
  withFrameType,
  type LocalClientMessage,
  type SessionInfo,
} from '@codex-live-share/protocol';

export type Connection = 'connecting' | 'open' | 'closed';

/**
 * The browser tab's replica of the shared doc, kept in sync with this
 * machine's daemon over one WebSocket. The daemon relays everything to peers.
 */
export class LiveSession {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly token: string;
  session: SessionInfo | null = null;
  connection: Connection = 'connecting';
  /** True once the first full state from the daemon has been applied. */
  synced = false;
  #socket: WebSocket | null = null;
  #listeners = new Set<() => void>();
  #retry = 0;
  #closed = false;

  constructor(token: string) {
    this.token = token;
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const encoder = encoding.createEncoder();
      syncProtocol.writeUpdate(encoder, update);
      this.#send(withFrameType(FRAME_SYNC, encoding.toUint8Array(encoder)));
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === this) return;
      const changed = [...added, ...updated, ...removed];
      this.#send(withFrameType(FRAME_AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)));
    });
    window.addEventListener('beforeunload', () => {
      awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'unload');
    });
    this.#connect();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  control(message: LocalClientMessage | { type: 'transcript'; text: string }): void {
    this.#send(encodeControl(message));
  }

  close(): void {
    this.#closed = true;
    this.#socket?.close();
  }

  #connect(): void {
    const url = new URL('/ws', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('t', this.token);
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;
    this.connection = 'connecting';
    this.#emit();
    socket.addEventListener('open', () => {
      this.#retry = 0;
      this.connection = 'open';
      const encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep1(encoder, this.doc);
      socket.send(withFrameType(FRAME_SYNC, encoding.toUint8Array(encoder)));
      if (this.awareness.getLocalState()) {
        socket.send(withFrameType(FRAME_AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID])));
      }
      this.#emit();
    });
    socket.addEventListener('message', (event) => this.#receive(new Uint8Array(event.data as ArrayBuffer)));
    socket.addEventListener('close', () => {
      if (this.#socket !== socket) return;
      this.connection = 'closed';
      const remote = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      awarenessProtocol.removeAwarenessStates(this.awareness, remote, this);
      this.#emit();
      if (this.#closed || this.session?.status === 'ended') return;
      const delay = Math.min(10_000, 500 * 2 ** this.#retry++);
      setTimeout(() => this.#connect(), delay);
    });
  }

  #receive(data: Uint8Array): void {
    const type = data[0];
    const body = data.subarray(1);
    if (type === FRAME_SYNC) {
      const decoder = decoding.createDecoder(body);
      const encoder = encoding.createEncoder();
      const kind = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (encoding.length(encoder) > 0) this.#send(withFrameType(FRAME_SYNC, encoding.toUint8Array(encoder)));
      if (kind === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true;
        this.#emit();
      }
    } else if (type === FRAME_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, body, this);
    } else if (type === FRAME_CONTROL) {
      const message = decodeControl(data);
      if (isRecord(message) && message['type'] === 'session') {
        this.session = message['session'] as SessionInfo;
        this.#emit();
      }
    }
  }

  #send(frame: Uint8Array<ArrayBuffer>): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(frame);
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

/** The token arrives in the URL once, then moves to sessionStorage so it is not left in history. */
export function takeToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('t');
  if (fromUrl) {
    try {
      sessionStorage.setItem('live-share-token', fromUrl);
    } catch {
      // Storage unavailable; keep the token in the URL.
      return fromUrl;
    }
    url.searchParams.delete('t');
    window.history.replaceState(null, '', url);
    return fromUrl;
  }
  try {
    return sessionStorage.getItem('live-share-token');
  } catch {
    return null;
  }
}
