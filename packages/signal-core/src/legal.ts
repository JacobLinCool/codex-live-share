/** Where the legal pages live: served by the hosted Worker, and kept in the repository. */
export const LEGAL_PAGES = [
  { slug: 'terms', title: 'Terms of Service' },
  { slug: 'privacy', title: 'Privacy Policy' },
  { slug: 'refunds', title: 'Refund Policy' },
] as const;

export type LegalSlug = (typeof LEGAL_PAGES)[number]['slug'];

export const LEGAL_REPO_BASE = 'https://github.com/JacobLinCool/codex-live-share/blob/main/legal';

/** Links for page footers: same-site paths on the Worker, repository files elsewhere. */
export function legalHref(slug: LegalSlug, base: string | null): string {
  return base === null ? `/${slug}` : `${base}/${slug}.md`;
}

/**
 * Renders the small Markdown subset the policies use (headings, paragraphs,
 * bullet lists, bold, inline code) into a standalone page.
 */
export function legalPage(markdown: string, title: string): string {
  const body: string[] = [];
  // 0: no list open; 1: inside a top-level item; 2: inside a list nested in that item.
  let depth = 0;
  const closeLists = () => {
    if (depth === 2) body.push('</ul></li></ul>');
    if (depth === 1) body.push('</li></ul>');
    depth = 0;
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    const item = /^( *)- (.+)$/u.exec(line);
    if (item && item[1]!.length >= 2 && depth >= 1) {
      if (depth === 1) body.push('<ul>');
      body.push(`<li>${inline(item[2]!)}</li>`);
      depth = 2;
    } else if (item) {
      body.push(depth === 0 ? '<ul>' : depth === 2 ? '</ul></li>' : '</li>');
      body.push(`<li>${inline(item[2]!)}`);
      depth = 1;
    } else if (line) {
      closeLists();
      const heading = /^(#{1,3}) (.+)$/u.exec(line);
      body.push(heading ? `<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>` : `<p>${inline(line)}</p>`);
    }
  }
  closeLists();
  const nav = LEGAL_PAGES.map((page) => `<a href="/${page.slug}">${page.title}</a>`).join(' · ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${escape(title)} · Codex Live Share</title>
<style>
  :root { --bg: #f7f7f5; --ink: #1c1c1a; --muted: #5f5f5a; --line: #e4e4df; --accent: #2f63e0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --ink: #ededea; --muted: #a3a39d; --line: #30302e; --accent: #7aa2ff; } }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 680px; margin: 0 auto; padding: 48px 16px 64px; }
  h1 { font-size: 28px; line-height: 1.2; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 32px 0 8px; }
  p, li { color: var(--ink); }
  ul { padding-left: 20px; }
  code { font: 13px ui-monospace, "SF Mono", Menlo, monospace; }
  a { color: var(--accent); text-underline-offset: 2px; }
  nav { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
<main>
${body.join('\n')}
<nav><a href="/">Codex Live Share</a> · ${nav}</nav>
</main>
</body>
</html>`;
}

function inline(text: string): string {
  return escape(text)
    .replaceAll(/\*\*(.+?)\*\*/gu, '<strong>$1</strong>')
    .replaceAll(/`(.+?)`/gu, '<code>$1</code>');
}

function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
