import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { editsBetween, mergeIntoText, offsetMapper } from '../src';

function textDoc(content: string): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc();
  const text = doc.getText('t');
  text.insert(0, content);
  return { doc, text };
}

describe('editsBetween', () => {
  it('groups replacements into single edits', () => {
    expect(editsBetween('hello world', 'hello there world')).toEqual([{ at: 6, remove: 0, insert: 'there ' }]);
    expect(editsBetween('abc', 'axc')).toEqual([{ at: 1, remove: 1, insert: 'x' }]);
  });
});

describe('offsetMapper', () => {
  it('shifts offsets past foreign insertions and collapses foreign deletions', () => {
    const map = offsetMapper('abcdef', 'XXabef');
    expect(map(0)).toBe(0); // before the foreign insertion
    expect(map(2)).toBe(4);
    expect(map(3)).toBe(4); // inside the deleted "cd"
    expect(map(6)).toBe(6);
  });
});

describe('mergeIntoText', () => {
  it('applies a disk edit when nothing else changed', () => {
    const { doc, text } = textDoc('line one\nline two\n');
    doc.transact(() => mergeIntoText(text, 'line one\nline two\n', 'line one\nline 2\n'));
    expect(text.toString()).toBe('line one\nline 2\n');
  });

  it('keeps a concurrent remote edit in another paragraph', () => {
    const base = 'Intro paragraph.\n\nMethods paragraph.\n';
    const { doc, text } = textDoc(base);
    // A remote peer edits Methods; the agent's disk write edits Intro.
    text.insert(base.indexOf('Methods') + 'Methods'.length, ' (revised)');
    const disk = 'Intro paragraph, sharpened.\n\nMethods paragraph.\n';
    let ranges: ReturnType<typeof mergeIntoText> = [];
    doc.transact(() => {
      ranges = mergeIntoText(text, base, disk);
    });
    expect(text.toString()).toBe('Intro paragraph, sharpened.\n\nMethods (revised) paragraph.\n');
    expect(ranges).toHaveLength(1);
    const start = Y.createAbsolutePositionFromRelativePosition(ranges[0]!.start, doc)!.index;
    const end = Y.createAbsolutePositionFromRelativePosition(ranges[0]!.end, doc)!.index;
    expect(text.toString().slice(start, end)).toBe(', sharpened');
  });

  it('converges with a remote peer through Yjs updates', () => {
    const base = 'alpha\nbeta\ngamma\n';
    const left = textDoc(base);
    const right = new Y.Doc();
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left.doc));
    const rightText = right.getText('t');

    rightText.insert(base.indexOf('gamma'), 'GAMMA-');
    left.doc.transact(() => mergeIntoText(left.text, base, 'ALPHA\nbeta\ngamma\n'));

    Y.applyUpdate(right, Y.encodeStateAsUpdate(left.doc));
    Y.applyUpdate(left.doc, Y.encodeStateAsUpdate(right));
    expect(left.text.toString()).toBe('ALPHA\nbeta\nGAMMA-gamma\n');
    expect(rightText.toString()).toBe(left.text.toString());
  });
});
