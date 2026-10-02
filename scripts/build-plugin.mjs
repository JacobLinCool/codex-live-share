// Assembles the Codex plugin at plugins/live-share from plugin-src, the
// daemon and web builds, and node-datachannel's native addon for every
// supported platform. The output is committed so the repo works as a
// Codex plugin marketplace (`codex plugin marketplace add JacobLinCool/codex-live-share`).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'plugins', 'live-share');
const daemon = JSON.parse(readFileSync(join(root, 'apps/daemon/package.json'), 'utf8'));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

/** macOS Intel is intentionally unsupported. */
const NATIVE = Object.entries(daemon.optionalDependencies);

for (const required of ['apps/daemon/dist/cli.js', 'apps/web/dist/index.html']) {
  if (!existsSync(join(root, required))) {
    console.error(`Missing ${required}; run \`pnpm build\` first.`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'plugin-src'), out, { recursive: true });
cpSync(join(root, 'apps/daemon/dist/cli.js'), join(out, 'dist/cli.js'));
cpSync(join(root, 'apps/web/dist'), join(out, 'dist/web'), { recursive: true, filter: (path) => !path.endsWith('.map') });
writeFileSync(join(out, 'package.json'), `${JSON.stringify({ name: 'codex-live-share-plugin', version, private: true, type: 'module' }, null, 2)}\n`);

const manifestPath = join(out, '.codex-plugin/plugin.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const work = mkdtempSync(join(tmpdir(), 'live-share-native-'));
try {
  for (const [name, range] of NATIVE) {
    const tarball = execFileSync('npm', ['pack', `${name}@${range}`, '--silent', '--pack-destination', work], { encoding: 'utf8' }).trim().split('\n').at(-1);
    const target = join(out, 'node_modules', name);
    mkdirSync(target, { recursive: true });
    execFileSync('tar', ['-xzf', join(work, tarball), '-C', target, '--strip-components=1']);
    console.log(`  ${name}@${range}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`Built ${out} (v${version})`);
