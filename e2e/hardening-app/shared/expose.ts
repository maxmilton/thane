/**
 * Window hooks shared by the hardening probes.
 *
 * Every probe exposes the signals the spec drives under `window.__probe.<id>`, so a test changes
 * state with `page.evaluate` instead of each probe carrying its own buttons.
 */
export const expose = (id: string, handles: Record<string, unknown>): void => {
  const win = window as any;
  win.__probe ??= {};
  win.__probe[id] = handles;
};

/** Counts calls per key on `window.__counts[bucket]`, so the spec can read lifecycle calls. */
export const countCall = (bucket: string, key: string): void => {
  const win = window as any;
  win.__counts ??= {};
  win.__counts[bucket] ??= {};
  win.__counts[bucket][key] = (win.__counts[bucket][key] ?? 0) + 1;
};
