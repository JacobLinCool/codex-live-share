import { defineConfig } from 'tsup';

// One self-contained CLI. Only node-datachannel's per-platform native addons
// stay outside; the plugin ships them under node_modules/@node-datachannel/*.
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: false,
  splitting: false,
  noExternal: [/^(?!@node-datachannel\/).*/u],
  external: [/^@node-datachannel\//u],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
