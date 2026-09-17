import ts from 'typescript';

export const minifyHTML = (html: string): string => {
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

/** Elements whose text is whitespace-sensitive: a template holding one is left alone. */
const PREFORMATTED = /<(?:pre|textarea)[\s>]/i;

/** A template the compiler produced (or markup written the same way): starts and ends with a tag. */
const looksLikeHTML = (content: string): boolean => {
  const trimmed = content.trim();
  return /^<(?:[a-zA-Z]|!--)/.test(trimmed) && trimmed.endsWith('>') && !PREFORMATTED.test(trimmed);
};

/**
 * A stylesheet: starts like a selector or an at-rule, ends with a closing brace, its braces
 * balance, and at least one block opens with a `property:` declaration. Messages, JSON and
 * code that merely contain a colon or a brace do not match.
 */
const looksLikeCSS = (content: string): boolean => {
  const trimmed = content.trim();
  if (!/^[.#:&*@[a-zA-Z]/.test(trimmed) || !trimmed.endsWith('}')) return false;
  if (!/[{;]\s*-{0,2}[a-zA-Z][\w-]*\s*:/.test(trimmed)) return false;
  let depth = 0;
  for (const ch of trimmed) {
    if (ch === '{') depth++;
    else if (ch === '}' && --depth < 0) return false;
  }
  return depth === 0;
};

const minifyTemplateContent = (content: string): string => {
  if (looksLikeHTML(content)) return minifyHTML(content);
  if (looksLikeCSS(content)) return minifyCSS(content);
  // Anything else is the application's own text: a message, a separator, a line break.
  return content;
};

/**
 * Minify the HTML and CSS template literals of an emitted JavaScript file.
 *
 * The file is parsed, not scanned: a hand-written scanner cannot tell a regex literal from a
 * division, so a quote or a backtick inside a regex used to put it out of step with the
 * source and it rewrote code as if it were a template. Only template literals without
 * substitutions are considered (compiled templates and stylesheets are static text), tagged
 * templates are never touched, and a literal is only rewritten when its whole content is
 * recognisably HTML or CSS.
 */
export const minifyTemplatesInSource = (source: string): string => {
  if (!source.includes('`')) return source;

  const sourceFile = ts.createSourceFile('__output.js', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const edits: { start: number; end: number; text: string }[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node)) {
      // String.raw`…` and friends see the raw text: never rewrite it, but do look inside the
      // tag and the substitutions.
      visit(node.tag);
      if (ts.isTemplateExpression(node.template)) {
        for (const span of node.template.templateSpans) visit(span.expression);
      }
      return;
    }

    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      const start = node.getStart(sourceFile) + 1;
      const end = node.getEnd() - 1;
      const content = source.slice(start, end);
      const minified = minifyTemplateContent(content);
      if (minified !== content) edits.push({ start, end, text: minified });
      return;
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (edits.length === 0) return source;

  let result = '';
  let cursor = 0;
  for (const edit of edits) {
    result += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return result + source.slice(cursor);
};
