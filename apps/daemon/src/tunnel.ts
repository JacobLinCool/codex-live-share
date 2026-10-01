import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { accessSync, constants, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { waitForDns } from './resolve';

/**
 * Direct mode publishes the host's signal server through a Cloudflare quick
 * tunnel: anonymous, free, no account, an https://*.trycloudflare.com address.
 * The binary is resolved from PATH or downloaded once from the pinned GitHub
 * release and verified against the digests below.
 */
export const CLOUDFLARED_VERSION = '2026.9.3';

interface Asset {
  file: string;
  sha256: string;
  archive: boolean;
}

const ASSETS: Record<string, Asset> = {
  'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', sha256: '587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095', archive: true },
  'linux-x64': { file: 'cloudflared-linux-amd64', sha256: '77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2', archive: false },
  'linux-arm64': { file: 'cloudflared-linux-arm64', sha256: 'aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d', archive: false },
  'win32-x64': { file: 'cloudflared-windows-amd64.exe', sha256: 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2', archive: false },
  // No native Windows on Arm build; x64 runs under emulation.
  'win32-arm64': { file: 'cloudflared-windows-amd64.exe', sha256: 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2', archive: false },
};

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/u;
const READY_TIMEOUT_MS = 90_000;

export class TunnelError extends Error {}

export function parseTunnelUrl(line: string): string | null {
  return TUNNEL_URL.exec(line)?.[0] ?? null;
}

export function assetFor(platform = process.platform, arch = process.arch): Asset | null {
  return ASSETS[`${platform}-${arch}`] ?? null;
}

export function verifyDigest(bytes: Uint8Array, expected: string): boolean {
  return createHash('sha256').update(bytes).digest('hex') === expected;
}

/** An explicit override, then PATH, then our cached download, then a fresh verified download. */
export async function resolveCloudflared(binDir: string, log: (message: string) => void): Promise<string> {
  const override = process.env['CODEX_LIVE_SHARE_CLOUDFLARED'];
  if (override) return override;
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, exe);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  const cached = join(binDir, `cloudflared-${CLOUDFLARED_VERSION}${process.platform === 'win32' ? '.exe' : ''}`);
  if (existsSync(cached)) return cached;

  const asset = assetFor();
  if (!asset) throw new TunnelError(`No cloudflared build for ${process.platform}-${process.arch}. Install cloudflared yourself, or use hosted mode.`);
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.file}`;
  log(`Downloading cloudflared ${CLOUDFLARED_VERSION} (one time)`);
  const bytes = await download(url, log);
  if (!verifyDigest(bytes, asset.sha256)) throw new TunnelError('The downloaded cloudflared did not match its expected checksum; refusing to run it.');
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const temporary = `${cached}.${process.pid}.download`;
  if (asset.archive) {
    const archive = `${temporary}.tgz`;
    const extractDir = `${temporary}.d`;
    writeFileSync(archive, bytes);
    mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['-xzf', archive, '-C', extractDir]);
    renameSync(join(extractDir, 'cloudflared'), temporary);
    rmSync(archive, { force: true });
    rmSync(extractDir, { recursive: true, force: true });
  } else {
    writeFileSync(temporary, bytes);
  }
  if (process.platform !== 'win32') execFileSync('chmod', ['755', temporary]);
  renameSync(temporary, cached);
  return cached;
}

export interface TunnelEvents {
  url: [url: string];
  down: [reason: string];
}

/**
 * Keeps one quick tunnel to a local URL alive. Quick tunnels get a new address
 * each time they start, so a restart after a crash emits a new `url`.
 */
export class QuickTunnel extends EventEmitter<TunnelEvents> {
  #child: ChildProcess | null = null;
  #stopped = false;
  #url: string | null = null;
  #attempt = 0;

  constructor(
    private readonly binary: string,
    private readonly target: string,
    private readonly configPath: string,
    private readonly log: (message: string) => void,
  ) {
    super();
  }

  get url(): string | null {
    return this.#url;
  }

  /** Resolves with the public URL once it answers through Cloudflare. */
  start(): Promise<string> {
    // An empty config keeps a user's own ~/.cloudflared/config.yml from turning this into a named tunnel.
    writeFileSync(this.configPath, '# codex-live-share quick tunnel\n');
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ['tunnel', '--no-autoupdate', '--config', this.configPath, '--url', this.target], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.#child = child;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new TunnelError('Cloudflare did not open a tunnel in time. Check the network, or use hosted mode.'));
      }, READY_TIMEOUT_MS);
      // Ready once cloudflared both has an address and has registered with the edge.
      // The host never resolves its own tunnel name: probing a brand-new hostname
      // before Cloudflare publishes it gets NXDOMAIN cached by the OS for minutes.
      let assigned: string | null = null;
      let registered = false;
      let checking = false;
      const ready = () => {
        if (!assigned || !registered || checking || this.#url === assigned) return;
        const url = assigned;
        checking = true;
        // Publish the invite only once its name resolves for everyone else.
        void waitForDns(new URL(url).hostname, READY_TIMEOUT_MS).then((published) => {
          checking = false;
          if (!published || this.#child !== child) return;
          this.#url = url;
          this.#attempt = 0;
          this.log(`Tunnel ready at ${url}`);
          this.emit('url', url);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(url);
          }
        });
      };
      const onLine = (line: string) => {
        if (/\bERR\b/u.test(line) && !line.includes('Configuration file')) this.log(`cloudflared: ${line.slice(0, 300)}`);
        const url = parseTunnelUrl(line);
        if (url) assigned = url;
        if (/Registered tunnel connection/u.test(line)) registered = true;
        ready();
      };
      for (const stream of [child.stdout, child.stderr]) {
        if (stream) createInterface({ input: stream }).on('line', onLine);
      }
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new TunnelError(`Could not run cloudflared: ${error.message}`));
      });
      child.once('exit', (code) => {
        if (this.#child !== child) return;
        this.#child = null;
        this.#url = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new TunnelError(`cloudflared exited (${code}) before the tunnel was ready.`));
          return;
        }
        if (this.#stopped) return;
        this.emit('down', `cloudflared exited (${code})`);
        const delay = Math.min(30_000, 2_000 * 2 ** this.#attempt++);
        this.log(`Tunnel down; restarting in ${delay / 1_000}s`);
        setTimeout(() => {
          if (!this.#stopped) this.start().catch((error: unknown) => this.log(`Tunnel restart failed: ${String(error)}`));
        }, delay);
      });
    });
  }

  stop(): void {
    this.#stopped = true;
    this.#child?.kill();
    this.#child = null;
  }
}

/** Streams a download, giving up only if it stalls rather than if the network is slow. */
async function download(url: string, log: (message: string) => void): Promise<Uint8Array> {
  const controller = new AbortController();
  let stall = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new TunnelError(`Could not download cloudflared (HTTP ${response.status}).`);
    const total = Number(response.headers.get('content-length') ?? 0);
    const chunks: Uint8Array[] = [];
    let received = 0;
    let reported = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      clearTimeout(stall);
      stall = setTimeout(() => controller.abort(), 30_000);
      chunks.push(chunk);
      received += chunk.byteLength;
      if (total && received - reported > total / 4) {
        reported = received;
        log(`cloudflared download ${Math.round((received / total) * 100)}%`);
      }
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    if (error instanceof TunnelError) throw error;
    throw new TunnelError(`Downloading cloudflared failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(stall);
  }
}
