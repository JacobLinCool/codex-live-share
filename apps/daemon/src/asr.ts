import { GEMINI_MODEL, OPENAI_MODEL } from '@codex-live-share/transcribe/contracts';

// Adapted from Weave-In's issueTranscriptionToken: the API key stays in this
// daemon and the browser only ever receives a short-lived, single-purpose token.
const GEMINI_TOKEN_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
const OPENAI_TOKEN_ENDPOINT = 'https://api.openai.com/v1/realtime/client_secrets';
const TOKEN_LIFETIME_MS = 12 * 60 * 1_000;
const NEW_SESSION_LIFETIME_MS = 60 * 1_000;

export type AsrProvider = 'openai' | 'gemini';

export interface IssuedToken {
  provider: AsrProvider;
  token: string;
  expiresAt: string;
}

export async function issueTranscriptionToken(
  provider: AsrProvider,
  apiKey: string,
  upstreamFetch: typeof fetch = fetch,
): Promise<IssuedToken> {
  const now = Date.now();
  const expiresAt = new Date(now + TOKEN_LIFETIME_MS).toISOString();
  const request = provider === 'gemini' ? geminiTokenRequest(apiKey, now, expiresAt) : openAiTokenRequest(apiKey);
  const upstream = await upstreamFetch(request.url, { ...request.init, signal: AbortSignal.timeout(10_000) });
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    throw new Error(`${provider} token request failed (HTTP ${upstream.status}) ${detail.slice(0, 300)}`);
  }
  const payload: unknown = await upstream.json();
  const token = readToken(payload, provider === 'gemini' ? 'name' : 'value');
  if (!token) throw new Error(`${provider} returned no usable token`);
  return { provider, token, expiresAt };
}

function geminiTokenRequest(apiKey: string, now: number, expiresAt: string): { url: string; init: RequestInit } {
  return {
    url: GEMINI_TOKEN_ENDPOINT,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        uses: 1,
        expireTime: expiresAt,
        newSessionExpireTime: new Date(now + NEW_SESSION_LIFETIME_MS).toISOString(),
        fieldMask: 'model,generation_config.response_modalities',
        bidiGenerateContentSetup: {
          model: `models/${GEMINI_MODEL}`,
          generationConfig: { responseModalities: ['TEXT'] },
        },
      }),
    },
  };
}

function openAiTokenRequest(apiKey: string): { url: string; init: RequestInit } {
  return {
    url: OPENAI_TOKEN_ENDPOINT,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: Math.floor(TOKEN_LIFETIME_MS / 1_000) },
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24_000 },
              transcription: { model: OPENAI_MODEL, delay: 'minimal' },
              turn_detection: null,
            },
          },
        },
      }),
    },
  };
}

function readToken(value: unknown, field: 'name' | 'value'): string | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as Record<string, unknown>)[field];
  if (typeof raw !== 'string') return null;
  const token = raw.trim();
  return token.length >= 16 && token.length <= 2_048 ? token : null;
}
