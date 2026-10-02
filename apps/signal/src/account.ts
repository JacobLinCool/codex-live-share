import { DurableObject } from 'cloudflare:workers';
import { TIERS, isTierName, type TierLimits, type TierName } from '@codex-live-share/signal-core';
import type { Env } from './index';

/** A room still counts toward the plan this long after its host was last connected. */
const ROOM_GRACE_MS = 10 * 60_000;
const MAX_TOKENS = 20;

export interface Profile {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

interface TokenRecord {
  createdAt: number;
  lastUsedAt: number;
}

interface RoomActivity {
  online: boolean;
  lastSeen: number;
}

interface Usage {
  month: string;
  relaySeconds: number;
}

export interface AccountSummary {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  tier: TierName;
  limits: TierLimits;
  usage: { month: string; relaySeconds: number; relaySecondsLeft: number };
  activeRooms: string[];
}

export type RoomGrant =
  | { ok: true; owner: string; limits: TierLimits }
  | { ok: false; code: string; message: string };

/**
 * One Durable Object per signed-in user (named `gh:<github id>`): profile,
 * plan tier, API tokens (stored as hashes), open hosted rooms, and this
 * month's relay usage.
 */
export class Account extends DurableObject<Env> {
  async upsertProfile(profile: Omit<Profile, 'createdAt'>): Promise<void> {
    const existing = await this.ctx.storage.get<Profile>('profile');
    await this.ctx.storage.put('profile', { ...profile, createdAt: existing?.createdAt ?? new Date().toISOString() });
  }

  /** Stores only the hash; the caller hands the token to the user once. */
  async addToken(tokenHash: string): Promise<void> {
    const tokens = (await this.ctx.storage.get<Record<string, TokenRecord>>('tokens')) ?? {};
    tokens[tokenHash] = { createdAt: Date.now(), lastUsedAt: Date.now() };
    const sorted = Object.entries(tokens).sort((left, right) => right[1].lastUsedAt - left[1].lastUsedAt).slice(0, MAX_TOKENS);
    await this.ctx.storage.put('tokens', Object.fromEntries(sorted));
  }

  async authorize(tokenHash: string): Promise<{ id: string; login: string; tier: TierName } | null> {
    const tokens = (await this.ctx.storage.get<Record<string, TokenRecord>>('tokens')) ?? {};
    const record = tokens[tokenHash];
    const profile = await this.ctx.storage.get<Profile>('profile');
    if (!record || !profile) return null;
    if (Date.now() - record.lastUsedAt > 60_000) {
      record.lastUsedAt = Date.now();
      await this.ctx.storage.put('tokens', tokens);
    }
    return { id: profile.id, login: profile.login, tier: await this.#tier() };
  }

  async revoke(tokenHash: string): Promise<void> {
    const tokens = (await this.ctx.storage.get<Record<string, TokenRecord>>('tokens')) ?? {};
    delete tokens[tokenHash];
    await this.ctx.storage.put('tokens', tokens);
  }

  async setTier(tier: string): Promise<TierName> {
    if (!isTierName(tier)) throw new Error(`Unknown tier ${tier}`);
    await this.ctx.storage.put('tier', tier);
    return tier;
  }

  /** Called when a signed-in host creates a hosted room. */
  async openRoom(code: string): Promise<RoomGrant> {
    const profile = await this.ctx.storage.get<Profile>('profile');
    if (!profile) return { ok: false, code: 'AUTH_REQUIRED', message: 'Sign in to use hosted mode.' };
    const tier = await this.#tier();
    const limits = TIERS[tier];
    const rooms = await this.#rooms();
    const active = Object.keys(rooms).filter((other) => other !== code);
    if (active.length >= limits.rooms) {
      return {
        ok: false,
        code: 'ROOM_LIMIT',
        message: `Your ${tier} plan allows ${limits.rooms} hosted room${limits.rooms === 1 ? '' : 's'} at a time (open: ${active.join(', ')}). End one first, use direct mode, or upgrade.`,
      };
    }
    rooms[code] = { online: true, lastSeen: Date.now() };
    await this.ctx.storage.put('rooms', rooms);
    return { ok: true, owner: `gh:${profile.id}`, limits };
  }

  async roomActivity(code: string, online: boolean): Promise<void> {
    const rooms = await this.#rooms();
    rooms[code] = { online, lastSeen: Date.now() };
    await this.ctx.storage.put('rooms', rooms);
  }

  async closeRoom(code: string): Promise<void> {
    const rooms = await this.#rooms();
    delete rooms[code];
    await this.ctx.storage.put('rooms', rooms);
  }

  /** Adds relay time; returns what is left this month. */
  async addRelay(seconds: number): Promise<number> {
    const usage = await this.#usage();
    usage.relaySeconds += Math.max(0, Math.round(seconds));
    await this.ctx.storage.put('usage', usage);
    return Math.max(0, TIERS[await this.#tier()].relaySecondsPerMonth - usage.relaySeconds);
  }

  async relayLeft(): Promise<number> {
    const usage = await this.#usage();
    return Math.max(0, TIERS[await this.#tier()].relaySecondsPerMonth - usage.relaySeconds);
  }

  async summary(): Promise<AccountSummary | null> {
    const profile = await this.ctx.storage.get<Profile>('profile');
    if (!profile) return null;
    const tier = await this.#tier();
    const usage = await this.#usage();
    return {
      login: profile.login,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      tier,
      limits: TIERS[tier],
      usage: { month: usage.month, relaySeconds: usage.relaySeconds, relaySecondsLeft: Math.max(0, TIERS[tier].relaySecondsPerMonth - usage.relaySeconds) },
      activeRooms: Object.keys(await this.#rooms()),
    };
  }

  async #tier(): Promise<TierName> {
    const tier = await this.ctx.storage.get<string>('tier');
    return isTierName(tier) ? tier : 'free';
  }

  /** Rooms that still count: host connected, or seen within the grace period. */
  async #rooms(): Promise<Record<string, RoomActivity>> {
    const rooms = (await this.ctx.storage.get<Record<string, RoomActivity>>('rooms')) ?? {};
    const now = Date.now();
    for (const [code, activity] of Object.entries(rooms)) {
      if (!activity.online && now - activity.lastSeen > ROOM_GRACE_MS) delete rooms[code];
      // A room whose host never reported going offline stops counting after a day.
      if (activity.online && now - activity.lastSeen > 24 * 3_600_000) delete rooms[code];
    }
    return rooms;
  }

  async #usage(): Promise<Usage> {
    const month = new Date().toISOString().slice(0, 7);
    const usage = await this.ctx.storage.get<Usage>('usage');
    return usage && usage.month === month ? usage : { month, relaySeconds: 0 };
  }
}
