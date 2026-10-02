import { PEER_ID_PATTERN, ROOM_CODE_PATTERN, isRecord } from '@codex-live-share/protocol';
import { LANDING_HEADERS, LEGAL_PAGES, STUN_SERVERS, TIERS, isTierName, landingPage, legalPage } from '@codex-live-share/signal-core';
import privacy from '../../../legal/privacy.md';
import refunds from '../../../legal/refunds.md';
import terms from '../../../legal/terms.md';
import { Account } from './account';
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  accountIdOfToken,
  accountOf,
  authenticate,
  bearer,
  cookie,
  githubCodeExchange,
  githubIdOf,
  githubUser,
  mintToken,
  safeEqual,
  sessionCookie,
  sessionToken,
  setCookie,
  sha256,
  type GitHubUser,
} from './auth';
import { PAGE_HEADERS, accountPage, billingSuccessPage } from './pages';
import { Room } from './room';

export { Account, Room };

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ACCOUNTS: DurableObjectNamespace<Account>;
  /** GitHub OAuth app: device flow for the plugin, web flow (with the secret) for the site. */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Bearer token for /api/admin/*. */
  ADMIN_TOKEN?: string;
  /** "allow" accepts `dev:<login>` sign-ins from localhost (local development only). */
  DEV_AUTH?: string;
  /** With DEV_AUTH=allow: shortens time-limited sessions, to test the cutoff locally. */
  DEV_SESSION_MS?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_SECRET?: string;
  /** Per IP: room connections, sign-ins, and ICE requests. */
  CONNECT_RATE_LIMITER?: RateLimit;
  AUTH_RATE_LIMITER?: RateLimit;
  ICE_RATE_LIMITER?: RateLimit;
  /** Per signed-in user: room connections and account API calls. */
  USER_RATE_LIMITER?: RateLimit;
}

const LEGAL_TEXT = { terms, privacy, refunds };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local';

    const connect = /^\/api\/rooms\/([A-Z0-9]{6})\/connect$/u.exec(url.pathname);
    if (connect) {
      if (!ROOM_CODE_PATTERN.test(connect[1]!)) return error('INVALID_ROOM', 400);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error('WEBSOCKET_REQUIRED', 426);
      if (!(await allowed(env.CONNECT_RATE_LIMITER, ip))) return error('RATE_LIMITED', 429);
      const token = bearer(request);
      const accountId = token ? accountIdOfToken(token) : null;
      if (accountId && !(await allowed(env.USER_RATE_LIMITER, `user:${accountId}`))) return error('RATE_LIMITED', 429);
      return env.ROOMS.get(env.ROOMS.idFromName(connect[1]!)).fetch(request);
    }

    if (url.pathname === '/api/ice-servers' && request.method === 'POST') {
      if (!(await allowed(env.ICE_RATE_LIMITER, ip))) return error('RATE_LIMITED', 429);
      return iceServers(request, env);
    }

    if (url.pathname === '/api/auth/config' && request.method === 'GET') {
      return json({ ok: true, githubClientId: env.GITHUB_CLIENT_ID ?? null, devAuth: env.DEV_AUTH === 'allow', tiers: TIERS });
    }

    if (url.pathname === '/api/auth/github' && request.method === 'POST') {
      if (!(await allowed(env.AUTH_RATE_LIMITER, ip))) return error('RATE_LIMITED', 429);
      const body = await readJson(request);
      const accessToken = isRecord(body) && typeof body['accessToken'] === 'string' ? body['accessToken'] : '';
      const user = accessToken ? await githubUser(env, request, accessToken) : null;
      if (!user) return error('GITHUB_AUTH_FAILED', 401);
      const account = accountOf(env, user.id);
      await account.upsertProfile(user);
      const { token, hash } = await mintToken(user.id);
      await account.addToken(hash);
      return json({ ok: true, token, account: await account.summary() });
    }

    if (url.pathname === '/api/me' && request.method === 'GET') {
      const account = await authenticate(env, sessionToken(request));
      if (!account) return error('UNAUTHORIZED', 401);
      if (!(await allowed(env.USER_RATE_LIMITER, `user:${account.id}`))) return error('RATE_LIMITED', 429);
      return json({ ok: true, account: await account.stub.summary() });
    }

    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      const token = bearer(request);
      const account = await authenticate(env, token);
      if (!account || !token) return error('UNAUTHORIZED', 401);
      await account.stub.revoke(await sha256(token));
      return json({ ok: true });
    }

    if (url.pathname === '/api/admin/tier' && request.method === 'POST') {
      const token = bearer(request);
      if (!env.ADMIN_TOKEN || !token || !safeEqual(token, env.ADMIN_TOKEN)) return error('UNAUTHORIZED', 401);
      const body = await readJson(request);
      const login = isRecord(body) && typeof body['login'] === 'string' ? body['login'] : '';
      const tier = isRecord(body) ? body['tier'] : null;
      if (!login || !isTierName(tier)) return error('INVALID_INPUT', 400);
      const id = await githubIdOf(env, login);
      if (!id) return error('UNKNOWN_USER', 404);
      const account = accountOf(env, id);
      await account.setTier(tier);
      return json({ ok: true, login, tier, account: await account.summary() });
    }

    // ---- Website: account and billing pages ----
    if (url.pathname === '/account' && request.method === 'GET') {
      const account = await authenticate(env, sessionToken(request));
      const summary = account ? await account.stub.summary() : null;
      return page(accountPage(summary, { enabled: false }, NOTICES[url.searchParams.get('notice') ?? ''] ?? null));
    }
    if (url.pathname === '/billing/success' && request.method === 'GET') {
      const account = await authenticate(env, sessionToken(request));
      const plan = url.searchParams.get('plan');
      return page(billingSuccessPage(account ? await account.stub.summary() : null, isTierName(plan) ? plan : null));
    }
    if (url.pathname === '/auth/github' && request.method === 'GET') return startWebSignIn(request, env, url);
    if (url.pathname === '/auth/github/callback' && request.method === 'GET') {
      if (!(await allowed(env.AUTH_RATE_LIMITER, ip))) return redirect('/account?notice=rate-limited');
      return finishWebSignIn(request, env, url);
    }
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      const token = sessionToken(request);
      const account = await authenticate(env, token);
      if (account && token) await account.stub.revoke(await sha256(token));
      return redirect('/account?notice=signed-out', [setCookie(request, SESSION_COOKIE, '', 0)]);
    }

    const join = /^\/j\/([A-Za-z0-9]{6})\/?$/u.exec(url.pathname);
    if (join) return html(landingPage(join[1]!.toUpperCase(), url.origin));
    if (url.pathname === '/') return html(landingPage(null, url.origin));
    const legal = LEGAL_PAGES.find((page) => url.pathname === `/${page.slug}`);
    if (legal) return html(legalPage(LEGAL_TEXT[legal.slug], legal.title));
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Room members get TURN credentials while the host's plan has relay time
 * left; the credential lifetime is capped by what remains. Everyone else, and
 * rooms over quota, get STUN only.
 */
