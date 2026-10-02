import { createInterface } from 'node:readline';
import { RpcError, awaitOutcome, callDaemon, requireDaemon, resolveFolder, spawnDaemon } from './client';
import { AccountError, accountSummary, startLogin } from './account';
import { loadConfig } from './config';
import { parseInvite } from './daemon';
import { findRunEntry } from './registry';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const VERSION = '0.1.0';

const folderProperty = {
  folder: {
    type: 'string',
    description: 'Absolute path of the workspace folder (your current working directory). Defaults to the MCP server cwd.',
  },
};

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
}

/**
 * The Codex-facing surface, as a dependency-free stdio MCP server. Each call
 * finds the daemon serving the workspace folder (starting one for start/join)
 * and forwards to its local RPC endpoint.
 */
export function createTools(cliPath: string): Tool[] {
  // A sign-in started by live_share_login keeps polling GitHub in this process.
  let pendingLogin: { userCode: string; verificationUri: string; result: Promise<string>; outcome: string | null } | null = null;
  return [
    {
      name: 'live_share_login',
      description:
        'Sign in to hosted mode with GitHub. Only needed to HOST in hosted mode (direct mode and guests need no account). Returns a short code and a GitHub URL: tell the user to open the URL, enter the code, and approve; then call live_share_account to confirm.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        if (pendingLogin && pendingLogin.outcome === null) {
          return `Sign-in already waiting: open ${pendingLogin.verificationUri} and enter ${pendingLogin.userCode}.`;
        }
        const login = await startLogin();
        const entry = { userCode: login.userCode, verificationUri: login.verificationUri, result: login.done, outcome: null as string | null };
        login.done.then(
          (name) => {
            entry.outcome = `Signed in as ${name}.`;
          },
          (error: unknown) => {
            entry.outcome = `Sign-in failed: ${error instanceof Error ? error.message : String(error)}`;
          },
        );
        pendingLogin = entry;
        return [
          `Open ${login.verificationUri} and enter the code ${login.userCode} to sign in with GitHub (expires in ${Math.round(login.expiresIn / 60)} minutes).`,
          'After approving, call live_share_account to confirm the sign-in and see the plan.',
        ].join('\n');
      },
    },
    {
      name: 'live_share_account',
      description: "The signed-in hosted-mode account: GitHub login, plan tier, its limits (hosted rooms, people per room, session length, monthly relay time), and this month's usage.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        if (pendingLogin && pendingLogin.outcome === null) {
          await Promise.race([pendingLogin.result.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 20_000))]);
          if (pendingLogin.outcome === null) {
            return `Still waiting for approval: open ${pendingLogin.verificationUri} and enter ${pendingLogin.userCode}.`;
          }
        }
        const lead = pendingLogin?.outcome ?? '';
        try {
          return [lead, JSON.stringify(await accountSummary(), null, 2)].filter(Boolean).join('\n');
        } catch (error) {
          if (error instanceof AccountError) throw new RpcError(error.code, error.message);
          throw error;
        }
      },
    },
    {
      name: 'live_share_start',
      description:
        'Share this workspace folder live with other people (Codex Live Share). Returns an invite link and a local editor URL. After calling, open the editor URL in the in-app browser (@Browser) so the user sees the shared editor, and give the user the invite link to send. Default mode "direct" needs no server: signaling runs on this machine through a free Cloudflare quick tunnel and peers connect directly. Use mode "hosted" only if the user asks or direct mode fails (it adds a relay for strict networks).',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['direct', 'hosted'], description: 'direct (default): peer-to-peer, no central server. hosted: our signal server with a TURN relay for networks that block direct connections.' },
          ...folderProperty,
        },
        additionalProperties: false,
      },
      async run(args) {
        const folder = resolveFolder(args['folder']);
        const existing = findRunEntry(folder);
        const mode = args['mode'] === 'hosted' ? 'hosted' : args['mode'] === 'direct' ? 'direct' : loadConfig().defaultMode;
        const entry = existing ?? (await spawnDaemon(cliPath, folder, { host: mode }));
        let status = existing ? await callDaemon<Record<string, unknown>>(entry, 'status') : await awaitOutcome(entry);
        // Direct mode publishes the invite once its tunnel is up (first run also downloads cloudflared).
        for (let waited = 0; waited < 75_000 && status['invite'] === 'opening'; waited += 1_000) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          status = await callDaemon<Record<string, unknown>>(entry, 'status');
        }
        return [
          existing ? `This folder is already being shared (room ${String(status['room'])}).` : `Live share started for ${folder}.`,
          `Editor (open in the in-app browser): ${String(status['uiUrl'])}`,
          status['inviteUrl']
            ? `Invite link for collaborators: ${String(status['inviteUrl'])}`
            : status['invite'] === 'failed'
              ? `The invite link could not be opened: ${String(status['error'])}`
              : 'The invite link is still being prepared; it will appear in the editor top bar. Call live_share_status in a minute to get it.',
          `Collaborators install the Live Share plugin, open an empty folder in Codex, and say: "Join live share ${String(status['inviteUrl'])}". You approve them in the editor.`,
          '',
          JSON.stringify(status, null, 2),
        ].join('\n');
      },
    },
    {
      name: 'live_share_join',
      description:
        "Join someone else's live share with the invite link they sent (https://….trycloudflare.com/j/CODE or a hosted link; a bare six-character code works only for hosted rooms). The workspace folder must be empty: the shared files are copied into it and kept in sync. The host must approve the request. After calling, open the returned editor URL in the in-app browser (@Browser).",
      inputSchema: {
        type: 'object',
        properties: { invite: { type: 'string', description: 'The invite link, e.g. https://word-word.trycloudflare.com/j/K7QF2M.' }, ...folderProperty },
        required: ['invite'],
        additionalProperties: false,
      },
      async run(args) {
        const raw = String(args['invite'] ?? args['code'] ?? '');
        const invite = parseInvite(raw, loadConfig().hostedSignalUrl);
        if (!invite) throw new RpcError('INVALID_INVITE', 'That is not a live share invite. Ask the host for the full invite link.');
        const code = invite.code;
        const folder = resolveFolder(args['folder']);
        const existing = findRunEntry(folder);
        if (existing && existing.code !== code) {
          throw new RpcError('ALREADY_SHARED', `${folder} is already in live share room ${existing.code}. End it first with live_share_end.`);
        }
        if (existing) await callDaemon(existing, 'retarget', { signalUrl: invite.signalUrl });
        const entry = existing ?? (await spawnDaemon(cliPath, folder, { join: raw }));
        const status = await awaitOutcome(entry);
        const state = String(status['status']);
        const lead = state === 'waiting'
          ? `Asked to join room ${code}; waiting for the host to approve.`
          : state === 'connected'
            ? `Joined room ${code}. Shared files are being copied into ${folder}.`
            : `Join status: ${state}${status['error'] ? ` (${String(status['error'])})` : ''}.`;
        return [lead, `Editor (open in the in-app browser): ${String(status['uiUrl'])}`, '', JSON.stringify(status, null, 2)].join('\n');
      },
    },
    {
      name: 'live_share_status',
      description:
        'Who is in the live share, which files each person has open, every agent\'s active plan, and recent agent edits. Check this before editing to avoid parts other agents are working on.',
      inputSchema: { type: 'object', properties: { ...folderProperty }, additionalProperties: false },
      async run(args) {
        const entry = requireDaemon(resolveFolder(args['folder']));
        return JSON.stringify(await callDaemon(entry, 'status'), null, 2);
      },
    },
    {
      name: 'read_transcript',
      description:
        'Read the live meeting transcript: what each participant said aloud, attributed by speaker. Use it when the user refers to "what we discussed". Pages forward with `after` (the returned cursor).',
      inputSchema: {
        type: 'object',
        properties: {
          since_minutes: { type: 'number', description: 'Only lines from the last N minutes (ignored when `after` is given).' },
          after: { type: 'number', description: 'Cursor from a previous call; returns lines after it.' },
          limit: { type: 'number', description: 'Max lines (default 200, max 500).' },
          ...folderProperty,
        },
        additionalProperties: false,
      },
      async run(args) {
        const entry = requireDaemon(resolveFolder(args['folder']));
        const result = await callDaemon<{
          lines: Array<{ speaker: { name: string }; text: string; at: string }>;
          cursor: number;
          hasMore: boolean;
          total: number;
          live: Array<{ speaker: string; text: string }>;
        }>(entry, 'read_transcript', {
          ...(typeof args['after'] === 'number' ? { after: args['after'] } : {}),
          ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
          ...(typeof args['since_minutes'] === 'number' ? { sinceMinutes: args['since_minutes'] } : {}),
        });
        if (!result.total) return 'The transcript is empty. Participants turn on their microphone in the live share editor to be transcribed.';
        const lines = result.lines.map((line) => `[${new Date(line.at).toLocaleTimeString('en-GB', { hour12: false })}] ${line.speaker.name}: ${line.text}`);
        const live = result.live.map((entry) => `(speaking now) ${entry.speaker}: ${entry.text}`);
        return [
          ...lines,
          ...live,
          '',
          `cursor=${result.cursor} hasMore=${result.hasMore} total=${result.total}`,
        ].join('\n');
      },
    },
    {
      name: 'plan_publish',
      description:
        'Required before editing shared files: publish a short plan everyone in the live share sees, labelled as your user\'s Codex. 1-5 items, each one line of at most 30 words or CJK characters, with the files it touches. Publishing replaces your previous plan. The first item starts as in_progress.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'One short line, e.g. "Tighten abstract to 150 words".' },
                files: { type: 'array', items: { type: 'string' }, description: 'Relative paths this item edits.' },
              },
              required: ['text'],
              additionalProperties: false,
            },
          },
          ...folderProperty,
        },
        required: ['items'],
        additionalProperties: false,
      },
      async run(args) {
        const entry = requireDaemon(resolveFolder(args['folder']));
        const plan = await callDaemon<Record<string, unknown>>(entry, 'plan_publish', { items: args['items'] });
        return `Plan ${String(plan['planId'])} published. Mark each item with plan_update as you go.\n${JSON.stringify(plan, null, 2)}`;
      },
    },
    {
      name: 'plan_update',
      description: 'Update one item of your published plan: in_progress when you start it, done when finished, dropped if skipped. Finishing the last open item completes the plan.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_id: { type: 'string' },
          item: { type: 'number', description: '1-based item number.' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'dropped'] },
          ...folderProperty,
        },
        required: ['plan_id', 'item', 'status'],
        additionalProperties: false,
      },
      async run(args) {
        const entry = requireDaemon(resolveFolder(args['folder']));
        const plan = await callDaemon(entry, 'plan_update', { planId: args['plan_id'], item: args['item'], status: args['status'] });
        return JSON.stringify(plan, null, 2);
      },
    },
    {
      name: 'plan_finish',
      description: 'Close your plan: done marks open items done; abandoned drops them (e.g. the user changed direction).',
      inputSchema: {
        type: 'object',
        properties: { plan_id: { type: 'string' }, status: { type: 'string', enum: ['done', 'abandoned'] }, ...folderProperty },
        required: ['plan_id'],
        additionalProperties: false,
      },
      async run(args) {
        const entry = requireDaemon(resolveFolder(args['folder']));
        return JSON.stringify(await callDaemon(entry, 'plan_finish', { planId: args['plan_id'], status: args['status'] ?? 'done' }), null, 2);
      },
    },
    {
      name: 'live_share_end',
      description: 'End live sharing for this folder. For the host this ends the session for everyone; a guest leaves and keeps their copy of the files. The transcript is saved locally.',
      inputSchema: { type: 'object', properties: { ...folderProperty }, additionalProperties: false },
      async run(args) {
        const entry = requireDaemon(resolveFolder(args['folder']));
        const result = await callDaemon<{ transcriptPath: string | null }>(entry, 'end', {}, 20_000);
        return `Live share ended.${result.transcriptPath ? ` Transcript saved to ${result.transcriptPath}` : ''}`;
      },
    },
  ];
}

