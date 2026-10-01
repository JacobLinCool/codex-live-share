import { describe, expect, it } from 'vitest';
import { editedPaths } from '../src/daemon';
import { toNodeIceServers } from '../src/peer-mesh';

describe('editedPaths', () => {
  const folder = '/work/paper';

  it('reads apply_patch headers relative to the hook cwd', () => {
    const patch = ['*** Begin Patch', '*** Update File: main.tex', '@@', '-a', '+b', '*** Add File: sections/new.md', '+x', '*** End Patch'].join('\n');
    expect(editedPaths({ cwd: folder, tool_input: { command: patch } }, folder)).toEqual(['main.tex', 'sections/new.md']);
  });

  it('accepts absolute paths and drops paths outside the shared folder', () => {
    const payload = { cwd: '/work/paper/sections', tool_input: { command: '*** Update File: ../main.tex\n*** Delete File: /etc/hosts\n*** Update File: ../../other/x.md' } };
    expect(editedPaths(payload, folder)).toEqual(['main.tex']);
    expect(editedPaths({ tool_input: { file_path: '/work/paper/a.md' } }, folder)).toEqual(['a.md']);
  });

  it('ignores tools that do not edit files', () => {
    expect(editedPaths({ tool_input: { command: 'ls -la' } }, folder)).toEqual([]);
  });
});

describe('toNodeIceServers', () => {
  it('converts browser ICE servers, keeping TURN credentials and dropping port 53', () => {
    expect(toNodeIceServers([
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'p' },
      { urls: 'turn:no-credentials.example:3478' },
    ])).toEqual([
      'stun:stun.cloudflare.com:3478',
      { hostname: 'turn.cloudflare.com', port: 3478, username: 'u', password: 'p', relayType: 'TurnUdp' },
      { hostname: 'turn.cloudflare.com', port: 443, username: 'u', password: 'p', relayType: 'TurnTls' },
    ]);
  });
});
