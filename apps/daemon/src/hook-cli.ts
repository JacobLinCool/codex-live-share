// Hooks only need the local RPC bridge; never load the WebRTC native addon here.
import { runHook } from './hooks';

await runHook(process.argv[2] ?? '');
