import { FilePen } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { SessionInfo } from '@codex-live-share/protocol';
import { FileTree } from './components/FileTree';
import { FileView } from './components/FileView';
import { PlanStrip } from './components/PlanStrip';
import { TopBar } from './components/TopBar';
import { TranscriptPanel } from './components/TranscriptPanel';
import { useLiveSession, usePresence } from './lib/hooks';
import { t } from './lib/i18n';
import type { LiveSession } from './lib/session';
import { useTranscription } from './lib/transcription';

const NARROW = '(max-width: 760px)';
const WIDE = '(min-width: 1180px)';

export function App({ live }: { live: LiveSession }) {
  const { session, connection, synced } = useLiveSession(live);
  const presence = usePresence(live);
  const { state: mic, toggle: toggleMic } = useTranscription(live);
  const [selected, setSelected] = useState<string | null>(() => remembered());
  const [filesOpen, setFilesOpen] = useState(() => !window.matchMedia(NARROW).matches);
  const [transcriptOpen, setTranscriptOpen] = useState(() => window.matchMedia(WIDE).matches);
  const [askKey, setAskKey] = useState(false);
  const narrow = useMedia(NARROW);

  // Publish who this tab is; y-codemirror reads name and color for remote cursors.
  useEffect(() => {
    if (!session) return;
    const { self } = session;
    live.awareness.setLocalStateField('user', { ...self, kind: 'human', colorLight: `${self.color}33` });
  }, [live, session?.self.peerId, session?.self.name, session?.self.color]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback((path: string) => {
    setSelected(path);
    remember(path);
    if (window.matchMedia(NARROW).matches) setFilesOpen(false);
  }, []);

  if (!session) {
    return <Splash message={connection === 'closed' ? t('statusDaemonLost') : t('statusConnecting')} />;
  }

  const end = () => {
    if (window.confirm(session.role === 'host' ? t('endConfirm') : t('leaveConfirm'))) live.control({ type: 'end' });
  };
  const waitingForFiles = session.role === 'guest' && !live.doc.getMap('files').size;
  const readOnly = session.access !== 'edit';

  return (
    <div className="app" data-narrow={narrow || undefined} data-files={filesOpen || undefined} data-transcript={transcriptOpen || undefined}>
      <TopBar
        session={session}
        presence={presence}
        mic={mic}
        onMic={() => (session.asr.provider ? toggleMic() : setAskKey(true))}
        filesOpen={filesOpen}
        onToggleFiles={() => setFilesOpen((value) => !value)}
        transcriptOpen={transcriptOpen}
        onToggleTranscript={() => setTranscriptOpen((value) => !value)}
        onEnd={end}
      />
      <Banners session={session} connection={connection} mic={mic} live={live} />
      <Setup session={session} live={live} askKey={askKey && !session.asr.provider} onKeyDone={() => setAskKey(false)} />
      <PlanStrip live={live} selfPeerId={session.self.peerId} onOpenFile={open} />
      <div className="body">
        {filesOpen ? (
          <FileTree
            live={live}
            selected={selected}
            presence={presence}
            selfPeerId={session.self.peerId}
            waiting={waitingForFiles || !synced}
            onSelect={open}
          />
        ) : null}
        <main className="main">
          {selected && live.doc.getMap('files').has(selected) ? (
            <FileView key={selected} live={live} path={selected} readOnly={readOnly} selfPeerId={session.self.peerId} />
          ) : (
            <div className="empty">
              <FilePen size={22} strokeWidth={1.5} />
              <p className="empty-title">{waitingForFiles ? t('waitingFiles') : t('openAFile')}</p>
              <p className="empty-hint">{t('openAFileHint')}</p>
            </div>
          )}
        </main>
        {narrow && (filesOpen || transcriptOpen) ? (
          <button
            type="button"
            className="scrim"
            aria-label={t('closePanel')}
            onClick={() => {
              setFilesOpen(false);
              setTranscriptOpen(false);
            }}
          />
        ) : null}
        {transcriptOpen ? (
          <TranscriptPanel live={live} presence={presence} selfPeerId={session.self.peerId} onClose={() => setTranscriptOpen(false)} />
        ) : null}
      </div>
    </div>
  );
}

function Banners({ session, connection, mic, live }: { session: SessionInfo; connection: string; mic: ReturnType<typeof useTranscription>['state']; live: LiveSession }) {
  const banners: React.ReactNode[] = [];
  if (connection === 'closed') banners.push(<div key="daemon" className="banner warn">{t('statusDaemonLost')}</div>);
  const status: Partial<Record<SessionInfo['status'], string>> = {
    connecting: t('statusConnecting'),
    reconnecting: t('statusReconnecting'),
    waiting: t('statusWaiting'),
    denied: t('statusDenied'),
    ended: t('statusEnded'),
    error: t('statusError', { error: session.error ?? '' }),
  };
  const text = status[session.status];
  if (text) banners.push(<div key="status" className="banner" data-tone={session.status === 'error' || session.status === 'denied' ? 'bad' : 'info'}>{text}</div>);
  else if (session.error) banners.push(<div key="problem" className="banner" data-tone="bad">{session.error}</div>);
  if (mic.kind === 'error') banners.push(<div key="mic" className="banner" data-tone="bad">{mic.denied ? t('micDenied') : mic.message}</div>);
  for (const knock of session.knocks) {
    banners.push(
      <div key={knock.peerId} className="banner knock" style={{ '--who': knock.color } as React.CSSProperties}>
        <span className="knock-avatar">{[...knock.name][0]?.toUpperCase()}</span>
        <span className="knock-text">{t('knock', { name: knock.name })}</span>
        <span className="knock-actions">
          <button type="button" className="button primary" onClick={() => live.control({ type: 'admit', peerId: knock.peerId, access: 'edit' })}>{t('admitEdit')}</button>
          <button type="button" className="button" onClick={() => live.control({ type: 'admit', peerId: knock.peerId, access: 'view' })}>{t('admitView')}</button>
          <button type="button" className="button quiet" onClick={() => live.control({ type: 'deny', peerId: knock.peerId })}>{t('deny')}</button>
        </span>
      </div>,
    );
  }
  return banners.length ? <div className="banners" role="status">{banners}</div> : null;
}

/** First-run questions, asked inline where they matter instead of in an installer. */
function Setup({ session, live, askKey, onKeyDone }: { session: SessionInfo; live: LiveSession; askKey: boolean; onKeyDone: () => void }) {
  const [name, setName] = useState(session.self.name);
  const [key, setKey] = useState('');
  if (!session.nameConfirmed) {
    return (
      <form
        className="banner setup"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) live.control({ type: 'rename', name: name.trim() });
        }}
      >
        <label className="setup-text" htmlFor="setup-name">{t('nameIntro')}</label>
        <input id="setup-name" className="field" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} autoComplete="name" />
        <button type="submit" className="button primary">{t('nameSave')}</button>
      </form>
    );
  }
  if (!askKey) return null;
  const save = () => {
    const value = key.trim();
    if (value.length < 16) return;
    live.control({ type: 'set-asr-key', provider: value.startsWith('AIza') ? 'gemini' : 'openai', key: value });
    setKey('');
    onKeyDone();
  };
  return (
    <form
      className="banner setup"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label className="setup-text" htmlFor="setup-key">{t('keyIntro')}</label>
      <input
        id="setup-key"
        className="field"
        type="password"
        value={key}
        placeholder={t('keyPlaceholder')}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        onChange={(event) => setKey(event.target.value)}
      />
      <button type="submit" className="button primary" disabled={key.trim().length < 16}>{t('keySave')}</button>
      <button type="button" className="button quiet" onClick={onKeyDone}>{t('cancel')}</button>
    </form>
  );
}

export function Splash({ message }: { message: string }) {
  return (
    <div className="splash">
      <div className="splash-mark" aria-hidden="true"><span /><span /></div>
      <p>{message}</p>
    </div>
  );
}

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function remembered(): string | null {
  try {
    return localStorage.getItem('live-share-file');
  } catch {
    return null;
  }
}

function remember(path: string): void {
  try {
    localStorage.setItem('live-share-file', path);
  } catch {
    // Per-viewer convenience only.
  }
}
