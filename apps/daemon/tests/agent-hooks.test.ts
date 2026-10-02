import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { plansOf } from '@codex-live-share/protocol';
import { hookAgentSession } from '../src/agent-context';

// Exercise the real daemon/RPC/hook policy without opening a room or a tunnel.
vi.mock('../src/share-store', () => ({ ShareStore: class {
  read() { return null; } clearDoc() {} write() {} saveDoc() {}
} }));
vi.mock('../src/registry', () => ({ writeRunEntry() {}, removeRunEntry() {} }));
vi.mock('../src/account', () => ({ hostedToken: () => 'test-token' }));
vi.mock('@codex-live-share/sync', () => ({ FolderSync: class {
  async reconcile() {} async start() {} async stop() {} touch() {}
} }));
vi.mock('../src/peer-mesh', () => ({ PeerMesh: class {
  self = { access: 'edit' }; members = []; connectedPeers = []; knocks = [];
  on() {} async start() {} close() {}
} }));

import { Daemon } from '../src/daemon';
import { rpc } from '../src/server';

const daemons: Daemon[] = [];
afterEach(async () => { for (const daemon of daemons.splice(0)) { await daemon.stop('stopped'); daemon.doc.destroy(); } });
async function daemon(name = 'Alice') {
  const d = new Daemon({ folder: `/test/${name}`, role: 'host', invite: null, mode: 'hosted', config: {
    name, nameConfirmed: true, color: '#f97316', defaultMode: 'hosted', hostedSignalUrl: 'http://localhost:1234', asr: { provider: null },
  }, log() {} });
  daemons.push(d);
  await d.start();
  return d;
}
const session = (id: string) => hookAgentSession({ session_id: id })!;
const items = [{ text: 'Revise introduction', files: ['main.tex'] }];
const patch = { tool_name: 'apply_patch', tool_input: { command: '*** Update File: main.tex' } };

describe('per-chat plans and hooks', () => {
  it('preserves parallel chats, rejects cross-chat updates, and closes only the caller plan', async () => {
    const d = await daemon();
    const first = d.publishPlan(items, session('first'));
    const second = d.publishPlan(items, session('second'));
    expect([...plansOf(d.doc).values()].filter((p) => p.status === 'active')).toHaveLength(2);
    expect(() => d.finishPlan(first.id, 'done', session('second'))).toThrow(/This chat/u);
    expect(() => d.updatePlan(first.id, 0, 'done', session('second'))).toThrow(/This chat/u);
    const replacement = d.publishPlan(items, session('first'));
    expect(plansOf(d.doc).get(first.id)?.status).toBe('abandoned');
    expect(plansOf(d.doc).get(second.id)?.status).toBe('active');
    d.finishPlan(replacement.id, 'done', session('first'));
    expect(d.hook('stop', { session_id: 'first' })).toEqual({});
    expect(d.hook('stop', { session_id: 'second' }).continueWith).toContain(second.id);
    expect(d.hook('stop', { session_id: 'second', stop_hook_active: true })).toEqual({});
    d.hook('session-end', { session_id: 'second' });
    expect(plansOf(d.doc).get(second.id)?.status).toBe('abandoned');
  });

  it('pauses only a new overlapping patch and does not force routine status calls', async () => {
    const a = await daemon(), b = await daemon('Bob');
    a.publishPlan(items, session('alice'));
    const other = b.publishPlan(items, session('bob'));
    Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
    expect(a.hook('pre-tool-use', { ...patch, session_id: 'alice' }).deny).toContain(other.id);
    expect(a.hook('pre-tool-use', { ...patch, session_id: 'alice' })).toEqual({});
    expect(a.hook('pre-tool-use', { ...patch, session_id: 'different' }).deny).toMatch(/publish a short plan/u);
    expect(a.hook('pre-tool-use', patch).deny).toMatch(/identify this chat/u);
  });

  it('delivers queued messages during ordinary hooks without adding a polling tool call', async () => {
    const d = await daemon();
    const one = d.publishPlan(items, session('one'));
    const two = d.publishPlan(items, session('two'));
    d.sendAgentMessage(session('one'), two.id, 'Please handle the figures.');
    expect(d.hook('user-prompt-submit', { session_id: 'two' }).context).toContain('handle the figures');
    expect(d.hook('pre-tool-use', { session_id: 'two', tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({});
    d.sendAgentMessage(session('two'), one.id, 'Done.');
    expect(d.hook('post-tool-use', { session_id: 'one', tool_name: 'Bash' }).context).toContain('Done.');
  });

  it('requires hook identity at the RPC boundary rather than guessing the latest active chat', async () => {
    const d = await daemon();
    await expect(rpc(d, 'plan_publish', { items })).rejects.toThrow(/identity is missing/u);
    const result = await rpc(d, 'plan_publish', { items, session: session('rpc') }) as { agentSession: string };
    expect(result.agentSession).toBe(session('rpc'));
  });
});
