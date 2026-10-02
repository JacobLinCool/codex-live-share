import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { legalHref, legalPage } from '../src';

describe('legal pages', () => {
  it('renders headings, paragraphs and nested lists', () => {
    const html = legalPage('# Title\n\nIntro with **bold** and `code`.\n\n- One\n- Two:\n  - nested a\n  - nested b\n- Three\n\nAfter.', 'Title');
    const main = html.slice(html.indexOf('<main>'), html.indexOf('<nav>'));
    expect(main.replaceAll('\n', '')).toBe(
      '<main><h1>Title</h1><p>Intro with <strong>bold</strong> and <code>code</code>.</p>'
      + '<ul><li>One</li><li>Two:<ul><li>nested a</li><li>nested b</li></ul></li><li>Three</li></ul><p>After.</p>',
    );
  });

  it('escapes HTML in the source', () => {
    expect(legalPage('<script>alert(1)</script>', 'x')).not.toContain('<script>alert');
  });

  it('renders the real policies with balanced lists', () => {
    for (const name of ['terms', 'privacy', 'refunds']) {
      const html = legalPage(readFileSync(new URL(`../../../legal/${name}.md`, import.meta.url), 'utf8'), name);
      expect(html.match(/<ul>/gu)?.length).toBe(html.match(/<\/ul>/gu)?.length);
      expect(html).not.toMatch(/<p>\s*-\s/u);
    }
    expect(legalHref('terms', null)).toBe('/terms');
  });
});