type JsonRpcId = string | number;

export async function runMcpServer(cliPath: string): Promise<void> {
  const tools = createTools(cliPath);
  const write = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const reply = (id: JsonRpcId, result: unknown) => write({ id, result });
  const fail = (id: JsonRpcId, code: number, message: string) => write({ id, error: { code, message } });

  const handle = async (line: string): Promise<void> => {
    let message: { id?: JsonRpcId; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      write({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const { id, method, params = {} } = message;
    if (id === undefined || id === null) return; // Notifications need no answer.
    switch (method) {
      case 'initialize': {
        const requested = String(params['protocolVersion'] ?? '');
        reply(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'codex-live-share', version: VERSION },
          instructions:
            'Codex Live Share: the workspace folder may be shared live with other people and their agents. In a shared folder, publish a short plan (plan_publish) before editing, update it as you go, and read the meeting transcript (read_transcript) when the user refers to what was discussed.',
        });
        return;
      }
      case 'ping':
        reply(id, {});
        return;
      case 'tools/list':
        reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        return;
      case 'tools/call': {
        const tool = tools.find((candidate) => candidate.name === params['name']);
        if (!tool) {
          fail(id, -32602, `Unknown tool ${String(params['name'])}`);
          return;
        }
        try {
          const text = await tool.run((params['arguments'] ?? {}) as Record<string, unknown>);
          reply(id, { content: [{ type: 'text', text }] });
        } catch (error) {
          const text = error instanceof RpcError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
          reply(id, { content: [{ type: 'text', text }], isError: true });
        }
        return;
      }
      default:
        fail(id, -32601, `Method not found: ${String(method)}`);
    }
  };

  // Calls run concurrently; a join waiting on the host must not block pings.
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (line.trim()) void handle(line);
  });
  await new Promise<void>((resolve) => lines.once('close', resolve));
}
