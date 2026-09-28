/**
 * Normalise compiled output so two builds of the same source compare equal regardless of
 * where the project sits on disk:
 *  - output file names carry a content hash (main-ABCD1234.js)
 *  - temp project folders carry a random or keyed suffix
 *  - the repository root (the current working directory) appears in some messages
 *
 * Generated ids are per-file counters, so they do not depend on the checkout path and are
 * compared as they are.
 *
 * Used by scripts/snapshot/preload.ts and scripts/snapshot/apps.ts (see scripts/snapshot/output.ts).
 */
export const normaliseOutput = (text: string, key = ''): string => {
  let out = text.replace(/\r\n/g, '\n').split(process.cwd()).join('<root>');
  if (key) out = out.split(`.tmp-thane-snap-${key}`).join('.tmp-thane-snap');
  out = out.replace(/\.tmp-thane-[A-Za-z0-9]{6}\b/g, '.tmp-thane-X');
  out = out.replace(/-[A-Z0-9]{8}(?=\.js\b)/g, '-HASH');
  return out;
};
