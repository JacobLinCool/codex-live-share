import { loadConfig, saveConfig } from './config';

/**
 * Hosted-mode sign-in. Only hosts of hosted rooms sign in; guests never do.
 * The daemon runs GitHub's OAuth device flow itself (no browser redirect to
 * catch, no client secret), then trades the GitHub token for a Live Share
 * token and forgets the GitHub one.
 */
export interface DeviceLogin {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  /** Resolves with the signed-in GitHub login once the user approves. */
  done: Promise<string>;
}

interface AuthConfig {
  githubClientId: string | null;
  devAuth: boolean;
}

export class AccountError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function startLogin(signalUrl = loadConfig().hostedSignalUrl): Promise<DeviceLogin> {
  const config = await serviceConfig(signalUrl);
  if (!config.githubClientId) throw new AccountError('LOGIN_UNAVAILABLE', `${signalUrl} has no GitHub sign-in configured.`);
  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: config.githubClientId, scope: 'read:user' }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error_description?: string };
  if (!response.ok || !body.device_code || !body.user_code) {
    throw new AccountError('LOGIN_FAILED', body.error_description ?? `GitHub refused the sign-in request (HTTP ${response.status}).`);
  }
  const clientId = config.githubClientId;
  const deviceCode = body.device_code;
  const expiresIn = body.expires_in ?? 900;
  const done = (async () => {
    let interval = Math.max(5, body.interval ?? 5) * 1_000;
    const deadline = Date.now() + expiresIn * 1_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      const poll = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
        signal: AbortSignal.timeout(15_000),
      }).then((result) => result.json() as Promise<{ access_token?: string; error?: string; interval?: number; error_description?: string }>);
      if (poll.access_token) return exchange(signalUrl, poll.access_token);
      if (poll.error === 'slow_down') interval = Math.max(interval + 5_000, (poll.interval ?? 0) * 1_000);
      else if (poll.error && poll.error !== 'authorization_pending') {
        throw new AccountError('LOGIN_FAILED', poll.error_description ?? `GitHub sign-in failed: ${poll.error}`);
      }
    }
    throw new AccountError('LOGIN_EXPIRED', 'The sign-in code expired before it was approved. Try again.');
  })();
  done.catch(() => {});
  return { userCode: body.user_code, verificationUri: body.verification_uri ?? 'https://github.com/login/device', expiresIn, done };
}

/** Trades a GitHub user token (or `dev:<login>` against a local dev server) for a Live Share token. */
export async function exchange(signalUrl: string, accessToken: string): Promise<string> {
  const response = await fetch(new URL('/api/auth/github', signalUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as { ok: boolean; token?: string; account?: { login: string }; code?: string };
  if (!body.ok || !body.token || !body.account) throw new AccountError(body.code ?? 'LOGIN_FAILED', 'The Live Share service did not accept the GitHub sign-in.');
  const config = loadConfig();
  saveConfig({ ...config, hostedAuth: { token: body.token, login: body.account.login, signalUrl: new URL(signalUrl).origin } });
  return body.account.login;
}

/** The signed-in account's plan, limits, and this month's usage. */
export async function accountSummary(): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const auth = config.hostedAuth;
  if (!auth || auth.signalUrl !== new URL(config.hostedSignalUrl).origin) {
    throw new AccountError('NOT_SIGNED_IN', 'Not signed in to hosted mode. Use live_share_login (only needed to host in hosted mode).');
  }
  const response = await fetch(new URL('/api/me', auth.signalUrl), {
    headers: { Authorization: `Bearer ${auth.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as { ok: boolean; account?: Record<string, unknown>; code?: string };
  if (!body.ok || !body.account) {
    if (response.status === 401) throw new AccountError('NOT_SIGNED_IN', 'Your hosted-mode sign-in is no longer valid. Use live_share_login again.');
    throw new AccountError(body.code ?? 'ACCOUNT_FAILED', 'Could not read your hosted-mode account.');
  }
  return body.account;
}

export async function logout(): Promise<void> {
  const config = loadConfig();
  const auth = config.hostedAuth;
  if (!auth) return;
  await fetch(new URL('/api/auth/logout', auth.signalUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.token}` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
  const { hostedAuth: _removed, ...rest } = config;
  saveConfig(rest);
}

/** The token to present when hosting on `signalUrl`, if signed in there. */
export function hostedToken(signalUrl: string): string | null {
  const auth = loadConfig().hostedAuth;
  return auth && auth.signalUrl === new URL(signalUrl).origin ? auth.token : null;
}

async function serviceConfig(signalUrl: string): Promise<AuthConfig> {
  const response = await fetch(new URL('/api/auth/config', signalUrl), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new AccountError('SERVICE_UNAVAILABLE', `The Live Share service at ${signalUrl} is unavailable (HTTP ${response.status}).`);
  return (await response.json()) as AuthConfig;
}
