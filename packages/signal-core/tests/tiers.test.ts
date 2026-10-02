import { describe, expect, it } from 'vitest';
import { TIERS, TIER_NAMES, describeTier, isTierName } from '../src';

describe('tiers', () => {
  it('each paid plan costs more and allows at least as much as the one below', () => {
    for (let index = 1; index < TIER_NAMES.length; index += 1) {
      const lower = TIERS[TIER_NAMES[index - 1]!];
      const higher = TIERS[TIER_NAMES[index]!];
      expect(higher.priceUsd).toBeGreaterThan(lower.priceUsd);
      expect(higher.rooms).toBeGreaterThan(lower.rooms);
      expect(higher.people).toBeGreaterThan(lower.people);
      expect(higher.relaySecondsPerMonth).toBeGreaterThan(lower.relaySecondsPerMonth);
      expect(higher.sessionMs === null || (lower.sessionMs !== null && higher.sessionMs > lower.sessionMs)).toBe(true);
    }
    expect([TIERS.plus.priceUsd, TIERS.pro.priceUsd]).toEqual([5, 20]);
  });

  it('describes plans for people', () => {
    expect(describeTier('free')).toBe('free (free): 1 hosted room at a time, up to 3 people, sessions up to 2 h, 10 relay hours a month');
    expect(describeTier('plus')).toBe('plus ($5/month): 2 hosted rooms at a time, up to 5 people, sessions up to 8 h, 50 relay hours a month');
    expect(isTierName('pro')).toBe(true);
    expect(isTierName('enterprise')).toBe(false);
  });
});
