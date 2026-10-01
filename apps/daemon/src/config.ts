import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { PEER_COLORS, isColor, normalizeDisplayName } from '@codex-live-share/protocol';

/** Hosted mode's signal Worker (apps/signal). Direct mode needs no server of ours. */
export const DEFAULT_HOSTED_SIGNAL_URL = 'https://codex-live-share.jacoblincool.workers.dev';

export const HOME = process.env['CODEX_LIVE_SHARE_HOME'] ?? join(homedir(), '.codex-live-share');
export const RUN_DIR = join(HOME, 'run');
export const SHARES_DIR = join(HOME, 'shares');
export const CONFIG_PATH = join(HOME, 'config.json');
export const BIN_DIR = join(HOME, 'bin');

export type ConnectionMode = 'direct' | 'hosted';

export interface UserConfig {
  name: string;
  /** False until the person confirms the name in the editor. */
  nameConfirmed: boolean;
  color: string;
  defaultMode: ConnectionMode;
  hostedSignalUrl: string;
  asr: {
    provider: 'openai' | 'gemini' | null;
    openaiApiKey?: string;
    geminiApiKey?: string;
    languageCodes?: string[];
  };
}

export function loadConfig(): UserConfig {
  let stored: Partial<UserConfig> & { signalUrl?: string } = {};
  try {
    stored = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as typeof stored;
  } catch {
    // First run.
  }
  const name = normalizeDisplayName(stored.name ?? '') ?? defaultName();
  const color = isColor(stored.color) ? stored.color : PEER_COLORS[Math.floor(Math.random() * PEER_COLORS.length)]!;
  const mode = process.env['CODEX_LIVE_SHARE_MODE'] ?? stored.defaultMode;
  return {
    name,
    nameConfirmed: stored.nameConfirmed ?? Boolean(stored.name),
    color,
    defaultMode: mode === 'hosted' ? 'hosted' : 'direct',
    hostedSignalUrl: process.env['CODEX_LIVE_SHARE_SIGNAL_URL'] ?? stored.hostedSignalUrl ?? stored.signalUrl ?? DEFAULT_HOSTED_SIGNAL_URL,
    asr: { provider: null, ...stored.asr },
  };
}

export function saveConfig(config: UserConfig): void {
  writePrivateJson(CONFIG_PATH, config);
}

/** Environment keys win over stored ones; the provider follows whichever key exists. */
export function resolveAsr(config: UserConfig): { provider: 'openai' | 'gemini'; apiKey: string } | null {
  const openai = process.env['OPENAI_API_KEY']?.trim() || config.asr.openaiApiKey?.trim();
  const gemini = process.env['GEMINI_API_KEY']?.trim() || config.asr.geminiApiKey?.trim();
  if (config.asr.provider === 'openai' && openai) return { provider: 'openai', apiKey: openai };
  if (config.asr.provider === 'gemini' && gemini) return { provider: 'gemini', apiKey: gemini };
  if (openai) return { provider: 'openai', apiKey: openai };
  if (gemini) return { provider: 'gemini', apiKey: gemini };
  return null;
}

export function folderKey(folder: string): string {
  return createHash('sha256').update(folder).digest('hex').slice(0, 16);
}

export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function defaultName(): string {
  try {
    const name = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', timeout: 2_000 }).trim();
    const normalized = normalizeDisplayName(name);
    if (normalized) return normalized;
  } catch {
    // No git.
  }
  return normalizeDisplayName(userInfo().username) ?? 'Someone';
}
