// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { blobsOf, filesOf } from '@codex-live-share/protocol';
import { mountMarkdownPreview, resolveImagePath } from '../src/lib/markdown-preview';

afterEach(() => vi.unstubAllGlobals());

describe('shared image paths', () => {
  it.each([
    ['README.md', './images/demo.png', 'images/demo.png'],
    ['docs/guide.md', '../images/demo.png', 'images/demo.png'],
    ['docs/guide.md', '/images/demo.png', 'images/demo.png'],
    ['docs/guide.md', './%E5%9C%96%20%E4%B8%80.png?raw=1#view', 'docs/圖 一.png'],
    ['docs/guide.md', 'cafe\u0301.png', 'docs/café.png'],
    ['docs/guide.md', '../images/a%23b.png', 'images/a#b.png'],
  ])('resolves %s → %s', (path, source, expected) => {
    expect(resolveImagePath(path, source)).toBe(expected);
  });

  it.each(['../../secret.png', '%2e%2e/%2e%2e/secret.png', 'https://example.com/a.png', '//example.com/a.png', 'file:///tmp/a.png', 'data:image/png;base64,AA==', 'javascript:alert(1)', 'C:\\image.png', '%00.png', '%zz.png', '#heading', ''])('rejects %s', (source) => {
    expect(resolveImagePath('docs/guide.md', source)).toBeNull();
  });
});

function preview(source: string) {
  const doc = new Y.Doc();
  const text = new Y.Text(source);
  filesOf(doc).set('docs/guide.md', text);
  const element = document.createElement('article');
  let serial = 0;
  const create = vi.fn((_blob: Blob) => `blob:test-${++serial}`);
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
  const dispose = mountMarkdownPreview(element, text, 'docs/guide.md', doc);
  return { doc, text, element, create, revoke, dispose };
}

describe('Markdown preview lifecycle', () => {
  it('updates when a reference arrives before its bytes, replaces images, and releases URLs', () => {
    const p = preview('![diagram](../images/diagram.png)\n\n![again](../images/diagram.png)');
    expect(p.element.querySelectorAll('.image-unavailable')).toHaveLength(2);
    filesOf(p.doc).set('images/diagram.png', { kind: 'blob', hash: 'first', size: 3 });
    expect(p.create).not.toHaveBeenCalled();
    blobsOf(p.doc).set('first', new Uint8Array([1, 2, 3]));
    expect(p.element.querySelectorAll('img')).toHaveLength(2);
    expect(p.create).toHaveBeenCalledTimes(1);
    expect(p.create.mock.calls[0]![0].type).toBe('image/png');
    expect(p.element.querySelector('img')?.getAttribute('src')).toBe('blob:test-1');

    p.doc.transact(() => {
      blobsOf(p.doc).set('second', new Uint8Array([4, 5]));
      filesOf(p.doc).set('images/diagram.png', { kind: 'blob', hash: 'second', size: 2 });
    });
    expect(p.element.querySelector('img')?.getAttribute('src')).toBe('blob:test-2');
    expect(p.revoke).toHaveBeenCalledWith('blob:test-1');
    p.text.insert(p.text.length, '\n\nUpdated caption');
    expect(p.element.textContent).toContain('Updated caption');

    filesOf(p.doc).delete('images/diagram.png');
    expect(p.element.querySelector('img')).toBeNull();
    expect(p.element.querySelectorAll('.image-unavailable')).toHaveLength(2);
    p.dispose();
    expect(p.revoke.mock.calls.flat().sort()).toEqual(p.create.mock.results.map((r) => r.value).sort());
    p.text.insert(0, 'After unmount');
    expect(p.element.childNodes).toHaveLength(0);
    p.doc.destroy();
  });

  it('renders synchronized SVG text and refreshes remote edits without unrelated activity rebuilding it', () => {
    const p = preview('![vector](./diagram.svg)');
    const svg = new Y.Text('<svg xmlns="http://www.w3.org/2000/svg"/>');
    filesOf(p.doc).set('docs/diagram.svg', svg);
    expect(p.create.mock.calls[0]![0].type).toBe('image/svg+xml');
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(p.doc));
    const remoteSvg = filesOf(peer).get('docs/diagram.svg') as Y.Text;
    remoteSvg.insert(remoteSvg.length, '\n');
    Y.applyUpdate(p.doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(p.doc)));
    expect(p.create).toHaveBeenCalledTimes(2);
    p.doc.getMap('unrelated').set('activity', 'editing');
    expect(p.create).toHaveBeenCalledTimes(2);
    p.dispose();
    expect(p.revoke).toHaveBeenCalledTimes(2);
    p.doc.destroy();
    peer.destroy();
  });

  it('sanitizes HTML and prevents responsive sources or escaping paths from bypassing shared image lookup', () => {
    const p = preview('<script>alert(1)</script><picture><source srcset="https://example.com/track.png"><img src="../safe.png" srcset="https://example.com/track.png 2x" onerror="alert(1)" alt="Safe"></picture>\n\n![escape](../../secret.png)\n\n![remote](https://example.com/track.png)');
    blobsOf(p.doc).set('safe', new Uint8Array([1]));
    filesOf(p.doc).set('safe.png', { kind: 'blob', hash: 'safe', size: 1 });
    expect(p.element.querySelector('script, source, [onerror], [srcset]')).toBeNull();
    expect(p.element.querySelectorAll('img')).toHaveLength(1);
    expect(p.element.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/u);
    expect(p.element.querySelectorAll('.image-unavailable')).toHaveLength(2);
    p.dispose();
    p.doc.destroy();
  });

  it('preserves embedded data images without creating or revoking their URLs', () => {
    const source = 'data:image/png;base64,iVBORw0KGgo=';
    const p = preview(`![embedded](${source})`);
    expect(p.element.querySelector('img')?.getAttribute('src')).toBe(source);
    expect(p.create).not.toHaveBeenCalled();
    p.dispose();
    expect(p.revoke).not.toHaveBeenCalled();
    p.doc.destroy();
  });
});
