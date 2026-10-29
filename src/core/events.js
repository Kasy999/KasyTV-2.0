/** Minimal event bus shared by services and views. */
const handlers = new Map();

export const bus = {
  on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(fn);
    return () => bus.off(name, fn);
  },
  off(name, fn) {
    const set = handlers.get(name);
    if (set) set.delete(fn);
  },
  emit(name, payload) {
    const set = handlers.get(name);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (e) {
        console.error('[bus]', name, e);
      }
    }
  },
};
