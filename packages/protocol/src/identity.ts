export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/u;
export const PEER_ID_PATTERN = /^[0-9a-f]{32}$/u;
export const MAX_PEERS = 8;
export const MAX_NAME_LENGTH = 40;

/** Distinct, legible on both dark and light editor backgrounds. */
export const PEER_COLORS = ['#f97316', '#22c55e', '#3b82f6', '#e11d48', '#a855f7', '#14b8a6', '#eab308', '#ec4899'] as const;

export type Access = 'edit' | 'view';

export interface Identity {
  peerId: string;
  name: string;
  color: string;
}

export interface Member extends Identity {
  isHost: boolean;
  access: Access;
}

export function createRoomCode(random: (size: number) => Uint8Array = randomBytes): string {
  const bytes = random(6);
  let code = '';
  for (const byte of bytes) code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
  return code;
}

export function createPeerId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

export function createSecret(): string {
  return Array.from(randomBytes(24), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizeRoomCode(value: string): string | null {
  const code = value.trim().toUpperCase().replaceAll(/[\s-]/gu, '');
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}

export function normalizeDisplayName(value: string): string | null {
  const name = value.normalize('NFC').replaceAll(/[\u0000-\u001f\u007f]/gu, '').trim().replaceAll(/\s+/gu, ' ');
  if (!name) return null;
  return [...name].slice(0, MAX_NAME_LENGTH).join('');
}

export function isColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value);
}

export function colorFor(peerId: string): string {
  let hash = 0;
  for (const char of peerId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PEER_COLORS[hash % PEER_COLORS.length] ?? PEER_COLORS[0];
}

/** How an agent is labelled everywhere: the owner's name makes it attributable. */
export function agentLabel(ownerName: string): string {
  return `${ownerName}'s Codex`;
}

function randomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}
