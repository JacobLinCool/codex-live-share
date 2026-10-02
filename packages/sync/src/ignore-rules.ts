import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ignore, { type Ignore } from 'ignore';

/** Never shared: VCS state, dependencies, secrets, OS noise, and TeX build products. */
export const DEFAULT_IGNORES = [
  '.git/',
  '.hg/',
  '.svn/',
  'node_modules/',
  '.venv/',
  '__pycache__/',
  '.DS_Store',
  'Thumbs.db',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '.codex-live-share/',
  '*.swp',
  '*~',
  '*.aux',
  '*.bbl',
  '*.blg',
  '*.fdb_latexmk',
  '*.fls',
  '*.lof',
  '*.lot',
  '*.log',
  '*.nav',
  '*.out',
  '*.snm',
  '*.synctex.gz',
  '*.synctex(busy)',
  '*.toc',
  '*.xdv',
];

export const IGNORE_FILES = ['.gitignore', '.liveshareignore'];

export class IgnoreRules {
  #rules: Ignore;
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
    this.#rules = this.#load();
  }

  reload(): void {
    this.#rules = this.#load();
  }

  /** `path` is relative and POSIX; directories should end with '/'. */
  ignores(path: string): boolean {
    return this.#rules.ignores(path);
  }

  #load(): Ignore {
    const rules = ignore().add(DEFAULT_IGNORES);
    for (const name of IGNORE_FILES) {
      try {
        rules.add(readFileSync(join(this.#root, name), 'utf8'));
      } catch {
        // Optional file.
      }
    }
    return rules;
  }
}
