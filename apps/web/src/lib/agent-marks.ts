import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

export interface AgentMark {
  id: string;
  from: number;
  to: number;
  color: string;
  label: string;
  /** Epoch ms when the mark appeared; it fades out over MARK_MS. */
  at: number;
}

export const MARK_MS = 9_000;

export const setAgentMarks = StateEffect.define<AgentMark[]>();

/**
 * Text an agent just wrote glows in its owner's color, like wet ink, and a
 * small flag names whose Codex it was. Marks follow later edits and fade out.
 */
export const agentMarks: Extension = StateField.define<{ marks: AgentMark[]; decorations: DecorationSet }>({
  create: () => ({ marks: [], decorations: Decoration.none }),
  update(value, transaction) {
    let marks = value.marks;
    if (transaction.docChanged) {
      marks = marks
        .map((mark) => ({ ...mark, from: transaction.changes.mapPos(mark.from, 1), to: transaction.changes.mapPos(mark.to, -1) }))
        .filter((mark) => mark.to > mark.from);
    }
    for (const effect of transaction.effects) if (effect.is(setAgentMarks)) marks = effect.value;
    if (marks === value.marks) return { marks, decorations: value.decorations.map(transaction.changes) };
    return { marks, decorations: build(marks) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

function build(marks: AgentMark[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sorted = [...marks].sort((left, right) => left.from - right.from || left.to - right.to);
  const now = Date.now();
  const entries: Array<{ from: number; to: number; decoration: Decoration }> = [];
  for (const mark of sorted) {
    const delay = `${-(now - mark.at)}ms`;
    const style = `--mark: ${mark.color}; animation-delay: ${delay}`;
    entries.push({ from: mark.from, to: mark.to, decoration: Decoration.mark({ class: 'cm-agent-ink', attributes: { style } }) });
    entries.push({ from: mark.to, to: mark.to, decoration: Decoration.widget({ widget: new FlagWidget(mark.label, mark.color, delay), side: 1 }) });
  }
  entries.sort((left, right) => left.from - right.from || (left.from === left.to ? 1 : 0) - (right.from === right.to ? 1 : 0));
  for (const entry of entries) builder.add(entry.from, entry.to, entry.decoration);
  return builder.finish();
}

class FlagWidget extends WidgetType {
  constructor(readonly label: string, readonly color: string, readonly delay: string) {
    super();
  }

  override eq(other: FlagWidget): boolean {
    return other.label === this.label && other.color === this.color;
  }

  toDOM(): HTMLElement {
    // A zero-width anchor keeps the flag from reflowing the text it labels.
    const anchor = document.createElement('span');
    anchor.className = 'cm-agent-flag-anchor';
    anchor.setAttribute('aria-hidden', 'true');
    const flag = document.createElement('span');
    flag.className = 'cm-agent-flag';
    flag.textContent = this.label;
    flag.style.setProperty('--mark', this.color);
    flag.style.animationDelay = this.delay;
    anchor.append(flag);
    return anchor;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}
