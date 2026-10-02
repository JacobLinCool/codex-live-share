// Exercise the actual bundle and native addon without starting a share or
// consuming MCP stdin. The daemon will inherit this same Node executable.
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('Live Share requires Node.js 22 or newer.');
  process.exit(1);
}

if (process.argv[2] !== 'hook') {
  process.argv = [process.execPath, '', '--version'];
  await import('../dist/cli.js');
}
