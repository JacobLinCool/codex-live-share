import * as Y from 'yjs';
import type { Identity } from './identity';
import type { Plan } from './plan';

/**
 * One Y.Doc per shared folder.
 * - files: relative POSIX path -> Y.Text (text files) or BlobRef (binary files)
 * - blobs: sha256 -> bytes, kept only while some path references the hash
 * - plans: plan id -> Plan, written only by the owning peer
 * - agentMessages: bounded, expiring coordination messages addressed to a chat
 * - transcript: finalized lines, each appended by the speaker's own peer
 * - edits: recent agent edits with relative ranges, so every UI can highlight them
 */
export interface BlobRef {
  kind: 'blob';
  hash: string;
  size: number;
}

export type FileValue = Y.Text | BlobRef;

export interface TranscriptLine {
  id: string;
  speaker: Identity;
  text: string;
  at: string;
}

export interface EditRecord {
  id: string;
  actor: Identity;
  kind: 'agent' | 'human';
  path: string;
  at: string;
  /** Base64 encoded Y.RelativePosition pairs covering inserted text. */
  ranges: Array<[string, string]>;
}

export interface DocMeta {
  docId: string;
  createdAt: string;
  rootName: string;
}

export const MAX_EDIT_RECORDS = 200;

export function filesOf(doc: Y.Doc): Y.Map<FileValue> {
  return doc.getMap<FileValue>('files');
}

export function blobsOf(doc: Y.Doc): Y.Map<Uint8Array> {
  return doc.getMap<Uint8Array>('blobs');
}

export function plansOf(doc: Y.Doc): Y.Map<Plan> {
  return doc.getMap<Plan>('plans');
}

export function transcriptOf(doc: Y.Doc): Y.Array<TranscriptLine> {
  return doc.getArray<TranscriptLine>('transcript');
}

export function editsOf(doc: Y.Doc): Y.Array<EditRecord> {
  return doc.getArray<EditRecord>('edits');
}

export function metaOf(doc: Y.Doc): Y.Map<string> {
  return doc.getMap<string>('meta');
}

export function readMeta(doc: Y.Doc): DocMeta | null {
  const meta = metaOf(doc);
  const docId = meta.get('docId');
  const createdAt = meta.get('createdAt');
  const rootName = meta.get('rootName');
  return docId && createdAt && rootName ? { docId, createdAt, rootName } : null;
}

export function isBlobRef(value: unknown): value is BlobRef {
  return typeof value === 'object' && value !== null && (value as BlobRef).kind === 'blob'
    && typeof (value as BlobRef).hash === 'string' && typeof (value as BlobRef).size === 'number';
}

export function appendEdit(doc: Y.Doc, record: EditRecord): void {
  const edits = editsOf(doc);
  edits.push([record]);
  if (edits.length > MAX_EDIT_RECORDS) edits.delete(0, edits.length - MAX_EDIT_RECORDS);
}

export function encodeRelative(position: Y.RelativePosition): string {
  return toBase64(Y.encodeRelativePosition(position));
}

export function decodeRelative(value: string): Y.RelativePosition {
  return Y.decodeRelativePosition(fromBase64(value));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Paths are relative, POSIX, NFC, and never escape the root. */
export function normalizeSharedPath(value: string): string | null {
  if (typeof value !== 'string' || !value || value.length > 1_024) return null;
  const path = value.normalize('NFC').replaceAll('\\', '/');
  if (path.startsWith('/') || /^[a-z]:/iu.test(path) || path.includes('\0')) return null;
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return parts.join('/');
}
