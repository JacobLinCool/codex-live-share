import { describe, expect, it } from 'vitest';
import { isTunnelUrl, parseInvite } from '../src/daemon';
import { assetFor, parseTunnelUrl, verifyDigest } from '../src/tunnel';

describe('cloudflared quick tunnel', () => {
  it('finds the public URL in cloudflared output', () => {
    const banner = '2026-10-02T05:00:00Z INF |  https://lately-quiet-river-ocean.trycloudflare.com                          |';
    expect(parseTunnelUrl(banner)).toBe('https://lately-quiet-river-ocean.trycloudflare.com');
    expect(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
  });

  it('pins a verified build for every supported platform except Intel macOS', () => {
    for (const [platform, arch] of [['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['win32', 'arm64']] as const) {
      expect(assetFor(platform, arch)?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(assetFor('darwin', 'x64')).toBeNull();
    expect(verifyDigest(new TextEncoder().encode('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')).toBe(true);
    expect(verifyDigest(new TextEncoder().encode('abd'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')).toBe(false);
  });
});

describe('invites', () => {
  const hosted = 'https://codex-live-share.example.workers.dev';

  it('reads direct and hosted links, and bare codes for hosted rooms', () => {
    expect(parseInvite('https://a-b-c.trycloudflare.com/j/k7qf2m', hosted)).toEqual({ code: 'K7QF2M', signalUrl: 'https://a-b-c.trycloudflare.com' });
    expect(parseInvite(`${hosted}/j/K7QF2M/`, hosted)).toEqual({ code: 'K7QF2M', signalUrl: hosted });
    expect(parseInvite(' K7QF2M ', hosted)).toEqual({ code: 'K7QF2M', signalUrl: hosted });
    expect(parseInvite('http://evil.example/j/K7QF2M', hosted)).toBeNull();
    expect(parseInvite('https://a.trycloudflare.com/other', hosted)).toBeNull();
    expect(isTunnelUrl('https://a-b.trycloudflare.com')).toBe(true);
    expect(isTunnelUrl('https://trycloudflare.com.evil.example')).toBe(false);
  });
});
