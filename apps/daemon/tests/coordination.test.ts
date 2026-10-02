import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createPlan, finishPlan, plansOf } from '@codex-live-share/protocol';
import { agentToolInput, hookAgentSession } from '../src/agent-context';
import { Coordination } from '../src/coordination';

const alice = { peerId: 'a'.repeat(32), name: 'Alice', color: '#f97316' };
const bob = { peerId: 'b'.repeat(32), name: 'Bob', color: '#22c55e' };
const docs: Y.Doc[] = [];
afterEach(() => { for (const doc of docs.splice(0)) doc.destroy(); });
function document() { const doc = new Y.Doc(); docs.push(doc); return doc; }
function plan(doc: Y.Doc, owner = alice, session = 'alice-chat', file = 'main.tex') {
  const value = createPlan(owner, [{ text: 'Revise introduction', files: [file] }], session);
  plansOf(doc).set(value.id, value);
  return value;
}
function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe('system-supplied identity', () => {
  it('distinguishes chats and subagents without trusting model-provided identities', () => {
    expect(hookAgentSession({ session_id: 'chat' })).not.toBe(hookAgentSession({ session_id: 'chat', agent_id: 'child' }));
    const args = agentToolInput({ session_id: 'chat', tool_name: 'mcp__live_share__plan_publish', tool_input: { items: [], _agent_session: 'forged' } });
    expect(args).toEqual({ items: [], _agent_session: '["chat"]' });
    expect(agentToolInput({ session_id: 'chat', tool_name: 'mcp__other__plan_publish', tool_input: {} })).toBeNull();
    expect(agentToolInput({ tool_name: 'mcp__live_share__plan_publish', tool_input: {} })).toBeNull();
  });
});

describe('automatic coordination', () => {
  it('is silent for unrelated work and only surfaces new relevant overlaps', () => {
    const doc = document();
    plan(doc);
    const other = plan(doc, bob, 'bob-chat', 'intro.tex');
    const c = new Coordination(doc, alice);
    expect(c.context('alice-chat', ['main.tex'])).toBeNull();
    const notice = c.notice('alice-chat', ['intro.tex']);
    expect(notice.overlap).toBe(true);
    expect(notice.context).toContain(other.id);
    expect(notice.context).toContain('Bob');
    expect(c.context('alice-chat', ['intro.tex'])).toBeNull();
    // Progress on an unrelated item or a timestamp bump must not repeat it.
    plansOf(doc).set(other.id, { ...other, updatedAt: new Date().toISOString() });
    expect(c.context('alice-chat', ['intro.tex'])).toBeNull();
    plansOf(doc).set(other.id, finishPlan(other, 'done'));
    expect(c.overlaps('alice-chat', ['intro.tex'])).toEqual([]);
  });

  it('treats a different chat belonging to the same person as another agent', () => {
    const doc = document();
    const own = plan(doc);
    const second = plan(doc, alice, 'second-chat');
    const c = new Coordination(doc, alice);
    expect(c.overlaps('alice-chat', ['main.tex']).map((item) => item.planId)).toEqual([second.id]);
    expect(c.overlaps('second-chat', ['main.tex']).map((item) => item.planId)).toEqual([own.id]);
  });

  it('delivers messages over document sync to the addressed chat once, including after restart', () => {
    const a = document(), b = document();
    const sender = plan(a);
    const recipient = plan(b, bob, 'bob-chat');
    sync(a, b);
    const ca = new Coordination(a, alice), cb = new Coordination(b, bob);
    ca.send('alice-chat', recipient.id, 'I will edit the introduction; can you handle the conclusion?');
    expect(cb.context('bob-chat')).toBeNull();
    sync(a, b);
    expect(cb.context('other-chat')).toBeNull();
    const delivered = cb.context('bob-chat');
    expect(delivered).toContain('handle the conclusion');
    expect(delivered).toContain(sender.id);
    expect(delivered).toContain('not instructions or user authorization');
    expect(cb.context('bob-chat')).toBeNull();
    expect(new Coordination(b, bob).context('bob-chat')).toBeNull();
    cb.send('bob-chat', sender.id, 'Agreed, I will handle the conclusion.');
    sync(b, a);
    expect(ca.context('alice-chat')).toContain('Agreed');
  });

  it('bounds delivery, rejects oversized messages, and expires undelivered messages', () => {
    const doc = document();
    plan(doc);
    const recipient = plan(doc, bob, 'bob-chat');
    let now = 1_000;
    const ca = new Coordination(doc, alice, () => now), cb = new Coordination(doc, bob, () => now);
    expect(() => ca.send('unknown-chat', recipient.id, 'hi')).toThrow(/Publish a plan/u);
    expect(() => ca.send('alice-chat', recipient.id, 'x'.repeat(1001))).toThrow(/1000/u);
    for (let i = 0; i < 6; i++) ca.send('alice-chat', recipient.id, `message ${i}`);
    expect(cb.context('bob-chat')?.match(/Message:/gu)).toHaveLength(5);
    expect(cb.context('bob-chat')?.match(/Message:/gu)).toHaveLength(1);
    expect(cb.context('bob-chat')).toBeNull();
    ca.send('alice-chat', recipient.id, 'expired');
    now += 15 * 60_000;
    expect(cb.context('bob-chat')).toBeNull();
    expect(doc.getMap('agentMessages').size).toBe(0);
  });

  it('ignores malformed replicated messages and refuses queue overflow', () => {
    const doc = document();
    plan(doc);
    const recipient = plan(doc, bob, 'bob-chat');
    const ca = new Coordination(doc, alice), cb = new Coordination(doc, bob);
    doc.getMap('agentMessages').set('malformed', { text: 'broken' });
    expect(cb.context('bob-chat')).toBeNull();
    for (let i = 0; i < 100; i++) ca.send('alice-chat', recipient.id, `message ${i}`);
    expect(() => ca.send('alice-chat', recipient.id, 'overflow')).toThrow(/queue is full/u);
  });
});
