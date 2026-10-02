import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import * as Y from 'yjs';
import {
  agentLabel,
  appendEdit,
  createPeerId,
  createPlan,
  createRoomCode,
  createSecret,
  editsOf,
  encodeControl,
  finishPlan,
  isRecord,
  metaOf,
  normalizeDisplayName,
  normalizeRoomCode,
  parseLocalClientMessage,
  plansOf,
  readMeta,
  transcriptOf,
  updatePlanItem,
  validatePlanDraft,
  type Access,
  type AgentActivity,
  type Identity,
  type Plan,
  type PlanDraftItem,
  type PlanItemStatus,
  type SessionInfo,
  type SessionStatus,
  type TranscriptLine,
} from '@codex-live-share/protocol';
import { FolderSync, type LocalTextEdit } from '@codex-live-share/sync';
import { issueTranscriptionToken, type IssuedToken } from './asr';
import { BIN_DIR, resolveAsr, saveConfig, type ConnectionMode, type UserConfig } from './config';
import { DirectSignal } from './direct-signal';
import { DocHub, type Endpoint } from './doc-hub';
import { PeerMesh } from './peer-mesh';
import { QuickTunnel, resolveCloudflared } from './tunnel';
import { hostedToken } from './account';
import { removeRunEntry, writeRunEntry } from './registry';
import { ShareStore, type ShareRecord } from './share-store';
import { hookAgentSession } from './agent-context';
import { Coordination } from './coordination';

const SAVE_DEBOUNCE_MS = 1_000;
const AGENT_EDIT_WINDOW_MS = 120_000;
const MAX_TRANSCRIPT_TEXT = 4_000;

export interface DaemonOptions {
  folder: string;
  role: 'host' | 'guest';
  /** Guests: the room and the signal server named by the invite. */
  invite: Invite | null;
  /** Hosts: how a new share connects. A resumed share keeps its mode. */
  mode: ConnectionMode;
  config: UserConfig;
  log: (message: string) => void;
}

export interface Invite {
  code: string;
  signalUrl: string;
}

export class DaemonError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Everything one shared folder needs on this machine: the doc replica, the
 * disk bridge, the peer mesh, and the state the UI, MCP tools, and hooks read.
 */
export class Daemon {
  readonly folder: string;
  readonly role: 'host' | 'guest';
  readonly token: string;
  readonly doc = new Y.Doc();
  readonly hub = new DocHub(this.doc);
  readonly store: ShareStore;
  readonly identity: Identity;
  readonly coordination: Coordination;
  port = 0;

  #directSignal: DirectSignal | null = null;
  #tunnelState: 'none' | 'opening' | 'open' | 'failed' = 'none';
  #tunnelError: string | null = null;
  #notice: { code: string; message: string; at: string } | null = null;
  #tunnel: QuickTunnel | null = null;
  #config: UserConfig;
  #record!: ShareRecord;
  #mesh!: PeerMesh;
  #sync: FolderSync | null = null;
  #status: SessionStatus = 'starting';
  #error: string | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #listeners = new Set<() => void>();
  #activity: AgentActivity | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Paths an agent announced (via PreToolUse) it is about to edit. */
  #agentTouched = new Map<string, number>();
  #lineCounter = 0;
  #stopping: Promise<void> | null = null;
  readonly #resumed: boolean;
  readonly #log: (message: string) => void;
  readonly #warnings: string[] = [];
  onStop: (() => void) | null = null;

