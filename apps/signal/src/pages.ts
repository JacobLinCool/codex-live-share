import { LEGAL_PAGES, TIERS, TIER_NAMES, type TierLimits, type TierName } from '@codex-live-share/signal-core';
import type { AccountSummary } from './account';

/** Security headers for site pages; avatars come from GitHub. */
export const PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https://avatars.githubusercontent.com; connect-src 'self'; form-action 'self' https://github.com; frame-ancestors 'none'",
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

export interface BillingLinks {
  /** True once checkout is connected; until then upgrade buttons say so. */
  enabled: boolean;
}

/** The account page: plan, this month's usage, open rooms, and plan changes. */
export function accountPage(account: AccountSummary | null, billing: BillingLinks, notice: string | null): string {
  if (!account) {
    return shell('Account', `
  <h1>Your account</h1>
  <p class="lead">An account is only needed to host rooms in hosted mode. Guests, and everyone using direct mode, never need one.</p>
  ${notice ? `<p class="notice" role="status">${escape(notice)}</p>` : ''}
  <a class="button primary" href="/auth/github?next=%2Faccount">${GITHUB_MARK}<span>Sign in with GitHub</span></a>
  <p class="fine">We receive your GitHub username, name and avatar, nothing else. See the <a href="/privacy">Privacy Policy</a>.</p>`);
  }
  const limits = account.limits;
  const usedHours = account.usage.relaySeconds / 3_600;
  const limitHours = limits.relaySecondsPerMonth / 3_600;
  const usedShare = Math.min(1, usedHours / limitHours);
  const roomsShare = Math.min(1, account.activeRooms.length / limits.rooms);
  const month = new Date(`${account.usage.month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const higher = TIER_NAMES.slice(TIER_NAMES.indexOf(account.tier) + 1);

  return shell('Account', `
  <header class="who">
    ${account.avatarUrl ? `<img class="avatar" src="${escape(sized(account.avatarUrl))}" width="48" height="48" alt="">` : `<span class="avatar initial" aria-hidden="true">${escape(account.login.slice(0, 1).toUpperCase())}</span>`}
    <div class="who-text">
      <h1>${escape(account.name ?? account.login)}</h1>
      <p class="muted">@${escape(account.login)} · signed in with GitHub</p>
    </div>
    <form method="post" action="/auth/logout"><button class="button quiet" type="submit">Sign out</button></form>
  </header>
  ${notice ? `<p class="notice" role="status">${escape(notice)}</p>` : ''}

  <section>
    <div class="section-head">
      <h2>${label(account.tier)} plan</h2>
      <span class="price">${price(limits)}</span>
    </div>
    <dl class="facts">
      ${fact('Hosted rooms at once', String(limits.rooms))}
      ${fact('People per room', String(limits.people))}
      ${fact('Session length', limits.sessionMs === null ? 'Unlimited' : `${limits.sessionMs / 3_600_000} hours`)}
      ${fact('Relay time per month', `${limitHours} hours`)}
    </dl>
  </section>

  <section>
    <h2>Usage in ${escape(month)}</h2>
    ${meter('Relay time', `${formatHours(usedHours)} of ${limitHours} h`, usedShare)}
    ${meter('Hosted rooms open now', `${account.activeRooms.length} of ${limits.rooms}`, roomsShare)}
    ${account.activeRooms.length ? `<p class="muted small">Open: ${account.activeRooms.map((code) => `<code>${escape(code)}</code>`).join(' ')}</p>` : ''}
    <p class="muted small">Relay time counts only when someone in your rooms cannot connect directly. Direct mode is always free and unmetered.</p>
  </section>

  ${higher.length ? `<section>
    <h2>Upgrade</h2>
    <div class="plans">${higher.map((tier) => planOption(tier, billing)).join('')}</div>
    ${billing.enabled ? '' : '<p class="muted small">Paid plans open soon. Until then, write to us if you need higher limits.</p>'}
  </section>` : ''}

  <section>
    <h2>Use it from Codex</h2>
    <p>In Codex, say <q>Start live share in hosted mode</q>. If your agent asks you to sign in, it will show a short code to enter on GitHub. Your plan applies to every room you host.</p>
  </section>`);
}

/** After checkout: confirms the plan, and waits briefly for the payment notice to arrive. */
export function billingSuccessPage(account: AccountSummary | null, expected: TierName | null): string {
  const active = account && (!expected || account.tier === expected);
  const tier = account?.tier ?? expected ?? 'plus';
  return shell('Thank you', `
  <div class="done">
    <span class="check" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    <h1 id="title">${active ? `You're on ${label(tier)}` : 'Payment received'}</h1>
    <p class="lead" id="detail">${active
      ? `Rooms you host from now on get the ${label(tier)} limits: ${describe(TIERS[tier])}.`
      : 'We are activating your plan. This usually takes a few seconds.'}</p>
    <p>Go back to Codex and say <q>Start live share in hosted mode</q>. Rooms that are already open keep their current limits until they end.</p>
    <p class="actions"><a class="button" href="/account">View your account</a></p>
    <p class="muted small">A receipt is on its way to your email. Questions about a charge? See the <a href="/refunds">Refund Policy</a>.</p>
  </div>
  ${active || !account ? '' : `<script>
  (async () => {
    const want = ${JSON.stringify(expected)};
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const response = await fetch('/api/me', { credentials: 'same-origin' }).catch(() => null);
      const body = response && response.ok ? await response.json() : null;
      if (body && body.account && (!want || body.account.tier === want)) { location.reload(); return; }
    }
    document.getElementById('detail').textContent = 'Your plan is taking longer than usual to activate. It will appear on your account within a few minutes; if it does not, contact us.';
  })();
  </script>`}`);
}

function planOption(tier: TierName, billing: BillingLinks): string {
  const limits = TIERS[tier];
  const action = billing.enabled
    ? `<a class="button primary" href="/billing/checkout?plan=${tier}">Upgrade to ${label(tier)}</a>`
    : '<button class="button" type="button" disabled>Coming soon</button>';
  return `<div class="plan">
      <div class="plan-head"><strong>${label(tier)}</strong><span class="price">${price(limits)}</span></div>
      <p class="muted small">${describe(limits)}</p>
      ${action}
    </div>`;
}

function describe(limits: TierLimits): string {
  return [
    `${limits.rooms} room${limits.rooms === 1 ? '' : 's'} at once`,
    `up to ${limits.people} people`,
    limits.sessionMs === null ? 'unlimited sessions' : `${limits.sessionMs / 3_600_000} h sessions`,
    `${limits.relaySecondsPerMonth / 3_600} h relay a month`,
  ].join(', ');
}

function fact(term: string, value: string): string {
  return `<div><dt>${term}</dt><dd>${value}</dd></div>`;
}

function meter(title: string, value: string, share: number): string {
  const tone = share >= 1 ? 'full' : share >= 0.8 ? 'high' : 'ok';
  return `<div class="meter" data-tone="${tone}">
      <div class="meter-head"><span>${title}</span><span class="num">${value}</span></div>
      <div class="bar" role="meter" aria-label="${title}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(share * 100)}"><span style="width:${(share * 100).toFixed(1)}%"></span></div>
    </div>`;
}

function price(limits: TierLimits): string {
  return limits.priceUsd ? `$${limits.priceUsd} / month` : 'Free';
}

function label(tier: TierName): string {
  return tier.slice(0, 1).toUpperCase() + tier.slice(1);
}

function formatHours(hours: number): string {
  return hours < 10 ? hours.toFixed(1) : String(Math.round(hours));
}

/** GitHub avatars take a size parameter; ask for 2x the displayed size. */
function sized(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('s', '96');
    return parsed.toString();
  } catch {
    return url;
  }
}

function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

const GITHUB_MARK = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

/** The site's page frame: same palette and type as the home and legal pages. */
function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${escape(title)} · Codex Live Share</title>
<style>
  :root { --bg: #f7f7f5; --panel: #ffffff; --ink: #1c1c1a; --muted: #5f5f5a; --line: #e4e4df; --accent: #2f63e0; --accent-ink: #ffffff; --track: #e9e9e4; --warn: #b26b00; --bad: #c8372a; --good: #1f8a4c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #161615; --panel: #1f1f1e; --ink: #ededea; --muted: #a3a39d; --line: #30302e; --accent: #7aa2ff; --accent-ink: #0d1626; --track: #2c2c2a; --warn: #f0b072; --bad: #ff8a7a; --good: #6fd39b; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  ::selection { background: color-mix(in srgb, var(--accent) 28%, transparent); }
  main { max-width: 640px; margin: 0 auto; padding: 32px 16px 64px; }
  .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 40px; font-size: 14px; }
  .top a { color: var(--ink); text-decoration: none; font-weight: 600; }
  .top a.plain { color: var(--muted); font-weight: 400; }
  h1 { font-size: 24px; line-height: 1.25; margin: 0; text-wrap: balance; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  p { margin: 0 0 14px; }
  .lead { color: var(--muted); font-size: 16px; margin: 8px 0 24px; max-width: 52ch; }
  .muted { color: var(--muted); }
  .small { font-size: 13px; }
  .fine { color: var(--muted); font-size: 13px; margin-top: 16px; }
  q { quotes: '“' '”'; }
  code { font: 13px ui-monospace, "SF Mono", Menlo, monospace; }
  a { color: var(--accent); text-underline-offset: 2px; }
  section { padding: 24px 0; border-top: 1px solid var(--line); }
  .who { display: flex; align-items: center; gap: 14px; padding-bottom: 24px; }
  .who-text { flex: 1; min-width: 0; }
  .who-text p { margin: 2px 0 0; font-size: 13px; }
  .who form { margin: 0; }
  .avatar { width: 48px; height: 48px; border-radius: 50%; flex: none; background: var(--track); }
  .avatar.initial { display: grid; place-items: center; font-weight: 700; color: var(--muted); }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .section-head h2 { margin: 0; }
  .price { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 14px; }
  .facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 24px; margin: 0; }
  .facts dt { color: var(--muted); font-size: 13px; }
  .facts dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
  .meter { margin-bottom: 16px; }
  .meter-head { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; margin-bottom: 6px; }
  .num { font-variant-numeric: tabular-nums; color: var(--muted); }
  .bar { height: 6px; border-radius: 3px; background: var(--track); overflow: hidden; }
  .bar span { display: block; height: 100%; border-radius: 3px; background: var(--accent); }
  .meter[data-tone="high"] .bar span { background: var(--warn); }
  .meter[data-tone="full"] .bar span { background: var(--bad); }
  .plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 12px; }
  .plan { padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); display: flex; flex-direction: column; gap: 4px; }
  .plan-head { display: flex; justify-content: space-between; align-items: baseline; }
  .plan .button { margin-top: 10px; align-self: flex-start; }
  .button { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); font: inherit; font-size: 14px; font-weight: 500; text-decoration: none; cursor: pointer; transition: border-color 150ms, filter 150ms; }
  .button:hover:not(:disabled) { border-color: var(--muted); }
  .button.primary { background: var(--ink); border-color: var(--ink); color: var(--bg); }
  .button.primary:hover { filter: brightness(1.15); }
  .button.quiet { border-color: transparent; background: transparent; color: var(--muted); height: 32px; padding: 0 10px; }
  .button.quiet:hover { color: var(--ink); border-color: var(--line); }
  .button:disabled { color: var(--muted); cursor: not-allowed; }
  .button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .notice { padding: 10px 12px; border-radius: 6px; background: var(--panel); border: 1px solid var(--line); font-size: 14px; }
  .done { padding-top: 8px; }
  .check { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; margin-bottom: 16px; color: var(--good); background: color-mix(in srgb, var(--good) 14%, transparent); }
  .actions { margin: 24px 0; }
  footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
  footer a { color: var(--muted); }
  @media (max-width: 520px) { .facts { grid-template-columns: 1fr; } .who { flex-wrap: wrap; } }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<main>
  <nav class="top"><a href="/">Codex Live Share</a><a class="plain" href="/account">Account</a></nav>
  ${body}
  <footer>${LEGAL_PAGES.map((page) => `<a href="/${page.slug}">${page.title}</a>`).join(' · ')}</footer>
</main>
</body>
</html>`;
}
