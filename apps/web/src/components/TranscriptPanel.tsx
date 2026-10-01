import { X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { transcriptOf, type TranscriptLine } from '@codex-live-share/protocol';
import type { Presence } from '../lib/hooks';
import { useYType } from '../lib/hooks';
import { formatClock, t } from '../lib/i18n';
import type { LiveSession } from '../lib/session';

interface TranscriptPanelProps {
  live: LiveSession;
  presence: Presence[];
  selfPeerId: string;
  onClose: () => void;
}

/** Lines grouped into turns by speaker, with what people are saying right now at the bottom. */
export function TranscriptPanel({ live, presence, selfPeerId, onClose }: TranscriptPanelProps) {
  const transcript = useYType(transcriptOf(live.doc));
  const lines = transcript.toArray();
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const speaking = presence.filter((entry) => entry.interim);

  const turns: Array<{ speaker: TranscriptLine['speaker']; at: string; lines: TranscriptLine[] }> = [];
  for (const line of lines) {
    const last = turns.at(-1);
    if (last && last.speaker.peerId === line.speaker.peerId && Date.parse(line.at) - Date.parse(last.lines.at(-1)!.at) < 90_000) {
      last.lines.push(line);
    } else {
      turns.push({ speaker: line.speaker, at: line.at, lines: [line] });
    }
  }

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onScroll = () => {
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <aside className="transcript" aria-label={t('transcript')}>
      <div className="panel-title">
        {t('transcript')}
        <button type="button" className="icon-button small" onClick={onClose} aria-label={t('closePanel')}>
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div className="transcript-scroll" ref={scroller} aria-live="polite">
        {turns.length === 0 && speaking.length === 0 ? <p className="panel-empty">{t('transcriptEmpty')}</p> : null}
        {turns.map((turn) => (
          <div key={turn.lines[0]!.id} className="turn" style={{ '--who': turn.speaker.color } as React.CSSProperties}>
            <div className="turn-head">
              <span className="turn-name">{turn.speaker.peerId === selfPeerId ? `${turn.speaker.name} (${t('you')})` : turn.speaker.name}</span>
              <time dateTime={turn.at}>{formatClock(turn.at)}</time>
            </div>
            <p className="turn-text">{turn.lines.map((line) => line.text).join(' ')}</p>
          </div>
        ))}
        {speaking.map((entry) => (
          <div key={entry.clientId} className="turn live" style={{ '--who': entry.user.color } as React.CSSProperties}>
            <div className="turn-head">
              <span className="turn-name">{entry.user.name}</span>
              <span className="live-dot">{t('speakingNow')}</span>
            </div>
            <p className="turn-text">{entry.interim}</p>
          </div>
        ))}
      </div>
      <p className="panel-foot">{t('transcriptAgentHint')}</p>
    </aside>
  );
}
