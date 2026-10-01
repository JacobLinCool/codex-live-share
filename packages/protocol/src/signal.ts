import type { Access, Identity, Member } from './identity';

export const MAX_SIGNAL_FRAME_BYTES = 64 * 1_024;

/** Opaque WebRTC negotiation payload relayed between two admitted peers. */
export type SignalPayload =
  | { kind: 'description'; type: string; sdp: string }
  | { kind: 'candidate'; candidate: string; mid: string };

export type SignalClientMessage =
  | { type: 'signal'; target: string; payload: SignalPayload }
  | { type: 'admit'; peerId: string; access: Access }
  | { type: 'deny'; peerId: string }
  | { type: 'end' }
  | { type: 'ping' };

export interface Knock extends Identity {
  at: number;
}

export type SignalServerMessage =
  | { type: 'welcome'; self: Member; peers: Member[]; code: string }
  | { type: 'waiting' }
  | { type: 'knock'; peer: Knock }
  | { type: 'knock-cancelled'; peerId: string }
  | { type: 'denied' }
  | { type: 'peer-joined'; peer: Member }
  | { type: 'peer-left'; peerId: string }
  | { type: 'signal'; from: string; payload: SignalPayload }
  | { type: 'ended' }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

export type ConnectAction = 'create' | 'join';

export function parseSignalClientMessage(value: unknown): SignalClientMessage | null {
  if (!isRecord(value) || typeof value['type'] !== 'string') return null;
  switch (value['type']) {
    case 'signal': {
      const payload = parseSignalPayload(value['payload']);
      return typeof value['target'] === 'string' && payload ? { type: 'signal', target: value['target'], payload } : null;
    }
    case 'admit':
      return typeof value['peerId'] === 'string' && (value['access'] === 'edit' || value['access'] === 'view')
        ? { type: 'admit', peerId: value['peerId'], access: value['access'] }
        : null;
    case 'deny':
      return typeof value['peerId'] === 'string' ? { type: 'deny', peerId: value['peerId'] } : null;
    case 'end':
      return { type: 'end' };
    case 'ping':
      return { type: 'ping' };
    default:
      return null;
  }
}

export function parseSignalPayload(value: unknown): SignalPayload | null {
  if (!isRecord(value)) return null;
  if (value['kind'] === 'description' && typeof value['type'] === 'string' && typeof value['sdp'] === 'string') {
    return { kind: 'description', type: value['type'], sdp: value['sdp'] };
  }
  if (value['kind'] === 'candidate' && typeof value['candidate'] === 'string' && typeof value['mid'] === 'string') {
    return { kind: 'candidate', candidate: value['candidate'], mid: value['mid'] };
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
