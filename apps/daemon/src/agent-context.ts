/** Hook session ids are not thread ids; subagents share their parent's session. */
export function hookAgentSession(payload: Record<string, unknown>): string | null {
  const session = payload['session_id'];
  if (typeof session !== 'string' || !session || session.length > 200) return null;
  const agent = payload['agent_id'];
  return typeof agent === 'string' && agent ? JSON.stringify([session, agent]) : JSON.stringify([session]);
}

const SESSION_TOOLS = new Set(['plan_publish', 'plan_update', 'plan_finish', 'agent_message', 'live_share_status']);

/** Inject identity without asking the model to supply it or probing MCP env vars. */
export function agentToolInput(payload: Record<string, unknown>): Record<string, unknown> | null {
  const name = payload['tool_name'];
  if (typeof name !== 'string' || !name.startsWith('mcp__live_share__') || !SESSION_TOOLS.has(name.slice('mcp__live_share__'.length))) return null;
  const session = hookAgentSession(payload);
  const input = payload['tool_input'];
  if (!session || typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  return { ...input, _agent_session: session };
}
