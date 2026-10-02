import { Bot, Check, Link2, Mic, MicOff, PanelLeft, PanelRight, Power } from 'lucide-react';
import { useState } from 'react';
import type { Member, SessionInfo } from '@codex-live-share/protocol';
import type { Presence } from '../lib/hooks';
import { t } from '../lib/i18n';
import type { MicState } from '../lib/transcription';

interface TopBarProps {
  session: SessionInfo;
  presence: Presence[];
  mic: MicState;
  onMic: () => void;
  filesOpen: boolean;
  onToggleFiles: () => void;
  transcriptOpen: boolean;
  onToggleTranscript: () => void;
  onEnd: () => void;
}

export function TopBar(props: TopBarProps) {
  const { session, presence, mic } = props;
  const [copied, setCopied] = useState(false);

  const copyInvite = async () => {
    if (!session.inviteUrl) return;
    const text = `${session.inviteUrl}\n${t('inviteHint', { invite: session.inviteUrl })}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt(t('copyInvite'), text);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1_600);
  };

  const micLabel = !session.asr.provider ? t('micUnavailable') : mic.kind === 'on' ? t('micStop') : mic.kind === 'starting' ? t('micStarting') : t('micStart');
  const level = mic.kind === 'on' ? mic.level : 0;

  return (
    <header className="topbar">
      <button type="button" className="icon-button" onClick={props.onToggleFiles} aria-pressed={props.filesOpen} aria-label={t('showFiles')} title={t('showFiles')}>
        <PanelLeft size={16} strokeWidth={1.75} />
      </button>
      <div className="title">
        <span className="folder">{session.folderName}</span>
        {session.code ? (
          <button
            type="button"
            className="room"
            onClick={copyInvite}
            disabled={!session.inviteUrl}
            title={`${session.inviteUrl ? t('inviteHint', { invite: session.inviteUrl }) : t('invitePending')}\n${session.mode === 'direct' ? t('modeDirect') : t('modeHosted')}`}
          >
            <span className="room-code">{session.code}</span>
            {copied ? <Check size={13} strokeWidth={2} /> : <Link2 size={13} strokeWidth={1.75} />}
            <span className="room-action">{copied ? t('copied') : t('copyInvite')}</span>
          </button>
        ) : null}
      </div>

      <People session={session} presence={presence} />

      <div className="actions">
        <button
          type="button"
          className="mic"
          data-state={mic.kind}
          disabled={mic.kind === 'starting'}
          data-needs-key={!session.asr.provider || undefined}
          onClick={props.onMic}
          aria-pressed={mic.kind === 'on'}
          aria-label={micLabel}
          title={mic.kind === 'error' ? mic.message : micLabel}
          style={{ '--level': level.toFixed(2) } as React.CSSProperties}
        >
          {mic.kind === 'on' ? <Mic size={15} strokeWidth={2} /> : <MicOff size={15} strokeWidth={1.75} />}
        </button>
        <button type="button" className="icon-button" onClick={props.onToggleTranscript} aria-pressed={props.transcriptOpen} aria-label={t('showTranscript')} title={t('showTranscript')}>
          <PanelRight size={16} strokeWidth={1.75} />
        </button>
        <button type="button" className="icon-button danger" onClick={props.onEnd} aria-label={session.role === 'host' ? t('end') : t('leave')} title={session.role === 'host' ? t('end') : t('leave')}>
          <Power size={15} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  );
}

function People({ session, presence }: { session: SessionInfo; presence: Presence[] }) {
  const daemonOf = new Map(presence.filter((entry) => entry.user.kind === 'daemon').map((entry) => [entry.user.peerId, entry]));
  const members: Member[] = session.members.length ? session.members : [{ ...session.self, isHost: session.role === 'host', access: session.access }];
  return (
    <ul className="people" aria-label={t('peopleHere')}>
      {members.map((member) => {
        const self = member.peerId === session.self.peerId;
        const online = self || session.connected.includes(member.peerId);
        const agent = daemonOf.get(member.peerId)?.agent;
        const working = agent && agent.state !== 'idle';
        const file = presence.find((entry) => entry.user.kind === 'human' && entry.user.peerId === member.peerId)?.file;
        const details = [
          self ? `${member.name} (${t('you')})` : member.name,
          member.isHost ? t('host') : null,
          member.access === 'view' ? t('viewOnly') : null,
          online ? null : t('offline'),
          file ? t('onFile', { file }) : null,
          working ? `${t('agentOf', { name: member.name })}: ${agent.state === 'editing' && agent.file ? t('agentEditing', { file: agent.file }) : t('agentPlanning')}` : null,
        ].filter(Boolean).join(' · ');
        return (
          <li key={member.peerId} className="person" data-online={online || undefined} data-working={working || undefined} title={details} style={{ '--who': member.color } as React.CSSProperties}>
            <span className="avatar">{[...member.name][0]?.toUpperCase()}</span>
            {working ? <span className="agent-badge"><Bot size={10} strokeWidth={2.25} /></span> : null}
            <span className="sr-only">{details}</span>
          </li>
        );
      })}
    </ul>
  );
}
