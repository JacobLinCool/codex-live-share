import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, StreamLanguage, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';
import { decodeRelative, editsOf } from '@codex-live-share/protocol';
import { agentMarks, MARK_MS, setAgentMarks, type AgentMark } from '../lib/agent-marks';
import { t } from '../lib/i18n';
import type { LiveSession } from '../lib/session';

interface EditorProps {
  live: LiveSession;
  path: string;
  text: Y.Text;
  readOnly: boolean;
  selfPeerId: string;
}

const highlight = HighlightStyle.define([
  { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3], color: 'var(--syn-heading)', fontWeight: '600' },
  { tag: [tags.keyword, tags.tagName], color: 'var(--syn-keyword)' },
  { tag: [tags.comment, tags.lineComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-string)' },
  { tag: [tags.bracket, tags.squareBracket, tags.brace], color: 'var(--syn-bracket)' },
  { tag: [tags.atom, tags.number, tags.bool], color: 'var(--syn-atom)' },
  { tag: [tags.link, tags.url], color: 'var(--syn-link)', textDecoration: 'underline' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.monospace, color: 'var(--syn-string)' },
  { tag: [tags.processingInstruction, tags.meta], color: 'var(--syn-comment)' },
]);

function languageFor(path: string): Extension {
  const lower = path.toLowerCase();
  if (/\.(md|markdown|mdx)$/u.test(lower)) return markdown();
  if (/\.(tex|sty|cls|bib|bbx|cbx)$/u.test(lower)) return StreamLanguage.define(stex);
  return [];
}

/**
 * One CodeMirror view per open file, bound to its Y.Text. Remote cursors come
 * from y-codemirror.next; agent edits come from the shared edits log, which
 * carries relative positions so the highlight lands on the right characters
 * even after other people keep typing.
 */
export function Editor({ live, path, text, readOnly, selfPeerId }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const undoManager = new Y.UndoManager(text);
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          bracketMatching(),
          highlightSelectionMatches(),
          EditorView.lineWrapping,
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          languageFor(path),
          syntaxHighlighting(highlight),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          yCollab(text, live.awareness, { undoManager }),
          agentMarks,
          EditorView.contentAttributes.of({ 'aria-label': path, spellcheck: 'true', autocorrect: 'off' }),
        ],
      }),
    });

    // Agent ink: show recent agent edits on this file, then let them fade.
    const edits = editsOf(live.doc);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      const now = Date.now();
      const marks: AgentMark[] = [];
      for (const edit of edits.toArray()) {
        if (edit.path !== path || edit.kind !== 'agent') continue;
        const at = Date.parse(edit.at);
        if (now - at > MARK_MS) continue;
        for (const [start, end] of edit.ranges) {
          const from = Y.createAbsolutePositionFromRelativePosition(decodeRelative(start), live.doc);
          const to = Y.createAbsolutePositionFromRelativePosition(decodeRelative(end), live.doc);
          if (!from || !to || from.type !== text || to.index <= from.index) continue;
          marks.push({
            id: edit.id,
            from: from.index,
            to: Math.min(to.index, view.state.doc.length),
            color: edit.actor.color,
            label: edit.actor.peerId === selfPeerId ? t('yourAgent') : t('agentOf', { name: edit.actor.name }),
            at,
          });
        }
      }
      view.dispatch({ effects: setAgentMarks.of(marks) });
      if (timer) clearTimeout(timer);
      if (marks.length) timer = setTimeout(refresh, MARK_MS);
    };
    // The edits record arrives in the same transaction as the text, so read it after Y applies both.
    const onEdits = () => queueMicrotask(refresh);
    edits.observe(onEdits);
    refresh();
    live.awareness.setLocalStateField('file', path);

    return () => {
      edits.unobserve(onEdits);
      if (timer) clearTimeout(timer);
      undoManager.destroy();
      view.destroy();
    };
  }, [live, path, text, selfPeerId, readOnly]);

  useEffect(() => () => live.awareness.setLocalStateField('file', null), [live]);

  return (
    <div className="editor-wrap">
      {readOnly ? <div className="editor-note">{t('readOnlyFile')}</div> : null}
      <div className="editor" ref={host} />
    </div>
  );
}
