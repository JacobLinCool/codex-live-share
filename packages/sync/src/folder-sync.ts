import { createHash, randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import * as Y from 'yjs';
import {
  blobsOf,
  encodeRelative,
  filesOf,
  isBlobRef,
  normalizeSharedPath,
  type FileValue,
} from '@codex-live-share/protocol';
import { IGNORE_FILES, IgnoreRules } from './ignore-rules';
import { mergeIntoText, type InsertedRange } from './text-merge';

export const DEFAULT_MAX_FILE_BYTES = 5 * 1_024 * 1_024;
const SETTLE_MS = 30;

type DiskState =
  | { kind: 'missing' }
  | { kind: 'text'; hash: string; text: string }
  | { kind: 'blob'; hash: string; bytes: Uint8Array }
  | { kind: 'skipped'; reason: 'too-large' | 'symlink' | 'not-a-file' };

interface Base {
  hash: string;
  text: string | null;
}

export interface LocalTextEdit {
  path: string;
  ranges: Array<[string, string]>;
}

export interface FolderSyncOptions {
  /** Absolute path of the shared folder. */
  root: string;
  doc: Y.Doc;
  /** View-only peers never publish disk changes; local edits are reverted. */
  readOnly?: () => boolean;
  /** Called after a local disk edit (an agent or a local editor) changes a text file. */
  onLocalEdit?: (edit: LocalTextEdit) => void;
  onWarning?: (message: string) => void;
  maxFileBytes?: number;
}

/**
 * Keeps a folder and the shared Y.Doc equal.
 *
 * Every path converges through one idempotent step, `#syncPath`: fold any disk
 * change since the last sync into the doc (a three-way text merge), then write
 * the doc's value back to disk if they differ. Watcher events, remote doc
 * updates, and our own writes all funnel into that step, so echoes of our own
 * writes are no-ops and a concurrent agent edit is merged instead of clobbered.
 */
export class FolderSync {
  readonly origin = Symbol('folder-sync');
  readonly #root: string;
  readonly #doc: Y.Doc;
  readonly #files: Y.Map<FileValue>;
  readonly #blobs: Y.Map<Uint8Array>;
  readonly #rules: IgnoreRules;
  readonly #options: FolderSyncOptions;
  readonly #maxBytes: number;
  readonly #bases = new Map<string, Base>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #realRoot = '';
  #watcher: FSWatcher | null = null;
  #stopped = false;
  #reconciling = false;

  constructor(options: FolderSyncOptions) {
    this.#options = options;
    this.#root = options.root;
    this.#doc = options.doc;
    this.#files = filesOf(options.doc);
    this.#blobs = blobsOf(options.doc);
    this.#rules = new IgnoreRules(options.root);
    this.#maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /**
   * Initial reconciliation.
   * - 'disk': the folder is the truth (a host sharing, or any peer restarting
   *   with persisted state). Disk content is merged over the doc; doc-only
   *   paths were deleted while offline.
   * - 'doc': the doc is the truth (a guest mirroring into an empty folder).
   */
  async reconcile(mode: 'disk' | 'doc'): Promise<void> {
    this.#realRoot = await realpath(this.#root);
    const onDisk = await this.scan();
    if (mode === 'disk') {
      for (const [path, value] of this.#files) {
        if (value instanceof Y.Text) this.#bases.set(path, { hash: sha256(value.toString()), text: value.toString() });
        else if (isBlobRef(value)) this.#bases.set(path, { hash: value.hash, text: null });
      }
      for (const path of [...this.#files.keys()]) {
        if (!onDisk.has(path)) {
          this.#bases.delete(path);
          this.#doc.transact(() => this.#deleteFromDoc(path), this.origin);
        }
      }
    } else {
      for (const path of onDisk) {
        const disk = await this.#read(path);
        if (disk.kind === 'text' || disk.kind === 'blob') {
          this.#bases.set(path, { hash: disk.hash, text: disk.kind === 'text' ? disk.text : null });
        }
      }
    }
    const paths = new Set([...onDisk, ...this.#files.keys()]);
    this.#reconciling = true;
    try {
      await Promise.all([...paths].map((path) => this.#enqueue(path)));
    } finally {
      this.#reconciling = false;
    }
  }

  /** Starts watching disk and doc. Call after `reconcile`. */
  async start(): Promise<void> {
    this.#files.observeDeep(this.#onFilesChanged);
    this.#blobs.observe(this.#onBlobsChanged);
    this.#watcher = watch(this.#root, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (absolute, stats) => {
        const path = this.#relative(absolute);
        if (path === null) return false;
        if (path === '') return false;
        if (!stats) return this.isIgnored(path) || this.isIgnored(`${path}/`);
        return this.isIgnored(stats.isDirectory() ? `${path}/` : path);
      },
    });
    const onPath = (absolute: string) => {
      const path = this.#relative(absolute);
      if (!path) return;
      if (IGNORE_FILES.includes(path)) this.#rules.reload();
      this.#schedule(path);
    };
    this.#watcher.on('add', onPath).on('change', onPath).on('unlink', onPath);
    this.#watcher.on('unlinkDir', (absolute) => {
      const prefix = this.#relative(absolute);
      if (!prefix) return;
      for (const path of this.#files.keys()) if (path.startsWith(`${prefix}/`)) this.#schedule(path);
    });
    this.#watcher.on('error', (error) => this.#warn(`Watcher error: ${String(error)}`));
    await new Promise<void>((resolve) => this.#watcher?.once('ready', () => resolve()));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#files.unobserveDeep(this.#onFilesChanged);
    this.#blobs.unobserve(this.#onBlobsChanged);
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    await this.#watcher?.close();
    await this.flush();
  }

  /** Resolves once all queued path syncs have finished. */
  async flush(): Promise<void> {
    while (this.#timers.size || this.#queues.size) {
      for (const [path, timer] of this.#timers) {
        clearTimeout(timer);
        this.#timers.delete(path);
        void this.#enqueue(path);
      }
      await Promise.all([...this.#queues.values()]);
    }
  }

  /** Requests a sync of one path, e.g. after a hook reports an edit. */
  touch(path: string): void {
    const normalized = normalizeSharedPath(path);
    if (normalized) this.#schedule(normalized);
  }

  isIgnored(path: string): boolean {
    if (this.#rules.ignores(path)) return true;
    // A PDF next to a same-named .tex is a build product; each peer compiles its own.
    if (path.toLowerCase().endsWith('.pdf')) {
      const tex = `${path.slice(0, -4)}.tex`;
      if (this.#files.has(tex) || this.#bases.has(tex)) return true;
    }
    return false;
  }

  /** Relative paths of shareable regular files on disk. */
  async scan(): Promise<Set<string>> {
    const found = new Set<string>();
    const walk = async (directory: string, prefix: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = normalizeSharedPath(prefix ? `${prefix}/${entry.name}` : entry.name);
        if (!path) continue;
        if (entry.isDirectory()) {
          if (!this.isIgnored(`${path}/`)) await walk(join(directory, entry.name), path);
        } else if (entry.isFile() && !this.isIgnored(path)) {
          found.add(path);
        }
      }
    };
    await walk(this.#root, '');
    for (const path of found) {
      if (path.toLowerCase().endsWith('.pdf') && found.has(`${path.slice(0, -4)}.tex`)) found.delete(path);
    }
    return found;
  }

  readonly #onFilesChanged = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, transaction: Y.Transaction) => {
    if (transaction.origin === this.origin) return;
    for (const event of events) {
      if (event.target === this.#files) {
        for (const key of event.changes.keys.keys()) this.#schedule(key);
      } else {
        const key = event.path[0];
        if (typeof key === 'string') this.#schedule(key);
      }
    }
  };

  readonly #onBlobsChanged = (event: Y.YMapEvent<Uint8Array>) => {
    const arrived = new Set([...event.keysChanged].filter((hash) => this.#blobs.has(hash)));
    if (!arrived.size) return;
    for (const [path, value] of this.#files) {
      if (isBlobRef(value) && arrived.has(value.hash)) this.#schedule(path);
    }
  };

  #schedule(path: string): void {
    if (this.#stopped) return;
    const normalized = normalizeSharedPath(path);
    if (!normalized) return;
    clearTimeout(this.#timers.get(normalized));
    this.#timers.set(normalized, setTimeout(() => {
      this.#timers.delete(normalized);
      void this.#enqueue(normalized);
    }, SETTLE_MS));
  }

  #enqueue(path: string): Promise<void> {
    const previous = this.#queues.get(path) ?? Promise.resolve();
    const next = previous
      .then(() => this.#syncPath(path))
      .catch((error: unknown) => this.#warn(`Could not sync ${path}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (this.#queues.get(path) === next) this.#queues.delete(path);
      });
    this.#queues.set(path, next);
    return next;
  }

  async #syncPath(path: string, attempt = 0): Promise<void> {
    const ignored = this.isIgnored(path);
    const disk = ignored ? ({ kind: 'missing' } as const) : await this.#read(path);
    if (disk.kind === 'skipped') {
      if (disk.reason === 'too-large') this.#warn(`${path} is larger than ${Math.round(this.#maxBytes / 1_048_576)} MB and is not shared.`);
      return;
    }
    const base = this.#bases.get(path);
    const diskHash = disk.kind === 'missing' ? null : disk.hash;
    const readOnly = this.#options.readOnly?.() ?? false;

    // 1. Fold a local disk change into the doc.
    if (!ignored && diskHash !== (base?.hash ?? null) && !readOnly) {
      let inserted: InsertedRange[] = [];
      this.#doc.transact(() => {
        if (disk.kind === 'missing') {
          this.#deleteFromDoc(path);
        } else if (disk.kind === 'text') {
          const current = this.#files.get(path);
          if (current instanceof Y.Text) {
            inserted = mergeIntoText(current, base?.text ?? current.toString(), disk.text);
          } else {
            this.#releaseBlob(current, path);
            const text = new Y.Text();
            this.#files.set(path, text);
            text.insert(0, disk.text);
            if (disk.text) inserted = [{ start: Y.createRelativePositionFromTypeIndex(text, 0, 0), end: Y.createRelativePositionFromTypeIndex(text, disk.text.length, -1) }];
          }
        } else {
          const current = this.#files.get(path);
          if (!isBlobRef(current) || current.hash !== disk.hash) {
            if (!this.#blobs.has(disk.hash)) this.#blobs.set(disk.hash, disk.bytes);
            this.#files.set(path, { kind: 'blob', hash: disk.hash, size: disk.bytes.byteLength });
            this.#releaseBlob(current, path);
          }
        }
      }, this.origin);
      if (disk.kind === 'missing') this.#bases.delete(path);
      else this.#bases.set(path, { hash: disk.hash, text: disk.kind === 'text' ? disk.text : null });
      if (inserted.length && !this.#reconciling) {
        this.#options.onLocalEdit?.({
          path,
          ranges: inserted.slice(0, 32).map((range) => [encodeRelative(range.start), encodeRelative(range.end)]),
        });
      }
    } else if (readOnly && diskHash !== (base?.hash ?? null)) {
      this.#warn(`${path} changed locally, but this session is view-only; restoring the shared version.`);
    }

    // 2. Make the disk match the doc.
    const wanted = ignored ? undefined : this.#files.get(path);
    if (wanted === undefined) {
      if (disk.kind !== 'missing' && !ignored) {
        if (!(await this.#unchangedSince(path, disk.hash))) return this.#retry(path, attempt);
        await unlink(join(this.#root, path)).catch(() => {});
      }
      this.#bases.delete(path);
      return;
    }
    if (wanted instanceof Y.Text) {
      const text = wanted.toString();
      if (disk.kind === 'text' && disk.text === text) {
        this.#bases.set(path, { hash: disk.hash, text });
        return;
      }
      if (!(await this.#unchangedSince(path, diskHash))) return this.#retry(path, attempt);
      await this.#write(path, text);
      this.#bases.set(path, { hash: sha256(text), text });
      return;
    }
    if (isBlobRef(wanted)) {
      if (diskHash === wanted.hash) {
        this.#bases.set(path, { hash: wanted.hash, text: null });
        return;
      }
      const bytes = this.#blobs.get(wanted.hash);
      if (!bytes) return; // Arrives later; the blobs observer reschedules this path.
      if (!(await this.#unchangedSince(path, diskHash))) return this.#retry(path, attempt);
      await this.#write(path, bytes);
      this.#bases.set(path, { hash: wanted.hash, text: null });
    }
  }

  /** The file changed between our read and our write: start over so the change is merged. */
  async #retry(path: string, attempt: number): Promise<void> {
    if (attempt >= 5) {
      this.#warn(`${path} keeps changing; will retry on the next change.`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    await this.#syncPath(path, attempt + 1);
  }

  async #unchangedSince(path: string, hash: string | null): Promise<boolean> {
    const now = await this.#read(path);
    return (now.kind === 'text' || now.kind === 'blob' ? now.hash : null) === hash;
  }

  #deleteFromDoc(path: string): void {
    const current = this.#files.get(path);
    if (current === undefined) return;
    this.#files.delete(path);
    this.#releaseBlob(current, path);
  }

  /** Drops blob bytes once no path references them. */
  #releaseBlob(value: FileValue | undefined, exceptPath: string): void {
    if (!isBlobRef(value)) return;
    for (const [path, other] of this.#files) {
      if (path !== exceptPath && isBlobRef(other) && other.hash === value.hash) return;
    }
    this.#blobs.delete(value.hash);
  }

  async #read(path: string): Promise<DiskState> {
    const absolute = join(this.#root, path);
    let stats;
    try {
      stats = await lstat(absolute);
    } catch {
      return { kind: 'missing' };
    }
    if (stats.isSymbolicLink()) return { kind: 'skipped', reason: 'symlink' };
    if (!stats.isFile()) return { kind: 'skipped', reason: 'not-a-file' };
    if (stats.size > this.#maxBytes) return { kind: 'skipped', reason: 'too-large' };
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(absolute));
    } catch {
      return { kind: 'missing' };
    }
    const text = decodeText(bytes);
    return text === null
      ? { kind: 'blob', hash: sha256(bytes), bytes }
      : { kind: 'text', hash: sha256(text), text };
  }

  async #write(path: string, content: string | Uint8Array): Promise<void> {
    const absolute = join(this.#root, path);
    const directory = dirname(absolute);
    await mkdir(directory, { recursive: true });
    const realDirectory = await realpath(directory);
    if (realDirectory !== this.#realRoot && !realDirectory.startsWith(`${this.#realRoot}${sep}`)) {
      throw new Error(`refusing to write outside the shared folder (${path})`);
    }
    const existing = await lstat(absolute).catch(() => null);
    if (existing?.isSymbolicLink()) throw new Error(`refusing to replace symlink ${path}`);
    const temporary = join(directory, `.${randomBytes(6).toString('hex')}.live-share.tmp`);
    await writeFile(temporary, content, existing ? { mode: existing.mode } : {});
    await rename(temporary, absolute);
  }

  #relative(absolute: string): string | null {
    const path = relative(this.#root, absolute);
    if (path === '') return '';
    if (path.startsWith('..')) return null;
    return normalizeSharedPath(path.split(sep).join('/'));
  }

  #warn(message: string): void {
    this.#options.onWarning?.(message);
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Text means valid UTF-8 without NUL bytes. */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}
