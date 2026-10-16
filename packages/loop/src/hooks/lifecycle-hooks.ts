export type HookEvent = "session.start" | "session.end" | "run.error";
export type Hook = (
  event: HookEvent,
  payload: Record<string, unknown>,
) => void | Promise<void>;

const hooks = new Map<HookEvent, Set<Hook>>();

export function registerHook(event: HookEvent, hook: Hook): () => void {
  const registered = hooks.get(event) ?? new Set<Hook>();
  registered.add(hook);
  hooks.set(event, registered);
  return () => registered.delete(hook);
}

export async function emitHook(
  event: HookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  for (const hook of hooks.get(event) ?? []) await hook(event, payload);
}

export function clearHooks(): void {
  hooks.clear();
}
