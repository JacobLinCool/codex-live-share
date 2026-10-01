import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { blobsOf, filesOf, isBlobRef } from '@codex-live-share/protocol';
import { useYType } from '../lib/hooks';
import { formatSize, t } from '../lib/i18n';
import type { LiveSession } from '../lib/session';
import { Editor } from './Editor';

interface FileViewProps {
  live: LiveSession;
  path: string;
  readOnly: boolean;
  selfPeerId: string;
}

export function FileView({ live, path, readOnly, selfPeerId }: FileViewProps) {
  const files = useYType(filesOf(live.doc));
  const value = files.get(path);
  const isMarkdown = /\.(md|markdown)$/iu.test(path);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  useEffect(() => setMode('edit'), [path]);

  const crumbs = path.split('/');
  return (
    <div className="file-view">
      <div className="file-bar">
        <span className="crumbs">
          {crumbs.map((part, index) => (
            <span key={index} className={index === crumbs.length - 1 ? 'crumb current' : 'crumb'}>{part}</span>
          ))}
        </span>
        {isMarkdown && value instanceof Y.Text ? (
          <div className="segmented" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'edit'} onClick={() => setMode('edit')}>{t('edit')}</button>
            <button type="button" role="tab" aria-selected={mode === 'preview'} onClick={() => setMode('preview')}>{t('preview')}</button>
          </div>
        ) : null}
      </div>
      {value instanceof Y.Text ? (
        mode === 'preview' ? <MarkdownPreview text={value} /> : <Editor live={live} path={path} text={value} readOnly={readOnly} selfPeerId={selfPeerId} />
      ) : isBlobRef(value) ? (
        <BlobView live={live} path={path} hash={value.hash} size={value.size} />
      ) : null}
    </div>
  );
}

function MarkdownPreview({ text }: { text: Y.Text }) {
  useYType(text);
  const source = text.toString();
  // Collaborators' content is untrusted: sanitize before it reaches the DOM.
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(source, { async: false })), [source]);
  return <article className="preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

function BlobView({ live, path, hash, size }: { live: LiveSession; path: string; hash: string; size: number }) {
  const blobs = useYType(blobsOf(live.doc));
  const bytes = blobs.get(hash);
  const image = /\.(png|jpe?g|gif|webp)$/iu.test(path);
  const url = useMemo(() => (bytes && image ? URL.createObjectURL(new Blob([bytes as BlobPart])) : null), [bytes, image]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  return (
    <div className="blob-view">
      {url ? <img src={url} alt={path} /> : null}
      <p>{t('binaryFile', { size: formatSize(size) })}</p>
    </div>
  );
}
