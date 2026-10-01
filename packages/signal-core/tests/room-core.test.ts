import { describe, expect, it } from 'vitest';
import { createPeerId, createSecret, type SignalServerMessage } from '@codex-live-share/protocol';
import { MemoryStorage, RoomCore, type Accept, type Attachment, type ConnectParams, type RoomRuntime, type RoomSocket } from '../src';

class FakeSocket implements RoomSocket {
  inbox: SignalServerMessage[] = [];
  closedWith: number | null = null;
  #attachment: Attachment | null;
  constructor(attachment: Attachment, readonly sockets: FakeSocket[]) {
    this.#attachment = attachment;
  }
  send(text: string) {
    this.inbox.push(JSON.parse(text) as SignalServerMessage);
  }
  close(code: number) {
    this.closedWith = code;
    const index = this.sockets.indexOf(this);
    if (index >= 0) this.sockets.splice(index, 1);
  }
  getAttachment() {
    return this.#attachment;
  }
  setAttachment(value: Attachment | null) {
    this.#attachment = value;
  }
  last(type: SignalServerMessage['type']) {
    return this.inbox.filter((message) => message.type === type).at(-1);
  }
}

function room() {
  const sockets: FakeSocket[] = [];
  const runtime: RoomRuntime = { storage: new MemoryStorage(), sockets: () => sockets };
  const accept: Accept = (attachment) => {
    const socket = new FakeSocket(attachment, sockets);
    sockets.push(socket);
    return socket;
  };
  const core = new RoomCore(runtime);
  return { core: { connect: (params: ConnectParams) => core.connect(params, accept), message: core.message.bind(core), closed: core.closed.bind(core) }, sockets };
}

function person(name: string) {
  return { peerId: createPeerId(), name, color: '#3b82f6', secret: createSecret() };
}

async function connect(core: ReturnType<typeof room>['core'], who: ReturnType<typeof person>, action: 'create' | 'join') {
  const result = await core.connect({ code: 'K7QF2M', action, ...who });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.socket as FakeSocket;
}

describe('RoomCore', () => {
  it('lets the host admit a knocking guest and relays signals between them', async () => {
    const { core } = room();
    const alice = person('Alice');
    const bob = person('Bob');
    const host = await connect(core, alice, 'create');
    expect(host.last('welcome')).toMatchObject({ self: { name: 'Alice', isHost: true }, peers: [] });

    const guest = await connect(core, bob, 'join');
    expect(guest.last('waiting')).toBeTruthy();
    expect(host.last('knock')).toMatchObject({ peer: { peerId: bob.peerId, name: 'Bob' } });

    // A knocking guest cannot signal yet.
    await core.message(guest, JSON.stringify({ type: 'signal', target: alice.peerId, payload: { kind: 'candidate', candidate: 'x', mid: '0' } }));
    expect(host.last('signal')).toBeUndefined();

    await core.message(host, JSON.stringify({ type: 'admit', peerId: bob.peerId, access: 'view' }));
    expect(guest.last('welcome')).toMatchObject({ self: { name: 'Bob', access: 'view' }, peers: [{ name: 'Alice' }] });
    expect(host.last('peer-joined')).toMatchObject({ peer: { peerId: bob.peerId } });

    await core.message(guest, JSON.stringify({ type: 'signal', target: alice.peerId, payload: { kind: 'candidate', candidate: 'c', mid: '0' } }));
    expect(host.last('signal')).toMatchObject({ from: bob.peerId, payload: { candidate: 'c' } });
  });

  it('denies, rejects strangers, and lets admitted peers reconnect without knocking', async () => {
    const { core, sockets } = room();
    const alice = person('Alice');
    const bob = person('Bob');
    const eve = person('Eve');
    const host = await connect(core, alice, 'create');

    const intruder = await connect(core, eve, 'join');
    await core.message(host, JSON.stringify({ type: 'deny', peerId: eve.peerId }));
    expect(intruder.last('denied')).toBeTruthy();
    expect(intruder.closedWith).toBe(4003);

    const guest = await connect(core, bob, 'join');
    await core.message(host, JSON.stringify({ type: 'admit', peerId: bob.peerId, access: 'edit' }));
    // Same peer id with a wrong secret is refused.
    expect(await core.connect({ code: 'K7QF2M', action: 'join', ...bob, secret: createSecret() })).toMatchObject({ ok: false, code: 'INVALID_SECRET' });
    // The right secret replaces the old socket and is welcomed directly.
    const again = await connect(core, bob, 'join');
    expect(guest.closedWith).toBe(4001);
    expect(again.last('welcome')).toBeTruthy();
    expect(sockets).toHaveLength(2);
  });

  it('only the host can end, and an ended or missing room refuses joins', async () => {
    const { core } = room();
    const alice = person('Alice');
    const bob = person('Bob');
    expect(await core.connect({ code: 'K7QF2M', action: 'join', ...bob })).toMatchObject({ ok: false, code: 'ROOM_NOT_FOUND' });
    const host = await connect(core, alice, 'create');
    const guest = await connect(core, bob, 'join');
    await core.message(host, JSON.stringify({ type: 'admit', peerId: bob.peerId, access: 'edit' }));
    await core.message(guest, JSON.stringify({ type: 'end' }));
    expect(guest.last('error')).toMatchObject({ code: 'NOT_HOST' });
    await core.message(host, JSON.stringify({ type: 'end' }));
    expect(guest.last('ended')).toBeTruthy();
    expect(await core.connect({ code: 'K7QF2M', action: 'join', ...person('Carol') })).toMatchObject({ ok: false, code: 'ROOM_ENDED' });
  });

  it('refuses knocks while the host is offline and reports departures', async () => {
    const { core } = room();
    const alice = person('Alice');
    const bob = person('Bob');
    const host = await connect(core, alice, 'create');
    const guest = await connect(core, bob, 'join');
    await core.message(host, JSON.stringify({ type: 'admit', peerId: bob.peerId, access: 'edit' }));
    expect(await core.closed(host)).toBe(false);
    host.close(1000);
    expect(guest.last('peer-left')).toMatchObject({ peerId: alice.peerId });
    expect(await core.connect({ code: 'K7QF2M', action: 'join', ...person('Carol') })).toMatchObject({ ok: false, code: 'HOST_OFFLINE' });
    expect(await core.closed(guest)).toBe(true);
  });
});
