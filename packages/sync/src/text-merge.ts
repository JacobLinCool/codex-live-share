import diff from 'fast-diff';
import * as Y from 'yjs';

interface Edit {
  /** Offset in the base text. */
  at: number;
  remove: number;
  insert: string;
}

export interface InsertedRange {
  start: Y.RelativePosition;
  end: Y.RelativePosition;
}

/** The edits that turn `from` into `to`, as offsets in `from`. */
export function editsBetween(from: string, to: string): Edit[] {
  const edits: Edit[] = [];
  let at = 0;
  for (const [op, text] of diff(from, to)) {
    if (op === diff.EQUAL) {
      at += text.length;
    } else if (op === diff.DELETE) {
      const last = edits.at(-1);
      if (last && last.at + last.remove === at && last.insert === '') last.remove += text.length;
      else edits.push({ at, remove: text.length, insert: '' });
      at += text.length;
    } else {
      const last = edits.at(-1);
      if (last && last.at + last.remove === at) last.insert += text;
      else edits.push({ at, remove: 0, insert: text });
    }
  }
  return edits;
}

/**
 * Maps offsets in `base` to offsets in `current`, where `current` is `base`
 * plus edits made elsewhere. Offsets inside text removed elsewhere collapse to
 * the removal point; offsets at a foreign insertion land before it.
 */
export function offsetMapper(base: string, current: string): (offset: number) => number {
  const segments = diff(base, current);
  return (offset) => {
    let inBase = 0;
    let inCurrent = 0;
    for (const [op, text] of segments) {
      if (op === diff.EQUAL) {
        if (offset <= inBase + text.length) return inCurrent + (offset - inBase);
        inBase += text.length;
        inCurrent += text.length;
      } else if (op === diff.DELETE) {
        if (offset <= inBase + text.length) return inCurrent;
        inBase += text.length;
      } else {
        if (offset === inBase) return inCurrent;
        inCurrent += text.length;
      }
    }
    return inCurrent;
  };
}

/**
 * Three-way merge of a file edited on disk into a shared Y.Text.
 * `base` is what the file held when it was last in sync, `disk` is what it
 * holds now, and the Y.Text may have moved on since `base` through remote
 * edits. Disk edits are rebased over those remote edits and applied as small
 * operations, so concurrent work in other parts of the file survives.
 * Must run inside a transaction; returns ranges covering inserted text.
 */
export function mergeIntoText(text: Y.Text, base: string, disk: string): InsertedRange[] {
  const current = text.toString();
  const edits = editsBetween(base, disk);
  if (!edits.length) return [];
  const map = current === base ? (offset: number) => offset : offsetMapper(base, current);
  const placed = edits
    .map((edit) => {
      const start = map(edit.at);
      const end = edit.remove ? Math.max(start, map(edit.at + edit.remove)) : start;
      return { start, end, insert: edit.insert };
    })
    .sort((left, right) => right.start - left.start);
  const ranges: InsertedRange[] = [];
  let limit = Number.POSITIVE_INFINITY;
  for (const edit of placed) {
    // Rebased edits that overlap (only possible after a foreign deletion) are clipped.
    const end = Math.min(edit.end, limit);
    if (end > edit.start) text.delete(edit.start, end - edit.start);
    if (edit.insert) {
      text.insert(edit.start, edit.insert);
      ranges.push({
        start: Y.createRelativePositionFromTypeIndex(text, edit.start, 0),
        end: Y.createRelativePositionFromTypeIndex(text, edit.start + edit.insert.length, -1),
      });
    }
    limit = edit.start;
  }
  return ranges.reverse();
}
