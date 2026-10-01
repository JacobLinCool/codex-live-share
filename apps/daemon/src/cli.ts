#!/usr/bin/env node
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RpcError, callDaemon, requireDaemon, resolveFolder, spawnDaemon } from './client';
import { CONFIG_PATH, folderKey, loadConfig, saveConfig } from './config';
import { Daemon, DaemonError, parseInvite } from './daemon';
import { runHook } from './hooks';
import { install } from './install';
import { findRunEntry } from './registry';
import { runMcpServer } from './mcp';
import { createDaemonServer } from './server';

const VERSION = '0.1.0';
const cliPath = fileURLToPath(import.meta.url);
const here = dirname(cliPath);

const USAGE = `codex-live-share ${VERSION}

Usage:
  codex-live-share install [--source REPO_OR_PATH]   add the Codex plugin (default: GitHub marketplace)
  codex-live-share start [FOLDER] [--hosted]   share a folder (direct mode unless --hosted)
  codex-live-share join INVITE [FOLDER]        join into an empty folder (invite link, or a hosted room code)
  codex-live-share admit [NAME] [FOLDER] [--view|--deny]
  codex-live-share status [FOLDER]
  codex-live-share end [FOLDER]
  codex-live-share mcp                     stdio MCP server (used by the Codex plugin)
  codex-live-share hook EVENT              Codex hook handler (used by the Codex plugin)
`;

async function main(): Promise<void> {
  const [command = 'help', ...rest] = process.argv.slice(2);
  switch (command) {
    case 'serve':
      return serve(rest);
    case 'mcp':
      return runMcpServer(cliPath);
    case 'hook':
      return runHook(rest[0] ?? '');
    case 'install': {
      const { values } = parseArgs({ args: rest, options: { source: { type: 'string' } } });
      return install(values.source);
    }
    case 'start': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { hosted: { type: 'boolean' } } });
      const folder = resolveFolder(positionals[0]);
      const entry = await spawnDaemon(cliPath, folder, { host: values.hosted ? 'hosted' : 'direct' });
      return printStatus(await callDaemon(entry, 'status'));
    }
    case 'join': {
      const invite = parseInvite(rest[0] ?? '', loadConfig().hostedSignalUrl);
      if (!invite) throw new RpcError('INVALID_INVITE', 'Usage: codex-live-share join INVITE [FOLDER]');
      const folder = resolveFolder(rest[1]);
      const existing = findRunEntry(folder);
      if (existing) return printStatus(await callDaemon(existing, 'retarget', { signalUrl: invite.signalUrl }));
      const entry = await spawnDaemon(cliPath, folder, { join: rest[0]! });
      return printStatus(await callDaemon(entry, 'status'));
    }
    case 'admit': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { view: { type: 'boolean' }, deny: { type: 'boolean' } } });
      const access = values.deny ? 'deny' : values.view ? 'view' : 'edit';
      return printStatus(await callDaemon(requireDaemon(resolveFolder(positionals[1])), 'admit', { who: positionals[0] ?? '', access }));
    }
    case 'status':
      return printStatus(await callDaemon(requireDaemon(resolveFolder(rest[0])), 'status'));
    case 'end':
      return printStatus(await callDaemon(requireDaemon(resolveFolder(rest[0])), 'end', {}, 20_000));
    case '--version':
    case 'version':
      console.log(VERSION);
      return;
    default:
      process.stdout.write(USAGE);
  }
}

async function serve(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { folder: { type: 'string' }, host: { type: 'string' }, join: { type: 'string' }, 'ready-file': { type: 'string' } },
  });
  const ready = (result: Record<string, unknown>) => {
    if (values['ready-file']) writeFileSync(values['ready-file'], JSON.stringify(result), { mode: 0o600 });
  };
  const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
  try {
    const folder = realpathSync(values.folder ?? process.cwd());
    const config = loadConfig();
    // Persist first-run defaults (name, color) so they stay stable across sessions.
    if (!existsSync(CONFIG_PATH)) saveConfig(config);
    const invite = values.join ? parseInvite(values.join, config.hostedSignalUrl) : null;
    if (values.join && !invite) throw new DaemonError('INVALID_INVITE', `Not a live share invite: ${values.join}`);
    const mode = values.host === 'hosted' ? 'hosted' : values.host === 'direct' ? 'direct' : config.defaultMode;
    const daemon = new Daemon({ folder, role: invite ? 'guest' : 'host', invite, mode, config, log });
    const server = createDaemonServer(daemon, resource('web'));
    daemon.port = await listen(server, preferredPort(folder));
    daemon.onStop = () => {
      server.close();
      setTimeout(() => process.exit(0), 200).unref();
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void daemon.stop(signal));
    await daemon.start();
    log(`Sharing ${folder} as ${daemon.role} (${daemon.mode}) in room ${daemon.code}; invite ${daemon.inviteUrl ?? '(pending)'}; UI at ${daemon.uiUrl}`);
    ready({ ok: true, port: daemon.port });
  } catch (error) {
    const code = error instanceof DaemonError ? error.code : 'START_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    log(`Failed to start: ${code} ${message}`);
    ready({ ok: false, code, message });
    process.exit(1);
  }
}

/** A stable port per folder keeps the browser's site permissions (e.g. microphone) across restarts. */
function preferredPort(folder: string): number {
  return 47_000 + (Number.parseInt(folderKey(folder).slice(0, 6), 16) % 1_000);
}

async function listen(server: ReturnType<typeof createDaemonServer>, port: number): Promise<number> {
  for (const candidate of [port, 0]) {
    const free = candidate === 0 || (await isFree(candidate));
    if (!free) continue;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(candidate, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address && typeof address === 'object') return address.port;
  }
  throw new Error('Could not open a local port.');
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** The web UI sits next to dist/cli.js in the plugin; in the repo it is apps/web/dist. */
function resource(name: 'web'): string {
  const bundled = join(here, name);
  return existsSync(bundled) ? bundled : join(here, '..', '..', 'web', 'dist');
}

function printStatus(status: unknown): void {
  console.log(JSON.stringify(status, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof RpcError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));
  process.exit(1);
});
