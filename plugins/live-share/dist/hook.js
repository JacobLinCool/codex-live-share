import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);

// src/hooks.ts
import { realpathSync as realpathSync2 } from "fs";

// src/client.ts
import { spawn } from "child_process";
import { mkdirSync as mkdirSync2, openSync, readFileSync as readFileSync3, realpathSync, rmSync as rmSync2 } from "fs";
import { join as join3 } from "path";

// src/config.ts
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir, userInfo } from "os";
import { join } from "path";
var HOME = process.env["CODEX_LIVE_SHARE_HOME"] ?? join(homedir(), ".codex-live-share");
var RUN_DIR = join(HOME, "run");
var SHARES_DIR = join(HOME, "shares");
var CONFIG_PATH = join(HOME, "config.json");
var BIN_DIR = join(HOME, "bin");

// src/registry.ts
import { readdirSync, readFileSync as readFileSync2, rmSync } from "fs";
import { join as join2, sep } from "path";
function readRunEntries() {
  let names;
  try {
    names = readdirSync(RUN_DIR);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(readFileSync2(join2(RUN_DIR, name), "utf8"));
      if (isAlive(entry.pid)) entries.push(entry);
      else rmSync(join2(RUN_DIR, name), { force: true });
    } catch {
    }
  }
  return entries;
}
function findRunEntry(path) {
  let best = null;
  for (const entry of readRunEntries()) {
    if (path === entry.folder || path.startsWith(`${entry.folder}${sep}`)) {
      if (!best || entry.folder.length > best.folder.length) best = entry;
    }
  }
  return best;
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// src/client.ts
var RpcError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
};
async function callDaemon(entry, method, params = {}, timeoutMs = 1e4) {
  const response = await fetch(`http://127.0.0.1:${entry.port}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.token}` },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json();
  if (!body.ok) throw new RpcError(body.code ?? "FAILED", body.message ?? `${method} failed`);
  return body.result;
}

// src/agent-context.ts
function hookAgentSession(payload) {
  const session = payload["session_id"];
  if (typeof session !== "string" || !session || session.length > 200) return null;
  const agent = payload["agent_id"];
  return typeof agent === "string" && agent ? JSON.stringify([session, agent]) : JSON.stringify([session]);
}
var SESSION_TOOLS = /* @__PURE__ */ new Set(["plan_publish", "plan_update", "plan_finish", "agent_message", "live_share_status"]);
function agentToolInput(payload) {
  const name = payload["tool_name"];
  if (typeof name !== "string" || !name.startsWith("mcp__live_share__") || !SESSION_TOOLS.has(name.slice("mcp__live_share__".length))) return null;
  const session = hookAgentSession(payload);
  const input = payload["tool_input"];
  if (!session || typeof input !== "object" || input === null || Array.isArray(input)) return null;
  return { ...input, _agent_session: session };
}

// src/hooks.ts
var EVENT_NAMES = {
  "pre-tool-use": "PreToolUse",
  "post-tool-use": "PostToolUse",
  "session-start": "SessionStart",
  "session-end": "SessionEnd",
  "user-prompt-submit": "UserPromptSubmit",
  stop: "Stop"
};
async function runHook(event) {
  if (!(event in EVENT_NAMES)) return;
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  if (event === "pre-tool-use") {
    const updatedInput = agentToolInput(payload);
    if (updatedInput) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput } }));
      return;
    }
  }
  const cwd = typeof payload["cwd"] === "string" ? payload["cwd"] : process.cwd();
  let folder;
  try {
    folder = realpathSync2(cwd);
  } catch {
    return;
  }
  const entry = findRunEntry(folder);
  if (!entry) return;
  payload["cwd"] = folder;
  let result;
  try {
    result = await callDaemon(entry, "hook", { event, payload }, 3e3);
  } catch {
    return;
  }
  const hookEventName = EVENT_NAMES[event];
  if (event === "stop") {
    process.stdout.write(JSON.stringify(result.continueWith ? { decision: "block", reason: result.continueWith } : {}));
    return;
  }
  if (result.deny) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName, permissionDecision: "deny", permissionDecisionReason: result.deny }
    }));
  } else if (result.context) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: result.context } }));
  }
}
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// src/hook-cli.ts
await runHook(process.argv[2] ?? "");
