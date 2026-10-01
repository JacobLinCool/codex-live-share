import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, folderKey } from './config';
import { findRunEntry, type RunEntry } from './registry';

export class RpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function callDaemon<T = unknown>(entry: RunEntry, method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${entry.port}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${entry.token}` },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await response.json()) as { ok: boolean; result?: T; code?: string; message?: string };
  if (!body.ok) throw new RpcError(body.code ?? 'FAILED', body.message ?? `${method} failed`);
  return body.result as T;
}

export function resolveFolder(folder: unknown): string {
  const raw = typeof folder === 'string' && folder.trim() ? folder.trim() : process.env['CODEX_LIVE_SHARE_FOLDER'] ?? process.cwd();
  try {
    return realpathSync(raw);
  } catch {
    throw new RpcError('NO_FOLDER', `Folder ${raw} does not exist.`);
  }
}

export function requireDaemon(folder: string): RunEntry {
  const entry = findRunEntry(folder);
  if (!entry) {
    throw new RpcError('NOT_SHARED', `${folder} is not in a live share session. Start one with live_share_start, or join with live_share_join.`);
  }
  return entry;
}

export interface StartResult {
  ok: boolean;
  code?: string;
  message?: string;
}

/** Starts a detached daemon for `folder` and waits until it is serving or has failed. */
export async function spawnDaemon(cliPath: string, folder: string, role: { host: 'direct' | 'hosted' } | { join: string }): Promise<RunEntry> {
  const logs = join(HOME, 'logs');
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const key = folderKey(folder);
  const readyFile = join(logs, `${key}.ready.json`);
  rmSync(readyFile, { force: true });
  const log = openSync(join(logs, `${key}.log`), 'a', 0o600);
  const args = [cliPath, 'serve', '--folder', folder, '--ready-file', readyFile, ...('host' in role ? ['--host', role.host] : ['--join', role.join])];
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  // Direct mode may download cloudflared and wait for a tunnel on first use.
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    let ready: StartResult | null = null;
    try {
      ready = JSON.parse(readFileSync(readyFile, 'utf8')) as StartResult;
    } catch {
      // Not yet written.
    }
    if (ready) {
      if (!ready.ok) throw new RpcError(ready.code ?? 'START_FAILED', ready.message ?? 'The live share daemon failed to start.');
      const entry = findRunEntry(folder);
      if (entry) return entry;
    }
    if (child.exitCode !== null) break;
  }
  throw new RpcError('START_FAILED', `The live share daemon did not start; see ${join(logs, `${key}.log`)}.`);
}
