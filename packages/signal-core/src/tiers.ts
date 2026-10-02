/**
 * Hosted-mode plans. Direct mode has no tiers: it uses no service of ours.
 * Billing is not wired yet; an admin sets a user's tier.
 */
export type TierName = 'free' | 'plus' | 'pro';

export interface TierLimits {
  /** Monthly price in US dollars. */
  priceUsd: number;
  /** Hosted rooms one user can have open at once. */
  rooms: number;
  /** People in a room, host included. */
  people: number;
  /** Longest session; null means unlimited. */
  sessionMs: number | null;
  /** TURN relay time per calendar month (UTC), summed over everyone in the user's rooms. */
  relaySecondsPerMonth: number;
}

export const TIER_NAMES: readonly TierName[] = ['free', 'plus', 'pro'];

export const TIERS: Record<TierName, TierLimits> = {
  free: { priceUsd: 0, rooms: 1, people: 3, sessionMs: 2 * 3_600_000, relaySecondsPerMonth: 10 * 3_600 },
  plus: { priceUsd: 5, rooms: 2, people: 5, sessionMs: 8 * 3_600_000, relaySecondsPerMonth: 50 * 3_600 },
  pro: { priceUsd: 20, rooms: 5, people: 8, sessionMs: null, relaySecondsPerMonth: 200 * 3_600 },
};

export function isTierName(value: unknown): value is TierName {
  return typeof value === 'string' && (TIER_NAMES as readonly string[]).includes(value);
}

export function describeTier(tier: TierName): string {
  const limits = TIERS[tier];
  const price = limits.priceUsd ? `$${limits.priceUsd}/month` : 'free';
  const session = limits.sessionMs === null ? 'no session time limit' : `sessions up to ${limits.sessionMs / 3_600_000} h`;
  return `${tier} (${price}): ${limits.rooms} hosted room${limits.rooms === 1 ? '' : 's'} at a time, up to ${limits.people} people, ${session}, ${limits.relaySecondsPerMonth / 3_600} relay hours a month`;
}
