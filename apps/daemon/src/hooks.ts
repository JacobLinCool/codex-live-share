import { realpathSync } from 'node:fs';
import { callDaemon } from './client';
import { findRunEntry } from './registry';

type HookEvent = 'pre-tool-use' | 'post-tool-use' | 'session-start' | 'stop';

const EVENT_NAMES: Record<HookEvent, string> = {
  'pre-tool-use': 'PreToolUse',
  'post-tool-use': 'PostToolUse',
  'session-start': 'SessionStart',
  stop: 'Stop',
};

/**
 * Codex hook entry point. Outside a shared folder, or if the daemon cannot be
 * reached, it stays silent and allows everything: a live share problem must
 * never block ordinary Codex work.
 */
export async function runHook(event: string): Promise<void> {
  if (!(event in EVENT_NAMES)) return;
  const raw = await readStdin();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const cwd = typeof payload['cwd'] === 'string' ? payload['cwd'] : process.cwd();
  let folder: string;
  try {
    folder = realpathSync(cwd);
  } catch {
    return;
  }
  const entry = findRunEntry(folder);
  if (!entry) return;
  payload['cwd'] = folder;
  let result: { deny?: string; context?: string; continueWith?: string };
  try {
    result = await callDaemon(entry, 'hook', { event, payload }, 3_000);
  } catch {
    return;
  }
  const hookEventName = EVENT_NAMES[event as HookEvent];
  if (event === 'stop') {
    // Stop must always answer with JSON; one extra pass at most (Codex sets stop_hook_active after).
    process.stdout.write(JSON.stringify(result.continueWith ? { decision: 'block', reason: result.continueWith } : {}));
    return;
  }
  if (result.deny) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason: result.deny },
    }));
  } else if (result.context) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: result.context } }));
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
