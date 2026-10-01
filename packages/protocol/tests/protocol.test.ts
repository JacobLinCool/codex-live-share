import { describe, expect, it } from 'vitest';
import {
  countUnits,
  createPlan,
  createRoomCode,
  finishPlan,
  normalizeRoomCode,
  normalizeSharedPath,
  updatePlanItem,
  validatePlanDraft,
} from '../src';

const owner = { peerId: 'a'.repeat(32), name: 'Alice', color: '#f97316' };

describe('plan drafts', () => {
  it('counts CJK characters and Latin words as units', () => {
    expect(countUnits('改寫 intro 段落')).toBe(5);
    expect(countUnits('Tighten the abstract to 150 words')).toBe(6);
  });

  it('rejects long or oversized plans', () => {
    expect(validatePlanDraft([])).toMatch(/at least one/u);
    expect(validatePlanDraft(Array.from({ length: 6 }, () => ({ text: 'x' })))).toMatch(/at most 5/u);
    expect(validatePlanDraft([{ text: '這'.repeat(31) }])).toMatch(/too long/u);
    expect(validatePlanDraft([{ text: 'one\ntwo' }])).toMatch(/single line/u);
    expect(validatePlanDraft([{ text: '依討論改寫 intro 第二段' }, { text: 'Fix citation keys' }])).toBeNull();
  });

  it('advances items and finishes when nothing is open', () => {
    let plan = createPlan(owner, [{ text: 'a' }, { text: 'b' }], null);
    expect(plan.items.map((item) => item.status)).toEqual(['in_progress', 'pending']);
    plan = updatePlanItem(plan, 0, 'done');
    expect(plan.items.map((item) => item.status)).toEqual(['done', 'in_progress']);
    expect(plan.status).toBe('active');
    plan = updatePlanItem(plan, 1, 'done');
    expect(plan.status).toBe('done');
    expect(finishPlan(createPlan(owner, [{ text: 'a' }], null), 'abandoned').items[0]?.status).toBe('dropped');
  });
});

describe('identifiers and paths', () => {
  it('creates and normalizes room codes', () => {
    const code = createRoomCode();
    expect(normalizeRoomCode(code.toLowerCase())).toBe(code);
    expect(normalizeRoomCode(`${code.slice(0, 3)}-${code.slice(3)}`)).toBe(code);
    expect(normalizeRoomCode('ABC10O')).toBeNull();
  });

  it('accepts only relative paths inside the root', () => {
    expect(normalizeSharedPath('paper/main.tex')).toBe('paper/main.tex');
    expect(normalizeSharedPath('paper\\main.tex')).toBe('paper/main.tex');
    for (const bad of ['../x', '/etc/passwd', 'a/../../b', 'a//b', 'C:/x', './a', '']) {
      expect(normalizeSharedPath(bad)).toBeNull();
    }
  });
});