  constructor(options: DaemonOptions) {
    this.folder = options.folder;
    this.role = options.role;
    this.#config = options.config;
    this.#log = options.log;
    this.store = new ShareStore(options.folder);
    const previous = this.store.read();
    const invite = options.invite;
    // Resume only a share that actually got going; a start that failed early left no doc behind.
    const resumable = Boolean(previous && !previous.ended && previous.role === options.role && previous.mode
      && (options.role === 'host' || previous.code === invite?.code)
      && this.store.loadDoc(this.doc));
    if (resumable && previous) {
      this.#record = previous;
      // A direct host gets a new tunnel address on every start; the newest invite wins.
      if (invite) this.#record.signalUrl = invite.signalUrl;
    } else {
      if (options.role === 'guest' && !invite) throw new DaemonError('INVITE_REQUIRED', 'An invite link is required to join.');
      const mode: ConnectionMode = invite ? (isTunnelUrl(invite.signalUrl) ? 'direct' : 'hosted') : options.mode;
      this.#record = {
        folder: options.folder,
        role: options.role,
        code: invite ? invite.code : createRoomCode(),
        mode,
        signalUrl: invite ? invite.signalUrl : mode === 'hosted' ? this.#config.hostedSignalUrl : null,
        peerId: createPeerId(),
        secret: createSecret(),
        docId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        ended: false,
      };
      this.store.clearDoc();
      if (options.role === 'host') {
        const meta = metaOf(this.doc);
        this.doc.transact(() => {
          meta.set('docId', this.#record.docId);
          meta.set('createdAt', this.#record.createdAt);
          meta.set('rootName', basename(options.folder));
        });
      }
    }
    this.#resumed = resumable;
    this.#record.localToken ??= randomBytes(24).toString('hex');
    this.token = this.#record.localToken;
    this.identity = { peerId: this.#record.peerId, name: this.#config.name, color: this.#config.color };
    this.coordination = new Coordination(this.doc, this.identity);
  }

  get code(): string {
    return this.#record.code;
  }

  get access(): Access {
    return this.#mesh?.self?.access ?? (this.role === 'host' ? 'edit' : 'view');
  }

  get uiUrl(): string {
    return `http://127.0.0.1:${this.port}/?t=${this.token}`;
  }

  get mode(): ConnectionMode {
    return this.#record.mode;
  }

  /** Null while a direct host's tunnel is not up yet. */
  get inviteUrl(): string | null {
    const base = this.role === 'host' && this.mode === 'direct' ? this.#tunnel?.url ?? null : this.#record.signalUrl;
    return base ? new URL(`/j/${this.code}`, base).toString() : null;
  }

  /** Called once the HTTP server is listening. */
  async start(): Promise<void> {
    if (this.mode === 'hosted' && this.role === 'host' && !this.#resumed && !hostedToken(this.#record.signalUrl ?? this.#config.hostedSignalUrl)) {
      throw new DaemonError('AUTH_REQUIRED', 'Hosted mode needs a signed-in host. Call live_share_login first (or use direct mode, which needs no account).');
    }
    this.store.write(this.#record);
    writeRunEntry({
      folder: this.folder,
      pid: process.pid,
      port: this.port,
      token: this.token,
      code: this.code,
      role: this.role,
      startedAt: new Date().toISOString(),
    });
    this.doc.on('update', () => this.#scheduleSave());
    this.#publishAwareness();

    const sync = new FolderSync({
      root: this.folder,
      doc: this.doc,
      readOnly: () => this.access !== 'edit',
      onLocalEdit: (edit) => this.#onLocalEdit(edit),
      onWarning: (message) => this.#warn(message),
    });
    if (this.role === 'host' || this.#resumed) {
      await sync.reconcile('disk');
      await sync.start();
      this.#sync = sync;
    } else {
      await this.#assertEmptyFolder(sync);
    }

    const signalUrl = this.role === 'host' && this.mode === 'direct' ? await this.#openDirectRoom() : this.#record.signalUrl;
    if (!signalUrl) throw new DaemonError('NO_SIGNAL', 'This share has no signal server address; end it and start again.');
    const hosted = this.mode === 'hosted';
    const authToken = hosted && this.role === 'host' ? hostedToken(signalUrl) : null;
    this.#mesh = new PeerMesh({
      signalUrl,
      hosted,
      authToken,
      code: this.code,
      action: this.role === 'host' ? 'create' : 'join',
      self: this.identity,
      secret: this.#record.secret,
      log: this.#log,
    });
    this.#mesh.on('status', (status, detail) => {
      this.#status = status;
      this.#error = status === 'error' || status === 'denied' ? detail : null;
      if (status === 'ended' && this.role === 'guest') void this.stop('ended');
      if (status === 'denied') void this.stop('denied');
      this.#changed();
    });
    this.#mesh.on('members', () => this.#changed());
    this.#mesh.on('notice', (code, message) => {
      this.#notice = { code, message, at: new Date().toISOString() };
      this.#warn(message);
      this.#changed();
    });
    this.#mesh.on('knocks', () => this.#changed());
    this.#mesh.on('open', (peerId) => {
      this.hub.add(this.#peerEndpoint(peerId));
      this.#changed();
    });
    this.#mesh.on('close', (peerId) => {
      this.hub.remove(peerId);
      this.#changed();
    });
    this.#mesh.on('message', (peerId, frame) => this.hub.receive(peerId, frame));
    if (!this.#sync) {
      // Only a peer's state counts; a browser tab opened early has nothing to give.
      this.hub.onSynced = (endpointId) => {
        if (this.#mesh.member(endpointId)) void this.#mirrorAfterFirstSync(sync, endpointId);
      };
    }
    await this.#mesh.start();
  }

  /**
   * Direct mode: run the room ourselves and publish it through a Cloudflare
   * quick tunnel. Our own mesh talks to it over loopback.
   */
  async #openDirectRoom(): Promise<string> {
    const signal = new DirectSignal(this.code, this.store.roomStatePath);
    const port = await signal.listen();
    this.#directSignal = signal;
    const local = `http://127.0.0.1:${port}`;
    // The room works locally right away; the public invite appears once the tunnel is up
    // (the first run also downloads cloudflared).
    this.#tunnelState = 'opening';
    void (async () => {
      try {
        const binary = await resolveCloudflared(BIN_DIR, this.#log);
        if (this.#stopping) return;
        const tunnel = new QuickTunnel(binary, local, this.store.tunnelConfigPath, this.#log);
        tunnel.on('url', (url) => this.#onTunnelUrl(url));
        tunnel.on('down', () => {
          this.#tunnelState = 'opening';
          this.#changed();
        });
        this.#tunnel = tunnel;
        await tunnel.start();
      } catch (error) {
        this.#tunnelState = 'failed';
        this.#tunnelError = `Could not open the invite link (${error instanceof Error ? error.message : String(error)}). End this share and start again in hosted mode.`;
        this.#warn(this.#tunnelError);
        this.#changed();
      }
    })();
    return local;
  }

  #onTunnelUrl(url: string): void {
    this.#tunnelState = 'open';
    this.#record.signalUrl = url;
    this.store.write(this.#record);
    this.#log(`Invite: ${this.inviteUrl}`);
    // Guests keep their data channels; tell them where signaling moved for their next reconnect.
    this.#mesh?.broadcast(encodeControl({ type: 'signal-url', url }));
    this.#changed();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  session(): SessionInfo {
    const asr = resolveAsr(this.#config);
    return {
      self: this.identity,
      role: this.role,
      access: this.access,
      code: this.code,
      mode: this.mode,
      inviteUrl: this.inviteUrl,
      nameConfirmed: this.#config.nameConfirmed,
      status: this.#status,
      error: this.#error ?? this.#tunnelError ?? this.#notice?.message ?? null,
      folderName: basename(this.folder),
      members: this.#mesh?.members ?? [],
      connected: this.#mesh?.connectedPeers ?? [],
      knocks: this.role === 'host' ? this.#mesh?.knocks ?? [] : [],
      asr: { provider: asr?.provider ?? null },
    };
  }

  /** A browser tab on this machine. */
  localEndpoint(id: string, send: (frame: Uint8Array) => void): Endpoint {
    return {
      id,
      kind: 'local',
      send,
      canWrite: () => this.access === 'edit',
      onControl: (value) => this.#onLocalControl(value),
    };
  }

  async transcriptionToken(): Promise<IssuedToken> {
    const asr = resolveAsr(this.#config);
    if (!asr) {
      throw new DaemonError('ASR_NOT_CONFIGURED', 'No transcription key yet. Press the microphone in the editor to add an OpenAI or Gemini API key.');
    }
    return issueTranscriptionToken(asr.provider, asr.apiKey);
  }

  // ---- Agent-facing operations (MCP tools and hooks) ----

  status(): Record<string, unknown> {
    const session = this.session();
    const agents = new Map<string, AgentActivity>();
    for (const state of this.hub.awareness.getStates().values()) {
      if (isRecord(state) && isRecord(state['user']) && state['user']['kind'] === 'daemon' && isRecord(state['agent'])) {
        agents.set(String(state['user']['peerId']), state['agent'] as unknown as AgentActivity);
      }
    }
    const editing: Record<string, string[]> = {};
    for (const state of this.hub.awareness.getStates().values()) {
      if (isRecord(state) && isRecord(state['user']) && state['user']['kind'] === 'human' && typeof state['file'] === 'string') {
        (editing[state['file']] ??= []).push(String(state['user']['name']));
      }
    }
    return {
      folder: this.folder,
      room: this.code,
      role: this.role,
      mode: this.mode,
      invite: this.mode === 'direct' && this.role === 'host' ? this.#tunnelState : 'ready',
      relay: this.mode === 'hosted' ? (this.#mesh?.relayed ? 'in use (Cloudflare TURN)' : 'available if a direct path fails') : 'none (direct peer-to-peer only)',
      notice: this.#notice,
      access: this.access,
      status: session.status,
      error: session.error,
      uiUrl: this.uiUrl,
      inviteUrl: this.inviteUrl,
      you: this.identity.name,
      people: session.members.map((member) => ({
        name: member.name,
        host: member.isHost,
        access: member.access,
        online: member.peerId === this.identity.peerId || session.connected.includes(member.peerId),
        agent: agents.get(member.peerId) ?? null,
      })),
      pendingKnocks: session.knocks.map((knock) => knock.name),
      openFilesByPerson: editing,
      activePlans: [...plansOf(this.doc).values()].filter((plan) => plan.status === 'active').map(describePlan),
      recentAgentEdits: editsOf(this.doc).toArray().slice(-10).map((edit) => ({ by: edit.kind === 'agent' ? agentLabel(edit.actor.name) : edit.actor.name, path: edit.path, at: edit.at })),
      transcriptLines: transcriptOf(this.doc).length,
      warnings: this.#warnings.slice(-5),
    };
  }

  publishPlan(items: PlanDraftItem[], agentSession: string): Plan {
    this.#assertWritable();
    const reason = validatePlanDraft(items);
    if (reason) throw new DaemonError('INVALID_PLAN', reason);
    const plans = plansOf(this.doc);
    const plan = createPlan(this.identity, items, agentSession);
    this.doc.transact(() => {
      for (const existing of this.#ownActivePlans(agentSession)) plans.set(existing.id, finishPlan(existing, 'abandoned'));
      plans.set(plan.id, plan);
    });
    this.#setActivity('planning', plan.items[0]?.files[0] ?? null);
    return plan;
  }

  updatePlan(planId: string, index: number, status: PlanItemStatus, agentSession: string): Plan {
    this.#assertWritable();
    const plans = plansOf(this.doc);
    const plan = plans.get(planId);
    if (!plan || plan.owner.peerId !== this.identity.peerId || plan.agentSession !== agentSession) throw new DaemonError('PLAN_NOT_FOUND', `This chat has no plan ${planId}.`);
    let next: Plan;
    try {
      next = updatePlanItem(plan, index, status);
    } catch (error) {
      throw new DaemonError('INVALID_ITEM', error instanceof Error ? error.message : String(error));
    }
    plans.set(planId, next);
    if (next.status !== 'active' && this.#ownActivePlans().length === 0) this.#setActivity('idle', null);
    return next;
  }

  finishPlan(planId: string, status: 'done' | 'abandoned', agentSession: string): Plan {
    this.#assertWritable();
    const plans = plansOf(this.doc);
    const plan = plans.get(planId);
    if (!plan || plan.owner.peerId !== this.identity.peerId || plan.agentSession !== agentSession) throw new DaemonError('PLAN_NOT_FOUND', `This chat has no plan ${planId}.`);
    const next = finishPlan(plan, status);
    plans.set(planId, next);
    if (this.#ownActivePlans().length === 0) this.#setActivity('idle', null);
    return next;
  }

  sendAgentMessage(session: string, toPlan: string, text: string): { id: string; status: 'queued' } {
    this.#assertWritable();
    return this.coordination.send(session, toPlan, text);
  }

  readTranscript(query: { after?: number; limit?: number; sinceMinutes?: number }): {
    lines: TranscriptLine[];
    cursor: number;
    hasMore: boolean;
    total: number;
    live: Array<{ speaker: string; text: string }>;
  } {
    const all = transcriptOf(this.doc).toArray();
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 500);
    let start = query.after ?? 0;
    if (query.after === undefined && query.sinceMinutes !== undefined) {
      const since = Date.now() - query.sinceMinutes * 60_000;
      start = all.findIndex((line) => Date.parse(line.at) >= since);
      if (start < 0) start = all.length;
    }
    const lines = all.slice(start, start + limit);
    const live: Array<{ speaker: string; text: string }> = [];
    for (const state of this.hub.awareness.getStates().values()) {
      if (isRecord(state) && isRecord(state['user']) && typeof state['interim'] === 'string' && state['interim']) {
        live.push({ speaker: String(state['user']['name']), text: state['interim'] });
      }
    }
    return { lines, cursor: start + lines.length, hasMore: start + lines.length < all.length, total: all.length, live };
  }

  /** Codex hook bridge; returns a denial reason or null to allow. */
  hook(event: string, payload: Record<string, unknown>): { deny?: string; context?: string; continueWith?: string } {
    const session = hookAgentSession(payload);
    if (event === 'session-start') {
      return { context: sessionContext(this) };
    }
    // Never associate a hook with some other chat's plan when identity is absent.
    if (!session) return event === 'pre-tool-use' && editedPaths(payload, this.folder).length
      ? { deny: 'Live Share could not identify this chat. Restart Codex with the plugin hooks enabled.' } : {};
    if (event === 'session-end') {
      this.doc.transact(() => {
        for (const plan of this.#ownActivePlans(session)) plansOf(this.doc).set(plan.id, finishPlan(plan, 'abandoned'));
      });
      if (this.#ownActivePlans().length === 0) this.#setActivity('idle', null);
      return {};
    }
    if (event === 'user-prompt-submit') {
      const context = this.coordination.context(session);
      return context ? { context } : {};
    }
    if (event === 'stop') {
      if (payload['stop_hook_active'] === true) return {};
      const context = this.coordination.context(session);
      const plan = this.#ownActivePlans(session)[0];
      const reminder = plan ? `Your live share plan ${plan.id} has open items. Mark finished items done with plan_update, or close it with plan_finish (abandoned if stopped early).` : null;
      const continueWith = [context, reminder].filter(Boolean).join('\n');
      return continueWith ? { continueWith } : {};
    }
    const paths = editedPaths(payload, this.folder);
    if (event === 'pre-tool-use') {
      if (paths.length === 0) {
        const context = this.coordination.context(session);
        return context ? { context } : {};
      }
      if (this.access !== 'edit') {
        return { deny: `This live share session is view-only for you; ${this.code}'s host has not granted edit access, so files here cannot be changed.` };
      }
      if (this.#ownActivePlans(session).length === 0) {
        return {
          deny: [
            `This folder is in a Codex Live Share session (room ${this.code}) and other people can see your work.`,
            'Before editing, publish a short plan with the live_share plan_publish tool: 1-5 one-line items, each at most 30 words or CJK characters, with the files each item touches.',
            'Then mark items in_progress/done with plan_update as you go.',
          ].join(' '),
        };
      }
      const notice = this.coordination.notice(session, paths);
      // Context alone would still execute the pending patch. Pause only for a
      // new overlap so the model can reconsider before the edit runs.
      if (notice.overlap && notice.context) return { deny: notice.context };
      const now = Date.now();
      for (const path of paths) this.#agentTouched.set(path, now);
      this.#setActivity('editing', paths[0] ?? null);
      return notice.context ? { context: notice.context } : {};
    }
    if (event === 'post-tool-use') {
      for (const path of paths) this.#sync?.touch(path);
      const context = this.coordination.context(session);
      return context ? { context } : {};
    }
    return {};
  }

  /** Guests: point at the signal server from a newer invite (the host restarted and got a new tunnel). */
  retarget(signalUrl: string): void {
    if (this.role !== 'guest' || this.#record.signalUrl === signalUrl) return;
    this.#record.signalUrl = signalUrl;
    this.store.write(this.#record);
    this.#mesh.setSignalUrl(signalUrl);
    this.#changed();
  }

  /** Host only: answer a knock by name or peer id. */
  answerKnock(who: string, decision: 'edit' | 'view' | 'deny'): string {
    if (this.role !== 'host') throw new DaemonError('NOT_HOST', 'Only the host can admit people.');
    const knocks = this.#mesh.knocks;
    const match = knocks.find((knock) => knock.peerId === who)
      ?? knocks.find((knock) => knock.name.toLowerCase() === who.trim().toLowerCase())
      ?? (who.trim() === '' && knocks.length === 1 ? knocks[0] : undefined);
    if (!match) {
      throw new DaemonError('NO_KNOCK', knocks.length ? `Waiting to join: ${knocks.map((knock) => knock.name).join(', ')}.` : 'Nobody is waiting to join.');
    }
    if (decision === 'deny') this.#mesh.deny(match.peerId);
    else this.#mesh.admit(match.peerId, decision);
    return match.name;
  }

  async end(): Promise<{ transcriptPath: string | null }> {
    if (this.role === 'host') this.#mesh.end();
    const transcriptPath = this.#exportTranscript();
    this.#record.ended = true;
    this.store.write(this.#record);
    await this.stop('ended');
    return { transcriptPath };
  }

  async stop(reason: string): Promise<void> {
    this.#stopping ??= (async () => {
      this.#log(`Stopping (${reason})`);
      if (reason === 'ended' || reason === 'denied') {
        this.#record.ended = true;
        this.store.write(this.#record);
        this.#exportTranscript();
      }
      this.#status = reason === 'denied' ? 'denied' : reason === 'ended' ? 'ended' : this.#status;
      this.#changed();
      await this.#sync?.stop().catch(() => {});
      this.#flushSave();
      this.#mesh?.close();
      this.#tunnel?.stop();
      this.#directSignal?.close();
      if (this.#idleTimer) clearTimeout(this.#idleTimer);
      this.hub.destroy();
      removeRunEntry(this.folder);
      this.onStop?.();
    })();
    return this.#stopping;
  }

  // ---- Internals ----

  async #mirrorAfterFirstSync(sync: FolderSync, endpointId: string): Promise<void> {
    if (this.#sync) return;
    this.#sync = sync;
    this.hub.onSynced = null;
    const meta = readMeta(this.doc);
    if (meta) {
      this.#record.docId = meta.docId;
      this.store.write(this.#record);
    }
    this.#log(`Initial sync from ${this.#mesh.member(endpointId)?.name ?? endpointId}; writing files`);
    await sync.reconcile('doc');
    await sync.start();
    this.#changed();
  }

  async #assertEmptyFolder(sync: FolderSync): Promise<void> {
    const existing = await sync.scan();
    if (existing.size > 0) {
      throw new DaemonError(
        'FOLDER_NOT_EMPTY',
        `To join, open an empty folder: this one already has ${existing.size} file(s) (e.g. ${[...existing][0]}). Joining copies the shared files here.`,
      );
    }
  }

  #peerEndpoint(peerId: string): Endpoint {
    return {
      id: peerId,
      kind: 'peer',
      send: (frame) => this.#mesh.send(peerId, frame),
      canWrite: () => this.#mesh.member(peerId)?.access === 'edit',
      onControl: (value) => {
        if (isRecord(value) && value['type'] === 'signal-url' && typeof value['url'] === 'string') {
          if (this.role === 'guest' && this.#mesh.member(peerId)?.isHost && isTunnelUrl(value['url'])) {
            this.#record.signalUrl = value['url'];
            this.store.write(this.#record);
            this.#mesh.setSignalUrl(value['url']);
            this.#changed();
          }
          return;
        }
        // View-only peers cannot write the doc; the host appends their transcript lines for them.
        if (!isRecord(value) || value['type'] !== 'transcript-line' || this.role !== 'host') return;
        const member = this.#mesh.member(peerId);
        const line = value['line'];
        if (!member || !isRecord(line) || typeof line['text'] !== 'string' || typeof line['id'] !== 'string') return;
        this.#appendLine({
          id: line['id'],
          speaker: { peerId: member.peerId, name: member.name, color: member.color },
          text: line['text'].slice(0, MAX_TRANSCRIPT_TEXT),
          at: new Date().toISOString(),
        });
      },
    };
  }

  #onLocalControl(value: unknown): void {
    if (isRecord(value) && value['type'] === 'transcript' && typeof value['text'] === 'string') {
      const text = value['text'].trim().slice(0, MAX_TRANSCRIPT_TEXT);
      if (!text) return;
      this.#lineCounter += 1;
      const line: TranscriptLine = {
        id: `${this.identity.peerId.slice(0, 8)}-${Date.now().toString(36)}-${this.#lineCounter}`,
        speaker: this.identity,
        text,
        at: new Date().toISOString(),
      };
      if (this.access === 'edit') this.#appendLine(line);
      else this.#mesh.broadcast(encodeControl({ type: 'transcript-line', line }));
      return;
    }
    const message = parseLocalClientMessage(value);
    if (!message) return;
    switch (message.type) {
      case 'admit':
        if (this.role === 'host') this.#mesh.admit(message.peerId, message.access);
        break;
      case 'deny':
        if (this.role === 'host') this.#mesh.deny(message.peerId);
        break;
      case 'end':
        void this.end();
        break;
      case 'rename': {
        const name = normalizeDisplayName(message.name);
        if (!name) return;
        this.#config = { ...this.#config, name, nameConfirmed: true };
        saveConfig(this.#config);
        if (name !== this.identity.name) {
          this.identity.name = name;
          this.#publishAwareness();
          this.#mesh.rename(name);
        }
        this.#changed();
        break;
      }
      case 'set-asr-key': {
        // Stays on this machine: written to the 0600 config file, never into the shared doc.
        const asr = { ...this.#config.asr, provider: message.provider };
        if (message.provider === 'openai') asr.openaiApiKey = message.key;
        else asr.geminiApiKey = message.key;
        this.#config = { ...this.#config, asr };
        saveConfig(this.#config);
        this.#changed();
        break;
      }
    }
  }

  #appendLine(line: TranscriptLine): void {
    const transcript = transcriptOf(this.doc);
    if (transcript.toArray().slice(-50).some((existing) => existing.id === line.id)) return;
    transcript.push([line]);
  }

  #onLocalEdit(edit: LocalTextEdit): void {
    if (this.access !== 'edit') return;
    const touched = this.#agentTouched.get(edit.path);
    const byAgent = this.#ownActivePlans().length > 0 || (touched !== undefined && Date.now() - touched < AGENT_EDIT_WINDOW_MS);
    appendEdit(this.doc, {
      id: crypto.randomUUID().slice(0, 8),
      actor: this.identity,
      kind: byAgent ? 'agent' : 'human',
      path: edit.path,
      at: new Date().toISOString(),
      ranges: edit.ranges,
    });
    if (byAgent) this.#setActivity('editing', edit.path);
  }

  #ownActivePlans(session?: string): Plan[] {
    return [...plansOf(this.doc).values()].filter((plan) => plan.owner.peerId === this.identity.peerId && plan.status === 'active' && (session === undefined || plan.agentSession === session));
  }

  #setActivity(state: AgentActivity['state'], file: string | null): void {
    this.#activity = { label: agentLabel(this.identity.name), state, file, at: new Date().toISOString() };
    this.#publishAwareness();
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    if (state === 'editing') {
      this.#idleTimer = setTimeout(() => {
        if (this.#ownActivePlans().length === 0) this.#setActivity('idle', null);
      }, AGENT_EDIT_WINDOW_MS);
    }
  }

  #publishAwareness(): void {
    this.hub.setLocalState({ user: { ...this.identity, kind: 'daemon' }, agent: this.#activity });
  }

  #assertWritable(): void {
    if (this.access !== 'edit') throw new DaemonError('VIEW_ONLY', 'You have view-only access in this session.');
    if (!this.#sync) throw new DaemonError('NOT_READY', 'Still waiting for the shared files to arrive.');
  }

  #exportTranscript(): string | null {
    const lines = transcriptOf(this.doc).toArray();
    if (!lines.length) return null;
    const body = lines.map((line) => `- **${line.speaker.name}** (${line.at.slice(11, 19)}): ${line.text}`).join('\n');
    return this.store.writeTranscript(`# Live share ${this.code} transcript\n\n${body}\n`);
  }

  #scheduleSave(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => this.#flushSave(), SAVE_DEBOUNCE_MS);
  }

  #flushSave(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    try {
      this.store.saveDoc(this.doc);
    } catch (error) {
      this.#log(`Could not save session state: ${String(error)}`);
    }
  }

  #warn(message: string): void {
    this.#log(message);
    this.#warnings.push(message);
    if (this.#warnings.length > 20) this.#warnings.shift();
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}

export function describePlan(plan: Plan): Record<string, unknown> {
  return {
    planId: plan.id,
    by: agentLabel(plan.owner.name),
    agentSession: plan.agentSession,
    status: plan.status,
    items: plan.items.map((item, index) => ({ n: index + 1, text: item.text, files: item.files, status: item.status })),
    updatedAt: plan.updatedAt,
  };
}

function sessionContext(daemon: Daemon): string {
  return [
    `This folder is shared live with other people (Codex Live Share room ${daemon.code}); edits sync to them immediately.`,
    'Publish a plan before editing and update its items as you finish. Hooks supply relevant overlaps and agent messages automatically; no routine status polling is needed.',
  ].join(' ');
}

/** Paths an edit tool is about to touch, relative to the shared folder. */
export function editedPaths(payload: Record<string, unknown>, folder: string): string[] {
  const input = isRecord(payload['tool_input']) ? payload['tool_input'] : {};
  const cwd = typeof payload['cwd'] === 'string' ? payload['cwd'] : folder;
  const candidates: string[] = [];
  for (const key of ['file_path', 'path']) if (typeof input[key] === 'string') candidates.push(input[key]);
  const patch = typeof input['command'] === 'string' ? input['command'] : typeof input['patch'] === 'string' ? input['patch'] : typeof input['input'] === 'string' ? input['input'] : '';
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)) candidates.push(match[1]!.trim());
  for (const match of patch.matchAll(/^\*\*\* Move to: (.+)$/gmu)) candidates.push(match[1]!.trim());
  const result = new Set<string>();
  for (const candidate of candidates) {
    const absolute = candidate.startsWith('/') ? candidate : `${cwd.replace(/\/$/u, '')}/${candidate}`;
    const normalized = absolute.split('/').reduce<string[]>((parts, part) => {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
      return parts;
    }, []).join('/');
    const root = folder.replace(/^\//u, '');
    if (normalized.startsWith(`${root}/`)) result.add(normalized.slice(root.length + 1));
  }
  return [...result];
}

export function isTunnelUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.trycloudflare.com');
  } catch {
    return false;
  }
}

/** An invite is a link (either mode) or, for hosted mode, a bare room code. */
export function parseInvite(input: string, hostedSignalUrl: string): Invite | null {
  const text = input.trim();
  const bare = normalizeRoomCode(text);
  if (bare) return { code: bare, signalUrl: new URL(hostedSignalUrl).origin };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const match = /^\/j\/([A-Za-z0-9]{6})\/?$/u.exec(url.pathname);
  const code = match ? normalizeRoomCode(match[1]!) : null;
  if (!code || (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')) return null;
  return { code, signalUrl: url.origin };
}
