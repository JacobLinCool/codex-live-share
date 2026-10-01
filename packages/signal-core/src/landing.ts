export const MARKETPLACE_REPO = 'JacobLinCool/codex-live-share';
export const PLUGIN_SELECTOR = 'live-share@codex-live-share';

/**
 * The page an invite link opens: how to get from a link to a shared folder
 * in Codex. Served by the hosted Worker and by a host daemon in direct mode.
 */
export function landingPage(code: string | null, origin: string): string {
  const invite = code ? `${origin}/j/${code}` : null;
  const install = `codex plugin marketplace add ${MARKETPLACE_REPO} && codex plugin add ${PLUGIN_SELECTOR}`;
  const say = invite ? `Join live share ${invite}` : 'Start live share';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${code ? `Join ${code} · ` : ''}Codex Live Share</title>
<style>
  :root { --bg: #f7f7f5; --panel: #ffffff; --ink: #1c1c1a; --muted: #5f5f5a; --line: #e4e4df; --accent: #2f63e0; --code: #f0f0ec; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161615; --panel: #1f1f1e; --ink: #ededea; --muted: #a3a39d; --line: #30302e; --accent: #7aa2ff; --code: #2a2a28; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", system-ui, sans-serif; }
  main { max-width: 600px; margin: 0 auto; padding: 56px 16px; }
  h1 { font-size: 26px; line-height: 1.25; margin: 0 0 8px; }
  .code { font: 600 26px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: .12em; }
  p { color: var(--muted); margin: 0 0 28px; }
  ol { list-style: none; padding: 0; margin: 0; counter-reset: step; }
  li { counter-increment: step; position: relative; padding: 0 0 22px 40px; }
  li::before { content: counter(step); position: absolute; left: 0; top: 0; width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--line); background: var(--panel); display: grid; place-items: center; font-size: 13px; color: var(--muted); }
  li strong { display: block; margin-bottom: 6px; font-weight: 600; }
  .copy { display: flex; align-items: center; gap: 8px; background: var(--code); border: 1px solid var(--line); border-radius: 8px; padding: 8px 8px 8px 12px; margin-top: 6px; }
  .copy code { flex: 1; font: 13px/1.45 ui-monospace, "SF Mono", Menlo, monospace; overflow-wrap: anywhere; }
  button { font: inherit; font-size: 13px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 6px; padding: 4px 10px; cursor: pointer; flex: none; }
  button:hover { border-color: var(--accent); }
  .note { font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
<main>
  ${code
    ? `<h1>You're invited to room <span class="code">${code}</span></h1>
  <p>Edit one folder together in Codex. Everyone's Codex can work on it too, after posting a short plan everyone sees.</p>`
    : `<h1>Codex Live Share</h1>
  <p>Share a folder with people and their agents: live editing, shared plans, and a meeting transcript your Codex can read.</p>`}
  <ol>
    <li><strong>Install the Live Share plugin once</strong>
      <span class="note">In the Codex app, open Plugins, add the marketplace <code>${MARKETPLACE_REPO}</code>, and install Live Share. Or run:</span>
      <div class="copy"><code>${install}</code><button data-copy="${install}">Copy</button></div>
    </li>
    <li><strong>${code ? 'Open a new, empty folder as a Codex project' : 'Open the folder you want to share in Codex'}</strong>
      <span class="note">${code ? 'The shared files are copied into it, and you keep the copy afterwards.' : 'The whole folder is shared, except .git, node_modules, .env files, and anything in .gitignore.'}</span>
    </li>
    <li><strong>Tell your agent</strong>
      <div class="copy"><code>${say}</code><button data-copy="${say}">Copy</button></div>
    </li>
    <li><strong>${code ? 'Wait for the host to let you in' : 'Send the invite link it gives you'}</strong>
      <span class="note">The editor opens in Codex's side browser. Allow the microphone there to add your voice to the transcript.</span>
    </li>
  </ol>
</main>
<script>
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    });
  }
</script>
</body>
</html>`;
}

export const LANDING_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

export const STUN_SERVERS = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
