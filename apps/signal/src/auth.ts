import type { TierName } from '@codex-live-share/signal-core';
import type { Account } from './account';
import type { Env } from './index';

/**
 * Hosted-mode tokens look like `lsh_<account id>_<secret>`. The account id
 * routes to the user's Account Durable Object, which keeps only a hash.
 */
const TOKEN_PATTERN = /^lsh_([A-Za-z0-9-]{1,64})_([A-Za-z0-9_-]{32,64})$/u;

export interface GitHubUser {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export function bearer(request: Request): string | null {
  const header = request.headers.get('Authorization');
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

export const SESSION_COOKIE = 'ls_session';
export const STATE_COOKIE = 'ls_oauth_state';
const SESSION_MAX_AGE = 30 * 24 * 3_600;

export function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/** The website signs people in with a session cookie holding the same kind of token the plugin uses. */
export function sessionToken(request: Request): string | null {
  return bearer(request) ?? cookie(request, SESSION_COOKIE);
}

/** Secure cookies everywhere except plain-http local development. */
export function setCookie(request: Request, name: string, value: string, maxAge: number, path = '/'): string {
  const host = new URL(request.url).hostname;
  const secure = host === 'localhost' || host === '127.0.0.1' ? '' : '; Secure';
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

export function sessionCookie(request: Request, token: string): string {
  return setCookie(request, SESSION_COOKIE, token, SESSION_MAX_AGE);
}

/** Exchanges a GitHub web-flow authorization code for a user access token. */
export async function githubCodeExchange(env: Env, code: string, redirectUri: string): Promise<string | null> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return null;
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { access_token?: string };
  return body.access_token ?? null;
}

export function accountOf(env: Env, id: string): DurableObjectStub<Account> {
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(`gh:${id}`));
}

export function accountIdOfToken(token: string): string | null {
  return TOKEN_PATTERN.exec(token)?.[1] ?? null;
}

export async function mintToken(accountId: string): Promise<{ token: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const token = `lsh_${accountId}_${secret}`;
  return { token, hash: await sha256(token) };
}

/** Resolves a bearer token to its account, or null. */
export async function authenticate(env: Env, token: string | null): Promise<{ id: string; login: string; tier: TierName; stub: DurableObjectStub<Account> } | null> {
  if (!token) return null;
  const id = accountIdOfToken(token);
  if (!id) return null;
  const stub = accountOf(env, id);
  const result = await stub.authorize(await sha256(token));
  return result ? { ...result, stub } : null;
}

/**
 * Proves a GitHub identity from a user access token the client obtained with
 * GitHub's device flow. Local development can use `dev:<login>` instead, but
 * only when DEV_AUTH=allow and the request comes from localhost.
 */
export async function githubUser(env: Env, request: Request, accessToken: string): Promise<GitHubUser | null> {
  const host = new URL(request.url).hostname;
  if (accessToken.startsWith('dev:')) {
    if (env.DEV_AUTH !== 'allow' || (host !== '127.0.0.1' && host !== 'localhost')) return null;
    const login = accessToken.slice(4).replaceAll(/[^A-Za-z0-9-]/gu, '').slice(0, 39);
    return login ? { id: `dev-${login.toLowerCase()}`, login, name: login, avatarUrl: null } : null;
  }
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'codex-live-share',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) return null;
  const user = (await response.json()) as { id?: number; login?: string; name?: string | null; avatar_url?: string | null };
  if (typeof user.id !== 'number' || typeof user.login !== 'string') return null;
  return { id: String(user.id), login: user.login, name: user.name ?? null, avatarUrl: user.avatar_url ?? null };
}

/** Looks up a GitHub account id by login, for the admin tier endpoint. */
export async function githubIdOf(env: Env, login: string): Promise<string | null> {
  if (env.DEV_AUTH === 'allow' && login.startsWith('dev-')) return login;
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'codex-live-share' },
  });
  if (!response.ok) return null;
  const user = (await response.json()) as { id?: number };
  return typeof user.id === 'number' ? String(user.id) : null;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}
