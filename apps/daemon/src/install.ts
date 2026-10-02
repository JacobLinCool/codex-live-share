import { execFileSync } from 'node:child_process';
import { MARKETPLACE_REPO, PLUGIN_SELECTOR } from '@codex-live-share/signal-core';

/**
 * Registers the plugin marketplace with Codex and installs Live Share. People
 * normally do this from the Codex Plugins tab; this is the CLI shortcut and
 * the way to test a local checkout (`--source /path/to/repo`).
 */
export function install(source: string = MARKETPLACE_REPO): void {
  run(['plugin', 'marketplace', 'add', source], true);
  run(['plugin', 'add', PLUGIN_SELECTOR], true);
  console.log(`Installed ${PLUGIN_SELECTOR} from ${source}. Restart Codex, then in any folder say: "Start live share".`);
}

function run(args: string[], tolerateExisting: boolean): void {
  try {
    execFileSync('codex', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120_000 });
  } catch (error) {
    const output = String((error as { stderr?: string }).stderr ?? '') + String((error as { stdout?: string }).stdout ?? '');
    if (tolerateExisting && /already/iu.test(output)) return;
    throw new Error(`codex ${args.join(' ')} failed: ${output.trim() || (error instanceof Error ? error.message : String(error))}`);
  }
}
