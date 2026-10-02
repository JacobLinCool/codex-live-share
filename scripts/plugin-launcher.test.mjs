import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const launcher = fileURLToPath(new URL('../plugins/live-share/bin/run', import.meta.url));
const posix = { skip: process.platform === 'win32' };

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'live share launcher '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, CODEX_LIVE_SHARE_HOME: join(cwd, 'state') };
  for (const key of ['CODEX_LIVE_SHARE_NODE', 'CODEX_MCP_NODE_PATH', 'CODEX_BROWSER_USE_NODE_PATH', 'CODEX_ELECTRON_RESOURCES_PATH', 'CODEX_CLI_PATH', 'CODEX_LIVE_SHARE_FOLDER']) delete env[key];
  return { cwd, env, encoding: 'utf8', timeout: 15_000 };
}

function rejectedRuntime(cwd) {
  const path = join(cwd, 'incompatible node');
  // It is executable and reports a supported version, but cannot load addons.
  writeFileSync(path, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v24.0.0; exit 0; fi\necho "native addon rejected" >&2\nexit 17\n', { mode: 0o755 });
  return path;
}

test('MCP initializes, lists tools, and answers calls after rejecting an incompatible runtime', posix, (t) => {
  const options = fixture(t);
  options.env.CODEX_MCP_NODE_PATH = rejectedRuntime(options.cwd);
  options.env.CODEX_BROWSER_USE_NODE_PATH = process.execPath;
  const messages = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'launcher-test', version: '1' } } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'live_share_status', arguments: {} } },
    { id: 4, method: 'ping' },
  ];
  const result = spawnSync(launcher, ['mcp'], { ...options, input: messages.map((m) => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const replies = new Map(result.stdout.trim().split('\n').map((line) => { const reply = JSON.parse(line); return [reply.id, reply]; }));
  assert.equal(replies.size, 4, 'stdout must contain only MCP responses');
  assert.equal(replies.get(1).result.protocolVersion, '2025-11-25');
  assert.ok(replies.get(2).result.tools.some((tool) => tool.name === 'live_share_start'));
  assert.equal(replies.get(3).result.isError, true);
  assert.ok(replies.get(3).result.content[0].text.includes(options.cwd), 'preserve the caller workspace');
  assert.match(replies.get(3).result.content[0].text, /NOT_SHARED/);
  assert.deepEqual(replies.get(4).result, {});
});

test('an explicit incompatible runtime fails without silently selecting another', posix, (t) => {
  const options = fixture(t);
  options.env.CODEX_LIVE_SHARE_NODE = rejectedRuntime(options.cwd);
  options.env.CODEX_MCP_NODE_PATH = process.execPath;
  const result = spawnSync(launcher, ['--version'], options);
  assert.equal(result.status, 17);
  assert.match(result.stderr, /native addon rejected/);
  assert.equal(result.stdout, '');
});

test('an explicit compatible runtime runs the requested command only once on stdout', posix, (t) => {
  const options = fixture(t);
  options.env.CODEX_LIVE_SHARE_NODE = process.execPath;
  const result = spawnSync(launcher, ['--version'], options);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
});
