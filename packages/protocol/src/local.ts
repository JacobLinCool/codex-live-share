import type { Access, Identity, Member } from './identity';
import type { Knock } from './signal';
import { isRecord } from './signal';

/** First byte of every binary frame, on the local WebSocket and between peers. */
export const FRAME_SYNC = 0;
export const FRAME_AWARENESS = 1;
export const FRAME_CONTROL = 2;

export type SessionStatus = 'starting' | 'connecting' | 'waiting' | 'connected' | 'reconnecting' | 'denied' | 'ended' | 'error';

export interface SessionInfo {
  self: Identity;
  role: 'host' | 'guest';
  access: Access;
  code: string | null;
  /** direct: signaling through the host's own tunnel; hosted: our Worker with a TURN relay. */
  mode: 'direct' | 'hosted';
  inviteUrl: string | null;
  /** False until this person has confirmed their display name. */
  nameConfirmed: boolean;
  status: SessionStatus;
  error: string | null;
  folderName: string;
  members: Member[];
  /** Peers whose data channel is currently open. */
  connected: string[];
  knocks: Knock[];
  asr: { provider: 'openai' | 'gemini' | null };
}

/** What the daemon publishes in its awareness state, read by every UI. */
export interface PeerAwareness {
  user: Identity & { kind: 'daemon' };
  agent: AgentActivity | null;
}

export interface AgentActivity {
  label: string;
  state: 'idle' | 'planning' | 'editing';
  file: string | null;
  at: string;
}

/** What a browser tab publishes in its awareness state. */
export interface UserAwareness {
  user: Identity & { kind: 'human'; colorLight: string };
  file: string | null;
  interim: string | null;
  cursor?: unknown;
}

export type LocalServerMessage = { type: 'session'; session: SessionInfo };

export type LocalClientMessage =
  | { type: 'admit'; peerId: string; access: Access }
  | { type: 'deny'; peerId: string }
  | { type: 'end' }
  | { type: 'rename'; name: string }
  | { type: 'set-asr-key'; provider: 'openai' | 'gemini'; key: string };

export function parseLocalClientMessage(value: unknown): LocalClientMessage | null {
  if (!isRecord(value)) return null;
  switch (value['type']) {
    case 'admit':
      return typeof value['peerId'] === 'string' && (value['access'] === 'edit' || value['access'] === 'view')
        ? { type: 'admit', peerId: value['peerId'], access: value['access'] }
        : null;
    case 'deny':
      return typeof value['peerId'] === 'string' ? { type: 'deny', peerId: value['peerId'] } : null;
    case 'end':
      return { type: 'end' };
    case 'rename':
      return typeof value['name'] === 'string' ? { type: 'rename', name: value['name'] } : null;
    case 'set-asr-key':
      return (value['provider'] === 'openai' || value['provider'] === 'gemini') && typeof value['key'] === 'string'
        && value['key'].trim().length >= 16 && value['key'].length <= 512
        ? { type: 'set-asr-key', provider: value['provider'], key: value['key'].trim() }
        : null;
    default:
      return null;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeControl(message: unknown): Uint8Array<ArrayBuffer> {
  const body = encoder.encode(JSON.stringify(message));
  const frame = new Uint8Array(body.byteLength + 1);
  frame[0] = FRAME_CONTROL;
  frame.set(body, 1);
  return frame;
}

export function decodeControl(frame: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(frame.subarray(1)));
  } catch {
    return null;
  }
}

export function withFrameType(type: number, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(body.byteLength + 1);
  frame[0] = type;
  frame.set(body, 1);
  return frame;
}