async function iceServers(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const code = isRecord(body) && typeof body['code'] === 'string' ? body['code'] : '';
  const peerId = isRecord(body) && typeof body['peerId'] === 'string' ? body['peerId'] : '';
  const secret = isRecord(body) && typeof body['secret'] === 'string' ? body['secret'] : '';
  if (!ROOM_CODE_PATTERN.test(code) || !PEER_ID_PATTERN.test(peerId) || !secret) {
    return json({ ok: true, iceServers: STUN_SERVERS, relay: false, reason: 'Not a room member.' });
  }
  const allowance = await env.ROOMS.get(env.ROOMS.idFromName(code)).turnAllowance(peerId, secret);
  if (!allowance.ok) return json({ ok: true, iceServers: STUN_SERVERS, relay: false, reason: 'Not a room member.' });
  if (!allowance.relay) return json({ ok: true, iceServers: STUN_SERVERS, relay: false, reason: allowance.reason });
  const keyId = env.TURN_KEY_ID?.trim();
  const keySecret = env.TURN_KEY_SECRET?.trim();
  if (keyId && keySecret) {
    try {
      const upstream = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keySecret}` },
          body: JSON.stringify({ ttl: allowance.ttlSeconds }),
        },
      );
      if (upstream.ok) {
        const payload = await upstream.json<{ iceServers?: unknown }>();
        if (Array.isArray(payload.iceServers)) {
          return json({ ok: true, iceServers: payload.iceServers, relay: true, expiresIn: allowance.ttlSeconds });
        }
      }
    } catch {
      // Fall back to STUN below.
    }
  }
  return json({ ok: true, iceServers: STUN_SERVERS, relay: false, reason: 'Relay is not configured on this server.' });
}

const NOTICES: Record<string, string> = {
  'signed-out': 'You are signed out.',
  'signin-failed': 'GitHub sign-in did not complete. Please try again.',
  'signin-unavailable': 'Sign-in is not available on this server yet.',
  'rate-limited': 'Too many attempts. Wait a minute and try again.',
};

/** Website sign-in: GitHub's web flow, with a state cookie against forged callbacks. */
function startWebSignIn(request: Request, env: Env, url: URL): Promise<Response> | Response {
  const next = safeNext(url.searchParams.get('next'));
  const host = url.hostname;
  const dev = url.searchParams.get('dev');
  if (dev && env.DEV_AUTH === 'allow' && (host === '127.0.0.1' || host === 'localhost')) {
    return completeSignIn(request, env, { id: `dev-${dev.toLowerCase()}`, login: dev, name: dev, avatarUrl: null }, next);
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return redirect('/account?notice=signin-unavailable');
  const state = crypto.randomUUID();
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', `${url.origin}/auth/github/callback`);
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('allow_signup', 'true');
  return redirect(authorize.toString(), [setCookie(request, STATE_COOKIE, `${state}|${next}`, 600, '/auth')]);
}

async function finishWebSignIn(request: Request, env: Env, url: URL): Promise<Response> {
  const saved = cookie(request, STATE_COOKIE) ?? '';
  const [state, next = '/account'] = saved.split('|');
  const clearState = setCookie(request, STATE_COOKIE, '', 0, '/auth');
  const code = url.searchParams.get('code');
  if (!state || !code || url.searchParams.get('state') !== state) return redirect('/account?notice=signin-failed', [clearState]);
  const accessToken = await githubCodeExchange(env, code, `${url.origin}/auth/github/callback`);
  const user = accessToken ? await githubUser(env, request, accessToken) : null;
  if (!user) return redirect('/account?notice=signin-failed', [clearState]);
  const response = await completeSignIn(request, env, user, safeNext(next));
  response.headers.append('Set-Cookie', clearState);
  return response;
}

async function completeSignIn(request: Request, env: Env, user: GitHubUser, next: string): Promise<Response> {
  const account = accountOf(env, user.id);
  await account.upsertProfile(user);
  const { token, hash } = await mintToken(user.id);
  await account.addToken(hash);
  return redirect(next, [sessionCookie(request, token)]);
}

/** Only same-site paths, so sign-in cannot be used as an open redirect. */
function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/account';
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers });
}

function page(body: string): Response {
  return new Response(body, { headers: PAGE_HEADERS });
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 16 * 1_024) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function error(code: string, status: number): Response {
  return json({ ok: false, code }, status);
}

function html(body: string): Response {
  return new Response(body, { headers: LANDING_HEADERS });
}

async function allowed(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}
