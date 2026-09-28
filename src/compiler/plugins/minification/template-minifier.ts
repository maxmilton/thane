/**
 * Text minifiers for the two languages the compiler owns. They are only ever given text the
 * compiler knows to be HTML (a compiled template) or CSS (a `css` template, a `.css` import),
 * at compile time. Emitted JavaScript is never passed through them.
 */

/**
 * Elements whose content is not HTML text: whitespace is significant in it (`pre`, `textarea`)
 * or it is another language (`script`, where a line break ends a `//` comment, and `style`).
 * They are carried through exactly as written.
 */
const VERBATIM_ELEMENT = /<(pre|textarea|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// Private-use characters: never in real markup
const VERBATIM_OPEN = '';
const VERBATIM_CLOSE = '';

/**
 * Apply `transform` to the HTML outside verbatim elements, which are masked while it runs and put
 * back as written. Every place that collapses a template's whitespace goes through it (H-03).
 */
export const outsideVerbatim = (html: string, transform: (html: string) => string): string => {
  const verbatim: string[] = [];
  const masked = html.replace(VERBATIM_ELEMENT, (block) => {
    verbatim.push(block);
    return `${VERBATIM_OPEN}${verbatim.length - 1}${VERBATIM_CLOSE}`;
  });
  const result = transform(masked);
  if (verbatim.length === 0) return result;
  return result.replace(
    new RegExp(`${VERBATIM_OPEN}(\\d+)${VERBATIM_CLOSE}`, 'g'),
    (_match, index: string) => verbatim[Number(index)]!,
  );
};

export const minifyHTML = (html: string): string => outsideVerbatim(html, collapseHTML);

const collapseHTML = (html: string): string => {
  return (
    html
      .replace(/\s+/g, ' ')
      .replace(/>\s+<(?![!-])/g, '><')
      // Strip non-binding HTML comments (preserve <!--bN-->, <!--iN-->, <!--[if]-->, and <!----> boundary)
      .replace(/<!--(?!b\d)(?!i\d)(?!\[)(?!--)[\s\S]*?-->/g, '')
      // Repair: aggressive strip may have merged binding markers with boundary comments;
      // re-insert the placeholder text node that nextSibling.data relies on
      .replace(/(<!--[ib]\d+-->)(<!---->)/g, '$1 $2')
      .replace(/\s+>/g, '>')
      .replace(/^\s+</g, '<')
      .replace(/>\s+$/g, '>')
      .trim()
  );
};

const NO_SPACE_AFTER = new Set(['{', '}', ';', ',', ':', '(']);
const NO_SPACE_BEFORE = new Set(['{', '}', ';', ',', ')']);
const COMBINATORS = new Set(['>', '+', '~']);

/**
 * Minify CSS in one pass: comments go, runs of whitespace collapse, and a space is dropped
 * only where CSS never needs it. Two spaces are significant and kept:
 *   - around `+`, `-`, `>` inside parentheses (`calc(100% + 1px)` is invalid without them);
 *   - before a `:` (`.a :hover` is a descendant selector, `.a:hover` is not).
 * Quoted strings are copied verbatim.
 */
export const minifyCSS = (css: string): string => {
  let out = '';
  let parenDepth = 0;
  let pendingSpace = false;
  const length = css.length;

  const emit = (text: string): void => {
    const next = text[0]!;
    const prev = out[out.length - 1];
    if (pendingSpace && prev !== undefined) {
      const droppable =
        NO_SPACE_AFTER.has(prev) ||
        NO_SPACE_BEFORE.has(next) ||
        (parenDepth === 0 && (COMBINATORS.has(prev) || COMBINATORS.has(next)));
      if (!droppable) out += ' ';
    }
    pendingSpace = false;
    // the last declaration of a block does not need its semicolon
    if (next === '}' && out.endsWith(';')) out = out.slice(0, -1);
    out += text;
  };

  for (let i = 0; i < length; i++) {
    const ch = css[i]!;

    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? length : end + 1;
      pendingSpace = true;
      continue;
    }

    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f') {
      pendingSpace = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      let end = i + 1;
      while (end < length && css[end] !== ch) {
        if (css[end] === '\\') end++;
        end++;
      }
      emit(css.slice(i, end + 1));
      i = end;
      continue;
    }

    emit(ch);
    if (ch === '(') parenDepth++;
    else if (ch === ')' && parenDepth > 0) parenDepth--;
  }

  return out;
};
