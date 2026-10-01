import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { FRAME_AWARENESS, FRAME_CONTROL, FRAME_SYNC, decodeControl } from '@codex-live-share/protocol';

export interface Endpoint {
  id: string;
  kind: 'peer' | 'local';
  send(frame: Uint8Array): void;
  /** False drops this endpoint's document writes; it can still read and publish awareness. */
  canWrite(): boolean;
  onControl(message: unknown): void;
}

/**
 * The daemon's replica of the shared doc and the router between its endpoints:
 * remote daemons over WebRTC and local browser tabs over WebSocket. Updates
 * from any endpoint are relayed to every other one, so a peer that loses its
 * direct link to a third peer still converges through us.
 */
export class DocHub {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly #endpoints = new Map<string, Endpoint>();
  /** Awareness client ids learned from each endpoint, removed when it leaves. */
  readonly #clientsBy = new Map<string, Set<number>>();
  /** Called when an endpoint has sent us its full state (sync step 2). */
  onSynced: ((endpointId: string) => void) | null = null;

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.awareness = new awarenessProtocol.Awareness(doc);
    doc.on('update', this.#onUpdate);
    this.awareness.on('update', this.#onAwareness);
  }

  get endpoints(): Endpoint[] {
    return [...this.#endpoints.values()];
  }

  add(endpoint: Endpoint): void {
    this.#endpoints.set(endpoint.id, endpoint);
    this.#clientsBy.set(endpoint.id, new Set());
    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, this.doc);
    endpoint.send(frame(FRAME_SYNC, encoding.toUint8Array(encoder)));
    const states = [...this.awareness.getStates().keys()];
    if (states.length) {
      endpoint.send(frame(FRAME_AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.awareness, states)));
    }
  }

  remove(id: string): void {
    this.#endpoints.delete(id);
    const clients = this.#clientsBy.get(id);
    this.#clientsBy.delete(id);
    if (clients?.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...clients], id);
  }

  receive(id: string, data: Uint8Array): void {
    const endpoint = this.#endpoints.get(id);
    if (!endpoint || data.byteLength === 0) return;
    const type = data[0];
    const body = data.subarray(1);
    if (type === FRAME_SYNC) {
      const decoder = decoding.createDecoder(body);
      const encoder = encoding.createEncoder();
      const kind = decoding.peekVarUint(decoder);
      if (kind !== syncProtocol.messageYjsSyncStep1 && !endpoint.canWrite()) return;
      try {
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, endpoint.id);
      } catch {
        return;
      }
      if (encoding.length(encoder) > 0) endpoint.send(frame(FRAME_SYNC, encoding.toUint8Array(encoder)));
      if (kind === syncProtocol.messageYjsSyncStep2) this.onSynced?.(endpoint.id);
    } else if (type === FRAME_AWARENESS) {
      try {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, body, endpoint.id);
      } catch {
        // Malformed awareness is ignored.
      }
    } else if (type === FRAME_CONTROL) {
      endpoint.onControl(decodeControl(data));
    }
  }

  broadcast(data: Uint8Array, filter: (endpoint: Endpoint) => boolean = () => true): void {
    for (const endpoint of this.#endpoints.values()) if (filter(endpoint)) endpoint.send(data);
  }

  setLocalState(state: Record<string, unknown> | null): void {
    this.awareness.setLocalState(state);
  }

  destroy(): void {
    this.doc.off('update', this.#onUpdate);
    this.awareness.off('update', this.#onAwareness);
    this.awareness.destroy();
  }

  readonly #onUpdate = (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    const data = frame(FRAME_SYNC, encoding.toUint8Array(encoder));
    for (const endpoint of this.#endpoints.values()) if (endpoint.id !== origin) endpoint.send(data);
  };

  readonly #onAwareness = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (typeof origin === 'string') {
      const clients = this.#clientsBy.get(origin);
      if (clients) {
        for (const client of [...added, ...updated]) clients.add(client);
        for (const client of removed) clients.delete(client);
      }
    }
    const changed = [...added, ...updated, ...removed];
    if (!changed.length) return;
    const data = frame(FRAME_AWARENESS, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
    for (const endpoint of this.#endpoints.values()) if (endpoint.id !== origin) endpoint.send(data);
  };
}

export function frame(type: number, body: Uint8Array): Uint8Array {
  const data = new Uint8Array(body.byteLength + 1);
  data[0] = type;
  data.set(body, 1);
  return data;
}
