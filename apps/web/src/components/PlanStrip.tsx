import { Check, ChevronDown, Minus } from 'lucide-react';
import { useState } from 'react';
import { plansOf, type Plan, type PlanItem } from '@codex-live-share/protocol';
import { useNow, useYType } from '../lib/hooks';
import { t } from '../lib/i18n';
import type { LiveSession } from '../lib/session';

const LINGER_MS = 45_000;

interface PlanStripProps {
  live: LiveSession;
  selfPeerId: string;
  onOpenFile: (path: string) => void;
}

/**
 * Every agent's current plan, always in view above the editor: whose Codex it
 * is, how far along, and what it is doing right now. Expands to the full
 * checklist. Finished plans linger briefly so the last check-off is seen.
 */
export function PlanStrip({ live, selfPeerId, onOpenFile }: PlanStripProps) {
  const plans = useYType(plansOf(live.doc));
  const now = useNow(5_000);
  const [open, setOpen] = useState(false);

  const visible = [...plans.values()]
    .filter((plan) => plan.status === 'active' || now - Date.parse(plan.updatedAt) < LINGER_MS)
    .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active') || left.createdAt.localeCompare(right.createdAt));

  if (!visible.length) return null;
  const label = (plan: Plan) => (plan.owner.peerId === selfPeerId ? t('yourAgent') : t('agentOf', { name: plan.owner.name }));

  return (
    <section className="plans" data-open={open || undefined} aria-label={t('plans')}>
      <div className="plans-row">
        {visible.map((plan) => {
          const current = plan.items.find((item) => item.status === 'in_progress') ?? plan.items.find((item) => item.status === 'pending');
          const done = plan.items.filter((item) => item.status === 'done').length;
          return (
            <button
              key={plan.id}
              type="button"
              className="ticket"
              data-state={plan.status}
              style={{ '--who': plan.owner.color } as React.CSSProperties}
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
            >
              <span className="ticket-who">{label(plan)}</span>
              <span className="ticket-track" aria-label={t('planOf', { done, total: plan.items.length })}>
                {plan.items.map((item, index) => <span key={index} className="seg" data-status={item.status} />)}
              </span>
              <span className="ticket-now">
                {plan.status === 'active' ? current?.text ?? '' : plan.status === 'done' ? t('planDone') : t('planAbandoned')}
              </span>
            </button>
          );
        })}
        <button type="button" className="icon-button plans-toggle" onClick={() => setOpen((value) => !value)} aria-label={t('plans')} aria-expanded={open}>
          <ChevronDown size={16} strokeWidth={1.75} />
        </button>
      </div>
      {open ? (
        <div className="plans-detail">
          {visible.map((plan) => (
            <div key={plan.id} className="plan" style={{ '--who': plan.owner.color } as React.CSSProperties}>
              <div className="plan-head">
                <span className="dot" />
                <span className="plan-who">{label(plan)}</span>
                <span className="plan-count">
                  {t('planOf', { done: plan.items.filter((item) => item.status === 'done').length, total: plan.items.length })}
                </span>
              </div>
              <ol className="plan-items">
                {plan.items.map((item, index) => <PlanRow key={index} item={item} onOpenFile={onOpenFile} />)}
              </ol>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function PlanRow({ item, onOpenFile }: { item: PlanItem; onOpenFile: (path: string) => void }) {
  return (
    <li className="plan-item" data-status={item.status}>
      <span className="mark" aria-hidden="true">
        {item.status === 'done' ? <Check size={11} strokeWidth={3} /> : item.status === 'dropped' ? <Minus size={11} strokeWidth={3} /> : null}
      </span>
      <span className="plan-text">{item.text}</span>
      {item.files.length ? (
        <span className="plan-files">
          {item.files.map((file) => (
            <button key={file} type="button" className="file-chip" onClick={() => onOpenFile(file)}>
              {file.split('/').at(-1)}
            </button>
          ))}
        </span>
      ) : null}
    </li>
  );
}
