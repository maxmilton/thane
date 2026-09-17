const CHARS = 'abcdefghijklmnopqrstuvwxyz';

export const generateMinifiedSelector = (index: number): string => {
  const prefixIndex = Math.floor(index / CHARS.length);
  const suffixIndex = index % CHARS.length;
  let prefix = '';
  let remaining = prefixIndex;
  do {
    prefix = CHARS[remaining % CHARS.length] + prefix;
    remaining = Math.floor(remaining / CHARS.length) - 1;
  } while (remaining >= 0);

  const suffix = CHARS[suffixIndex];

  return `${prefix}-${suffix}`;
};

export class SelectorMap {
  private originalToMinified = new Map<string, string>();
  private nextIndex = 0;

  /**
   * Give a selector its short name. `isTaken` lets the caller refuse a generated name that
   * already means something in the output (another selector, or a class of the same spelling).
   */
  register(originalSelector: string, isTaken: (candidate: string) => boolean = () => false): string {
    const existing = this.originalToMinified.get(originalSelector);
    if (existing) {
      return existing;
    }

    let minified = generateMinifiedSelector(this.nextIndex++);
    while (isTaken(minified)) minified = generateMinifiedSelector(this.nextIndex++);
    this.originalToMinified.set(originalSelector, minified);
    return minified;
  }

  entries(): IterableIterator<[string, string]> {
    return this.originalToMinified.entries();
  }

  get size(): number {
    return this.originalToMinified.size;
  }

  clear(): void {
    this.originalToMinified.clear();
    this.nextIndex = 0;
  }
}

const escapeRegExp = (value: string): string => value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

/**
 * Every place a selector is renamed, as one pattern:
 *   1. <selector(\s|>|/)     — HTML open tags
 *   2. </selector>           — HTML close tags
 *   3. (['"])selector\1      — a quoted string that is exactly the selector
 *   4. .selector             — a CSS class, up to the end of the identifier
 */
const buildSelectorPattern = (alternatives: string): RegExp =>
  new RegExp(
    `<(${alternatives})([\\s>/])|</(${alternatives})>|(['"])(${alternatives})\\4|\\.(${alternatives})(?![\\w-])`,
    'g',
  );

/** Selectors shaped like a custom element name; single words are too easily ordinary strings. */
export const isMinifiableSelector = (selector: string): boolean => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(selector);

const countMatches = (source: string, pattern: RegExp): number => {
  let count = 0;
  while (pattern.exec(source) !== null) count++;
  return count;
};

/** How often `name` appears as a whole identifier-like token, in any context. */
export const countSelectorTokens = (source: string, name: string): number =>
  countMatches(source, new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`, 'g'));

/**
 * A selector may only be renamed when every appearance of it is one the renamer handles.
 * An appearance it would miss — inside a longer string such as a route or an asset path, or
 * as one class among several in a `class` attribute — would be left behind under the old
 * name while the rest moved, so such a selector keeps its name everywhere.
 */
export const isSafeToRename = (sources: string[], selector: string): boolean => {
  const pattern = escapeRegExp(selector);
  let total = 0;
  let handled = 0;
  for (const source of sources) {
    total += countSelectorTokens(source, selector);
    handled += countMatches(source, buildSelectorPattern(pattern));
  }
  return total > 0 && total === handled;
};

export const applySelectorsToSource = (source: string, selectorMap: SelectorMap): string => {
  if (selectorMap.size === 0) return source;

  // Build a single combined regex that matches any selector in all contexts.
  // This gives O(n) scanning instead of O(n * selectors * 4).
  const entries = Array.from(selectorMap.entries());
  // Sort by length descending so longer selectors match before shorter prefixes
  entries.sort(([a], [b]) => b.length - a.length);

  const alternatives = entries.map(([original]) => escapeRegExp(original)).join('|');
  const lookup = new Map(entries);

  return source.replace(buildSelectorPattern(alternatives), (...args: any[]) => {
    // Group 1,2: HTML open tag  <selector(\s|>|/)
    if (args[1]) return `<${lookup.get(args[1]) || args[1]}${args[2]}`;
    // Group 3: HTML close tag </selector>
    if (args[3]) return `</${lookup.get(args[3]) || args[3]}>`;
    // Group 4,5: Quoted string 'selector' or "selector"
    if (args[5]) return `${args[4]}${lookup.get(args[5]) || args[5]}${args[4]}`;
    // Group 6: CSS class .selector
    if (args[6]) return `.${lookup.get(args[6]) || args[6]}`;
    return args[0];
  });
};
