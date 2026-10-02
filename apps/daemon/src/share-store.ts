import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Y from 'yjs';
import { SHARES_DIR, folderKey, writePrivateJson, type ConnectionMode } from './config';

/**
 * Per-folder state that must survive a daemon restart. Restoring the same
 * Y.Doc history matters: a fresh doc built from the same files would carry
 * different item ids, and merging it with the peers' doc would duplicate text.
 */
export interface ShareRecord {
  folder: string;
  role: 'host' | 'guest';
  code: string;
  mode: ConnectionMode;
  /** Where to signal. A guest's comes from the invite; a direct host's is its current tunnel. */
  signalUrl: string | null;
  peerId: string;
  secret: string;
  docId: string;
  /** Guards the local UI and RPC; stable so an open editor tab survives a daemon restart. */
  localToken?: string;
  createdAt: string;
  ended: boolean;
}

export class ShareStore {
  readonly directory: string;

  constructor(folder: string) {
    this.directory = join(SHARES_DIR, folderKey(folder));
  }

  read(): ShareRecord | null {
    try {
      return JSON.parse(readFileSync(join(this.directory, 'share.json'), 'utf8')) as ShareRecord;
    } catch {
      return null;
    }
  }

  write(record: ShareRecord): void {
    writePrivateJson(join(this.directory, 'share.json'), record);
  }

  loadDoc(doc: Y.Doc): boolean {
    try {
      Y.applyUpdate(doc, new Uint8Array(readFileSync(join(this.directory, 'doc.bin'))), 'restore');
      return true;
    } catch {
      return false;
    }
  }

  saveDoc(doc: Y.Doc): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'doc.bin');
    writeFileSync(`${path}.tmp`, Y.encodeStateAsUpdate(doc), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  writeTranscript(markdown: string): string {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'transcript.md');
    writeFileSync(path, markdown, { mode: 0o600 });
    return path;
  }

  get roomStatePath(): string {
    return join(this.directory, 'room.json');
  }

  get tunnelConfigPath(): string {
    return join(this.directory, 'cloudflared.yml');
  }

  clearDoc(): void {
    rmSync(join(this.directory, 'room.json'), { force: true });
    rmSync(join(this.directory, 'doc.bin'), { force: true });
  }
}
