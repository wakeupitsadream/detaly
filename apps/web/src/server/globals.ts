/**
 * Process-wide lazy singletons stored on globalThis, so dev-server module reloads and Next's
 * separate proxy and route bundles share one pool per process instead of opening new ones.
 */
const STORE_KEY = Symbol.for('detaly.web.singletons');

type Store = Map<string, unknown>;

function store(): Store {
  const holder = globalThis as typeof globalThis & { [STORE_KEY]?: Store };
  holder[STORE_KEY] ??= new Map();
  return holder[STORE_KEY];
}

export function singleton<T>(key: string, create: () => T): T {
  const map = store();
  if (!map.has(key)) map.set(key, create());
  return map.get(key) as T;
}

/** Test helper: forget a singleton (the caller closes it). */
export function resetSingleton(key: string): void {
  store().delete(key);
}
