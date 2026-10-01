import { ROOM_CODE_PATTERN } from '@codex-live-share/protocol';
import { LANDING_HEADERS, STUN_SERVERS, landingPage } from '@codex-live-share/signal-core';
import { Room } from './room';

export { Room };

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  TURN_KEY_ID?: string;
  TURN_KEY_SECRET?: string;
  /** Per-IP limits on room connections and TURN credentials. */
  CONNECT_RATE_LIMITER?: RateLimit;
  ICE_RATE_LIMITER?: RateLimit;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const connect = /^\/api\/rooms\/([A-Z0-9]{6})\/connect$/u.exec(url.pathname);
    if (connect) {
      if (!ROOM_CODE_PATTERN.test(connect[1]!)) return Response.json({ ok: false, code: 'INVALID_ROOM' }, { status: 400 });
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return Response.json({ ok: false, code: 'WEBSOCKET_REQUIRED' }, { status: 426 });
      }
      if (!(await allowed(env.CONNECT_RATE_LIMITER, request))) return Response.json({ ok: false, code: 'RATE_LIMITED' }, { status: 429 });
      return env.ROOMS.get(env.ROOMS.idFromName(connect[1]!)).fetch(request);
    }
    if (url.pathname === '/api/ice-servers' && request.method === 'POST') {
      if (!(await allowed(env.ICE_RATE_LIMITER, request))) return Response.json({ ok: false, code: 'RATE_LIMITED' }, { status: 429 });
      return iceServers(env);
    }
    const join = /^\/j\/([A-Za-z0-9]{6})\/?$/u.exec(url.pathname);
    if (join) return html(landingPage(join[1]!.toUpperCase(), url.origin));
    if (url.pathname === '/') return html(landingPage(null, url.origin));
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** TURN relays traffic between peers that cannot reach each other directly; it never sees plaintext. */
async function iceServers(env: Env): Promise<Response> {
  const keyId = env.TURN_KEY_ID?.trim();
  const keySecret = env.TURN_KEY_SECRET?.trim();
  if (keyId && keySecret) {
    try {
      const upstream = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keySecret}` },
          body: JSON.stringify({ ttl: 86_400 }),
        },
      );
      if (upstream.ok) {
        const payload = await upstream.json<{ iceServers?: unknown }>();
        if (Array.isArray(payload.iceServers)) {
          return Response.json({ ok: true, iceServers: payload.iceServers }, { headers: { 'Cache-Control': 'no-store' } });
        }
      }
    } catch {
      // Fall back to STUN; peers on the same network or with open NATs still connect.
    }
  }
  return Response.json({ ok: true, iceServers: STUN_SERVERS }, { headers: { 'Cache-Control': 'no-store' } });
}

function html(body: string): Response {
  return new Response(body, { headers: LANDING_HEADERS });
}

async function allowed(limiter: RateLimit | undefined, request: Request): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' })).success;
  } catch {
    return true;
  }
}
