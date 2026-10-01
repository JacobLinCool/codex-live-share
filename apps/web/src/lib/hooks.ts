import { useEffect, useMemo, useReducer, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import { isRecord, type AgentActivity, type Identity } from '@codex-live-share/protocol';
import type { LiveSession } from './session';

export function useLiveSession(live: LiveSession): Pick<LiveSession, 'session' | 'connection' | 'synced'> {
  const version = useSyncExternalStore(
    (listener) => live.subscribe(listener),
    () => `${live.connection}|${live.synced}|${live.session ? JSON.stringify(live.session) : ''}`,
  );
  return useMemo(() => ({ session: live.session, connection: live.connection, synced: live.synced }), [version, live]);
}

/** Re-renders whenever a Y type (deeply) changes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useYType<T extends Y.AbstractType<any>>(type: T): T {
  const [, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const listener = () => bump();
    type.observeDeep(listener);
    return () => type.unobserveDeep(listener);
  }, [type]);
  return type;
}

export interface Presence {
  clientId: number;
  user: Identity & { kind: 'human' | 'daemon' };
  file: string | null;
  interim: string | null;
  agent: AgentActivity | null;
}

export function usePresence(live: LiveSession): Presence[] {
  const [, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const listener = () => bump();
    live.awareness.on('change', listener);
    return () => live.awareness.off('change', listener);
  }, [live]);
  const result: Presence[] = [];
  for (const [clientId, state] of live.awareness.getStates()) {
    if (!isRecord(state) || !isRecord(state['user'])) continue;
    const user = state['user'] as unknown as Presence['user'];
    if (typeof user.peerId !== 'string' || typeof user.name !== 'string') continue;
    result.push({
      clientId,
      user,
      file: typeof state['file'] === 'string' ? state['file'] : null,
      interim: typeof state['interim'] === 'string' && state['interim'] ? state['interim'] : null,
      agent: isRecord(state['agent']) ? (state['agent'] as unknown as AgentActivity) : null,
    });
  }
  return result;
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useReducer((_: number, next: number) => next, Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
