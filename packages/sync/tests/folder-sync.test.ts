import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { filesOf } from '@codex-live-share/protocol';
import { FolderSync } from '../src';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function folder(files: Record<string, string | Uint8Array> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'live-share-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

/** Two docs wired together the way peers are: every update is relayed. */
function linkedDocs(): [Y.Doc, Y.Doc] {
  const left = new Y.Doc();
  const right = new Y.Doc();
  left.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(right, update, 'relay');
  });
  right.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(left, update, 'relay');
  });
  return [left, right];
}

async function share(root: string, doc: Y.Doc, mode: 'disk' | 'doc', extra: Partial<ConstructorParameters<typeof FolderSync>[0]> = {}) {
  const sync = new FolderSync({ root, doc, ...extra });
  await sync.reconcile(mode);
  await sync.start();
  cleanup.push(() => sync.stop());
  return sync;
}

async function eventually(check: () => Promise<void>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
}

describe('FolderSync', () => {
  it('mirrors a host folder into an empty guest folder, respecting ignore rules', async () => {
    const host = await folder({
      'main.tex': '\\documentclass{article}\n',
      'main.pdf': new Uint8Array([37, 80, 68, 70, 0, 1]),
      'figures/plot.png': new Uint8Array([137, 80, 78, 71, 0, 2, 3]),
      'sections/intro.md': '# Intro\n',
      'main.aux': 'aux',
      '.env': 'SECRET=1',
      'node_modules/x/index.js': 'x',
      '.gitignore': 'private/\n',
      'private/notes.md': 'secret',
    });
    const guest = await folder();
    const [hostDoc, guestDoc] = linkedDocs();
    await share(host, hostDoc, 'disk');
    await share(guest, guestDoc, 'doc');

    expect([...filesOf(guestDoc).keys()].sort()).toEqual(['.gitignore', 'figures/plot.png', 'main.tex', 'sections/intro.md']);
    expect(await readFile(join(guest, 'sections/intro.md'), 'utf8')).toBe('# Intro\n');
    expect([...(await readFile(join(guest, 'figures/plot.png')))]).toEqual([137, 80, 78, 71, 0, 2, 3]);
    await expect(stat(join(guest, 'main.pdf'))).rejects.toThrow();
    await expect(stat(join(guest, '.env'))).rejects.toThrow();
  });

  it('propagates disk edits, creations, and deletions both ways', async () => {
    const host = await folder({ 'a.md': 'one\n' });
    const guest = await folder();
    const [hostDoc, guestDoc] = linkedDocs();
    await share(host, hostDoc, 'disk');
    await share(guest, guestDoc, 'doc');

    await writeFile(join(guest, 'a.md'), 'one\ntwo\n');
    await writeFile(join(guest, 'b.md'), 'new\n');
    await eventually(async () => {
      expect(await readFile(join(host, 'a.md'), 'utf8')).toBe('one\ntwo\n');
      expect(await readFile(join(host, 'b.md'), 'utf8')).toBe('new\n');
    });

    await rm(join(host, 'b.md'));
    await eventually(async () => {
      await expect(stat(join(guest, 'b.md'))).rejects.toThrow();
    });
  });

  it('merges concurrent edits from two agents on the same file', async () => {
    const base = '# Paper\n\nIntro text.\n\nMethods text.\n';
    const host = await folder({ 'paper.md': base });
    const guest = await folder();
    const [hostDoc, guestDoc] = linkedDocs();
    await share(host, hostDoc, 'disk');
    await share(guest, guestDoc, 'doc');

    await Promise.all([
      writeFile(join(host, 'paper.md'), base.replace('Intro text.', 'Intro text, revised by Alice.')),
      writeFile(join(guest, 'paper.md'), base.replace('Methods text.', 'Methods text, revised by Bob.')),
    ]);
    const merged = '# Paper\n\nIntro text, revised by Alice.\n\nMethods text, revised by Bob.\n';
    await eventually(async () => {
      expect(await readFile(join(host, 'paper.md'), 'utf8')).toBe(merged);
      expect(await readFile(join(guest, 'paper.md'), 'utf8')).toBe(merged);
    });
  });

  it('applies remote doc edits to disk and reports local edits with ranges', async () => {
    const root = await folder({ 'notes.md': 'hello\n' });
    const doc = new Y.Doc();
    const edits: Array<{ path: string; ranges: Array<[string, string]> }> = [];
    await share(root, doc, 'disk', { onLocalEdit: (edit) => edits.push(edit) });

    const text = filesOf(doc).get('notes.md') as Y.Text;
    doc.transact(() => text.insert(0, '> '), 'remote');
    await eventually(async () => expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('> hello\n'));
    expect(edits).toHaveLength(0);

    await writeFile(join(root, 'notes.md'), '> hello world\n');
    await eventually(async () => expect(text.toString()).toBe('> hello world\n'));
    expect(edits.at(-1)?.path).toBe('notes.md');
    expect(edits.at(-1)?.ranges).toHaveLength(1);
  });

  it('reverts local edits on a view-only peer', async () => {
    const host = await folder({ 'a.md': 'shared\n' });
    const guest = await folder();
    const [hostDoc, guestDoc] = linkedDocs();
    await share(host, hostDoc, 'disk');
    await share(guest, guestDoc, 'doc', { readOnly: () => true, onWarning: () => {} });

    await writeFile(join(guest, 'a.md'), 'tampered\n');
    await eventually(async () => expect(await readFile(join(guest, 'a.md'), 'utf8')).toBe('shared\n'));
    expect(await readFile(join(host, 'a.md'), 'utf8')).toBe('shared\n');
  });

  it('never follows symlinks or writes outside the root', async () => {
    const outside = await folder({ 'target.md': 'outside\n' });
    const root = await folder({ 'a.md': 'a\n' });
    await symlink(join(outside, 'target.md'), join(root, 'link.md'));
    await symlink(outside, join(root, 'linked-dir'));
    const doc = new Y.Doc();
    const warnings: string[] = [];
    await share(root, doc, 'disk', { onWarning: (message) => warnings.push(message) });
    expect([...filesOf(doc).keys()]).toEqual(['a.md']);

    doc.transact(() => filesOf(doc).set('linked-dir/evil.md', new Y.Text('x')), 'remote');
    await eventually(async () => expect(warnings.join('\n')).toMatch(/outside the shared folder/u));
    await expect(stat(join(outside, 'evil.md'))).rejects.toThrow();
  });
});
