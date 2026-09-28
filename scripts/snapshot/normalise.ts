/**
 * Normalise compiled output so two builds of the same source compare equal regardless of
 * where the project sits on disk:
 *  - generated binding ids are seeded from a hash of the absolute file path (bN / iN tokens)
 *  - output file names carry a content hash (main-ABCD1234.js)
 *  - temp project folders carry a random or keyed suffix
 *  - the repository root (the current working directory) appears in some messages
 *
 * Used by scripts/snapshot/preload.ts and scripts/snapshot/apps.ts (see scripts/snapshot/output.ts).
 * Once ids no longer depend on the checkout path (A1-5), id renaming can be dropped.
 */
export const normaliseOutput = (text: string, key = ''): string => {
  let out = text.replace(/\r\n/g, '\n').split(process.cwd()).join('<root>');
  if (key) out = out.split(`.tmp-thane-snap-${key}`).join('.tmp-thane-snap');
  out = out.replace(/\.tmp-thane-[A-Za-z0-9]{6}\b/g, '.tmp-thane-X');
  out = out.replace(/-[A-Z0-9]{8}(?=\.js\b)/g, '-HASH');
  const ids = new Map<string, string>();
  // ids also appear inside generated identifiers (__tpl_b12, _a_b12, _upd_b12_0)
  out = out.replace(/(?<![A-Za-z0-9])([bi])(\d+)(?![0-9])/g, (m, p: string) => {
    let v = ids.get(m);
    if (!v) {
      v = `${p}#${ids.size}`;
      ids.set(m, v);
    }
    return v;
  });
  return out;
};
