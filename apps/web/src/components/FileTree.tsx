import { ChevronRight, File, FileImage, FileText, Folder } from 'lucide-react';
import { useMemo, useState } from 'react';
import { filesOf } from '@codex-live-share/protocol';
import type { Presence } from '../lib/hooks';
import { useYType } from '../lib/hooks';
import { t } from '../lib/i18n';
import type { LiveSession } from '../lib/session';

interface Node {
  name: string;
  path: string;
  children: Map<string, Node> | null;
}

interface FileTreeProps {
  live: LiveSession;
  selected: string | null;
  presence: Presence[];
  selfPeerId: string;
  waiting: boolean;
  onSelect: (path: string) => void;
}

export function FileTree({ live, selected, presence, selfPeerId, waiting, onSelect }: FileTreeProps) {
  const files = useYType(filesOf(live.doc));
  const paths = [...files.keys()].sort();
  const key = paths.join('\n');
  const tree = useMemo(() => buildTree(paths), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [closed, setClosed] = useState<Set<string>>(new Set());

  // Who is where: people by their open file, agents by the file they are editing.
  const here = new Map<string, Array<{ color: string; name: string; agent: boolean }>>();
  for (const entry of presence) {
    if (entry.user.peerId === selfPeerId && entry.user.kind === 'human') continue;
    const file = entry.user.kind === 'human' ? entry.file : entry.agent?.state === 'editing' ? entry.agent.file : null;
    if (!file) continue;
    const list = here.get(file) ?? [];
    list.push({ color: entry.user.color, name: entry.user.kind === 'human' ? entry.user.name : t('agentOf', { name: entry.user.name }), agent: entry.user.kind === 'daemon' });
    here.set(file, list);
  }

  const toggle = (path: string) => setClosed((previous) => {
    const next = new Set(previous);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  const render = (node: Node, depth: number): React.ReactNode => {
    if (node.children) {
      const isClosed = closed.has(node.path);
      return (
        <li key={node.path || '.'} role="treeitem" aria-expanded={!isClosed}>
          {node.path ? (
            <button type="button" className="tree-row" style={{ '--depth': depth } as React.CSSProperties} onClick={() => toggle(node.path)}>
              <ChevronRight className="chev" size={13} strokeWidth={2} data-open={!isClosed || undefined} />
              <Folder size={14} strokeWidth={1.75} />
              <span className="tree-name">{node.name}</span>
            </button>
          ) : null}
          {isClosed ? null : (
            <ul role="group">{[...node.children.values()].sort(sortNodes).map((child) => render(child, node.path ? depth + 1 : depth))}</ul>
          )}
        </li>
      );
    }
    const people = here.get(node.path) ?? [];
    return (
      <li key={node.path} role="treeitem" aria-selected={selected === node.path}>
        <button
          type="button"
          className="tree-row file"
          data-selected={selected === node.path || undefined}
          style={{ '--depth': depth } as React.CSSProperties}
          onClick={() => onSelect(node.path)}
        >
          <span className="chev-space" />
          {iconFor(node.name)}
          <span className="tree-name">{node.name}</span>
          {people.length ? (
            <span className="tree-who" title={people.map((person) => person.name).join(', ')}>
              {people.slice(0, 4).map((person, index) => (
                <span key={index} className="who-dot" data-agent={person.agent || undefined} style={{ '--who': person.color } as React.CSSProperties} />
              ))}
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  return (
    <nav className="files" aria-label={t('files')}>
      <div className="panel-title">{t('files')}</div>
      {paths.length ? (
        <ul className="tree" role="tree">{render(tree, 0)}</ul>
      ) : (
        <p className="panel-empty">{waiting ? t('waitingFiles') : t('filesEmpty')}</p>
      )}
    </nav>
  );
}

function buildTree(paths: string[]): Node {
  const root: Node = { name: '', path: '', children: new Map() };
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    parts.forEach((part, index) => {
      const leaf = index === parts.length - 1;
      const childPath = parts.slice(0, index + 1).join('/');
      let child = node.children!.get(part);
      if (!child) {
        child = { name: part, path: childPath, children: leaf ? null : new Map() };
        node.children!.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

function sortNodes(left: Node, right: Node): number {
  if (Boolean(left.children) !== Boolean(right.children)) return left.children ? -1 : 1;
  return left.name.localeCompare(right.name);
}

function iconFor(name: string) {
  if (/\.(png|jpe?g|gif|svg|webp|pdf|eps)$/iu.test(name)) return <FileImage size={14} strokeWidth={1.75} />;
  if (/\.(md|tex|txt|bib|markdown|rst)$/iu.test(name)) return <FileText size={14} strokeWidth={1.75} />;
  return <File size={14} strokeWidth={1.75} />;
}
