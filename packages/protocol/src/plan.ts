import type { Identity } from './identity';
import { normalizeSharedPath } from './doc';

export const MAX_PLAN_ITEMS = 5;
/** A CJK character or a Latin word each counts as one unit. */
export const MAX_ITEM_UNITS = 30;
export const MAX_ITEM_CHARS = 160;

export type PlanItemStatus = 'pending' | 'in_progress' | 'done' | 'dropped';
export type PlanStatus = 'active' | 'done' | 'abandoned';

export interface PlanItem {
  text: string;
  files: string[];
  status: PlanItemStatus;
}

export interface Plan {
  id: string;
  owner: Identity;
  /** Session/subagent identity supplied by the hook, not by the model. */
  agentSession: string;
  items: PlanItem[];
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PlanDraftItem {
  text: string;
  files?: string[] | undefined;
}

export const PLAN_ITEM_STATUSES: readonly PlanItemStatus[] = ['pending', 'in_progress', 'done', 'dropped'];

export function countUnits(text: string): number {
  let units = 0;
  let inWord = false;
  for (const char of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) {
      units += 1;
      inWord = false;
    } else if (/[\p{L}\p{N}]/u.test(char)) {
      if (!inWord) units += 1;
      inWord = true;
    } else {
      inWord = false;
    }
  }
  return units;
}

/** Returns a reason string when the draft is not a short, shareable plan. */
export function validatePlanDraft(items: readonly PlanDraftItem[]): string | null {
  if (items.length === 0) return 'A plan needs at least one item.';
  if (items.length > MAX_PLAN_ITEMS) return `A plan has at most ${MAX_PLAN_ITEMS} items; merge related steps.`;
  for (const [index, item] of items.entries()) {
    if ((item.files?.length ?? 0) > 8) return `Item ${index + 1} has more than 8 file paths; split its scope.`;
    if (item.files?.some((path) => !normalizeSharedPath(path))) return `Item ${index + 1} needs relative file paths inside the shared folder.`;
    const text = item.text.trim();
    if (!text) return `Item ${index + 1} is empty.`;
    if (text.includes('\n')) return `Item ${index + 1} must be a single line.`;
    if (text.length > MAX_ITEM_CHARS || countUnits(text) > MAX_ITEM_UNITS) {
      return `Item ${index + 1} is too long (max ${MAX_ITEM_UNITS} words or CJK characters): "${text}"`;
    }
  }
  return null;
}

export function createPlan(owner: Identity, items: readonly PlanDraftItem[], agentSession: string, now = new Date()): Plan {
  const at = now.toISOString();
  return {
    id: crypto.randomUUID(),
    owner,
    agentSession,
    items: items.map((item, index) => ({
      text: item.text.trim(),
      files: [...new Set((item.files ?? []).map((path) => normalizeSharedPath(path)!))],
      status: index === 0 ? 'in_progress' : 'pending',
    })),
    status: 'active',
    createdAt: at,
    updatedAt: at,
  };
}

/** Applies one item status change; the plan finishes once nothing is left open. */
export function updatePlanItem(plan: Plan, index: number, status: PlanItemStatus, now = new Date()): Plan {
  if (!plan.items[index]) throw new RangeError(`Plan ${plan.id} has no item ${index + 1}.`);
  const items = plan.items.map((item, at) => (at === index ? { ...item, status } : item));
  const open = items.some((item) => item.status === 'pending' || item.status === 'in_progress');
  if ((status === 'done' || status === 'dropped') && !items.some((item) => item.status === 'in_progress')) {
    const next = items.findIndex((item) => item.status === 'pending');
    if (next >= 0) items[next] = { ...items[next]!, status: 'in_progress' };
  }
  return { ...plan, items, status: open ? 'active' : 'done', updatedAt: now.toISOString() };
}

export function finishPlan(plan: Plan, status: Exclude<PlanStatus, 'active'>, now = new Date()): Plan {
  return {
    ...plan,
    status,
    items: plan.items.map((item) =>
      item.status === 'pending' || item.status === 'in_progress'
        ? { ...item, status: status === 'done' ? 'done' : 'dropped' }
        : item,
    ),
    updatedAt: now.toISOString(),
  };
}
