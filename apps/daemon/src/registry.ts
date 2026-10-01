import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { RUN_DIR, folderKey, writePrivateJson } from './config';

/** One file per running daemon, so the MCP server and hooks can find it by folder. */
export interface RunEntry {
  folder: string;
  pid: number;
  port: number;
  token: string;
  code: string | null;
  role: 'host' | 'guest';
  startedAt: string;
}

export function runPath(folder: string): string {
  return join(RUN_DIR, `${folderKey(folder)}.json`);
}

export function writeRunEntry(entry: RunEntry): void {
  writePrivateJson(runPath(entry.folder), entry);
}

export function removeRunEntry(folder: string): void {
  rmSync(runPath(folder), { force: true });
}

export function readRunEntries(): RunEntry[] {
  let names: string[];
  try {
    names = readdirSync(RUN_DIR);
  } catch {
    return [];
  }
  const entries: RunEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(readFileSync(join(RUN_DIR, name), 'utf8')) as RunEntry;
      if (isAlive(entry.pid)) entries.push(entry);
      else rmSync(join(RUN_DIR, name), { force: true });
    } catch {
      // Partially written or foreign file.
    }
  }
  return entries;
}

/** The daemon sharing `path` itself or one of its ancestors. */
export function findRunEntry(path: string): RunEntry | null {
  let best: RunEntry | null = null;
  for (const entry of readRunEntries()) {
    if (path === entry.folder || path.startsWith(`${entry.folder}${sep}`)) {
      if (!best || entry.folder.length > best.folder.length) best = entry;
    }
  }
  return best;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
