/**
 * Compile-time transforms for stylesheet text the compiler owns: a `css` tagged template or an
 * imported `.css` file. The text is known to be CSS here, so nothing has to be guessed from its
 * content, and no emitted JavaScript is ever involved.
 */

import ts from 'typescript';
import { minifyCSS } from './template-minifier.js';
import type { SelectorMap } from './selector-minifier.js';
import { logger } from '../../utils/logger.js';
import { INTERNAL_RUNTIME_SPECIFIER, RUNTIME_HELPER } from '../../../contracts/index.js';

// Private-use characters: never part of an identifier, never CSS syntax, never in real source.
// A `${…}` substitution of a `css` template is replaced by MASK_OPEN <index> MASK_CLOSE while
// the stylesheet around it is transformed.
const MASK_OPEN = '';
const MASK_CLOSE = '';

const isIdentStart = (ch: string | undefined): boolean => ch !== undefined && /[a-zA-Z_-]/.test(ch);
const isIdentChar = (ch: string | undefined): boolean => ch !== undefined && /[\w-]/.test(ch);

/** The last index of a comment, quoted string or unquoted `url(…)` value that starts at `i`, or -1. */
const skipNonSelectorText = (css: string, i: number): number => {
  const length = css.length;
  const ch = css[i]!;
  if (ch === '/' && css[i + 1] === '*') {
    const end = css.indexOf('*/', i + 2);
    return end === -1 ? length : end + 1;
  }
  if (ch === '"' || ch === "'") {
    let end = i + 1;
    while (end < length && css[end] !== ch) {
      if (css[end] === '\\') end++;
      end++;
    }
    return end;
  }
  if ((ch === 'u' || ch === 'U') && /^url\(/i.test(css.slice(i, i + 4)) && !isIdentChar(css[i - 1])) {
    let end = i + 4;
    while (end < length && /\s/.test(css[end]!)) end++;
    // a quoted url("…") is skipped as a string on the next iterations
    if (css[end] === '"' || css[end] === "'") return end - 1;
    const close = css.indexOf(')', end);
    return close === -1 ? length : close;
  }
  return -1;
};

/**
 * Report every class selector (`.name`) in a stylesheet. Comments, quoted strings and
 * unquoted `url(…)` values are skipped, so `content: ".x"` and `url(/img/a.x.png)` are not
 * classes, and neither is a name that a substitution continues (`.card-${size}`). The rename
 * and the check that decides whether a rename is safe both walk the text with this one
 * function: what is counted as renameable is exactly what gets renamed.
 */
export const forEachCssClass = (css: string, visit: (name: string, start: number, end: number) => void): void => {
  const length = css.length;
  for (let i = 0; i < length; i++) {
    const ch = css[i]!;

    const skipTo = skipNonSelectorText(css, i);
    if (skipTo !== -1) {
      i = skipTo;
      continue;
    }

    if (ch === '.' && isIdentStart(css[i + 1])) {
      let end = i + 1;
      while (end < length && isIdentChar(css[end])) end++;
      const continuedBySubstitution = css[end] === MASK_OPEN || (css[end] === '$' && css[end + 1] === '{');
      if (!continuedBySubstitution) visit(css.slice(i + 1, end), i + 1, end);
      i = end - 1;
    }
  }
};

/** How many times `.name` is used as a class selector. */
export const countCssClass = (css: string, name: string): number => {
  let count = 0;
  forEachCssClass(css, (found) => {
    if (found === name) count++;
  });
  return count;
};

/** Rename class selectors; `lookup` returns the new name or undefined to keep the class. */
export const renameCssClasses = (css: string, lookup: (name: string) => string | undefined): string => {
  let out = '';
  let cursor = 0;
  forEachCssClass(css, (name, start, end) => {
    const renamed = lookup(name);
    if (renamed === undefined) return;
    out += css.slice(cursor, start) + renamed;
    cursor = end;
  });
  return cursor === 0 ? css : out + css.slice(cursor);
};

export interface CssTransformOptions {
  minify?: boolean | undefined;
  selectorMap?: SelectorMap | undefined;
  /** The stylesheet's file, named in warnings */
  file?: string | undefined;
  /** Called when the stylesheet defines `@keyframes`, which a component's stylesheet then scopes at run time */
  onKeyframes?: (() => void) | undefined;
}

/** The import and call that scope component keyframes, added to a module whose stylesheet defines some */
export const KEYFRAME_SCOPING = `import { ${RUNTIME_HELPER.ENABLE_KEYFRAMES} } from '${INTERNAL_RUNTIME_SPECIFIER}';\n${RUNTIME_HELPER.ENABLE_KEYFRAMES}();\n`;

const HOST_CONTEXT = ':host-context(';

/** `:host-context(X)` becomes `X &`: the runtime scoper puts the component's class where `&` stands. */
const rewriteHostContext = (css: string): string => {
  let out = '';
  let cursor = 0;
  for (let i = 0; i < css.length; i++) {
    const skipTo = skipNonSelectorText(css, i);
    if (skipTo !== -1) {
      i = skipTo;
    } else if (css.startsWith(HOST_CONTEXT, i)) {
      let depth = 1;
      let close = i + HOST_CONTEXT.length;
      for (; close < css.length; close++) {
        const skip = skipNonSelectorText(css, close);
        if (skip !== -1) close = skip;
        else if (css[close] === '(') depth++;
        else if (css[close] === ')' && --depth === 0) break;
      }
      if (depth !== 0) break;
      out += css.slice(cursor, i) + css.slice(i + HOST_CONTEXT.length, close).trim() + ' &';
      cursor = close + 1;
      i = close;
    }
  }
  return cursor === 0 ? css : out + css.slice(cursor);
};

/**
 * A development build drops comments too (the minifier does it in production): the runtime scoper
 * reads a quote in a comment as the start of a string. Each becomes a space, as in the minifier.
 */
const stripCssComments = (css: string): string => {
  let out = '';
  let cursor = 0;
  for (let i = 0; i < css.length; i++) {
    const skipTo = skipNonSelectorText(css, i);
    if (skipTo === -1) continue;
    if (css.startsWith('/*', i)) {
      out += css.slice(cursor, i) + ' ';
      cursor = skipTo + 1;
    }
    i = skipTo;
  }
  return cursor === 0 ? css : out + css.slice(cursor);
};

const STATEMENT_AT_RULE = /^@(layer|charset|import|namespace)(?![\w-])/i;

/**
 * The statement at-rules the runtime scoper would read as the prelude of the next rule, which then
 * stays unscoped. `@layer a, b;` becomes `@layer a{}@layer b{}` (the same order declared);
 * `@charset` goes, as it means nothing in a style string; `@import` goes with a warning, since
 * Thane adopts every stylesheet as a constructed stylesheet, and those drop `@import`. `@namespace x
 * url(…);` stays, followed by an empty block: the scoper then copies the statement as an at-rule, and
 * the browser drops the stray `{}`, a rule with no selector.
 */
const rewriteStatementAtRules = (css: string, file: string | undefined): string => {
  let out = '';
  let cursor = 0;
  for (let i = 0; i < css.length; i++) {
    const skipTo = skipNonSelectorText(css, i);
    if (skipTo !== -1) {
      i = skipTo;
      continue;
    }
    // `@namespace` and the character after it, the longest name the pattern must see
    const name = css[i] === '@' ? STATEMENT_AT_RULE.exec(css.slice(i, i + 11))?.[1]?.toLowerCase() : undefined;
    if (!name) continue;
    // a statement ends at its `;`; a `{` or `}` first means a block (`@layer a { … }`), left alone
    let end = i + name.length + 1;
    while (end < css.length && !';{}'.includes(css[end]!)) {
      const skip = skipNonSelectorText(css, end);
      end = (skip === -1 ? end : skip) + 1;
    }
    if (css[end] !== ';') continue;
    const prelude = css.slice(i + name.length + 1, end);
    let replacement = '';
    if (name === 'layer') {
      for (const layer of prelude.split(',')) if (layer.trim()) replacement += `@layer ${layer.trim()}{}`;
    } else if (name === 'namespace') {
      replacement = `${css.slice(i, end + 1)}{}`;
    } else if (name === 'import') {
      const statement = css.slice(i, end + 1).replace(new RegExp(`${MASK_OPEN}\\d+${MASK_CLOSE}`, 'g'), '${…}');
      logger.warn(
        'css',
        `${file ?? 'a stylesheet'}: ${statement.replace(/\s+/g, ' ')} was removed. Thane applies every ` +
          'stylesheet as a constructed stylesheet, and browsers ignore @import there: load that file with a ' +
          '<link> in index.html instead.',
      );
    }
    out += css.slice(cursor, i) + replacement;
    cursor = end + 1;
    i = end;
  }
  return cursor === 0 ? css : out + css.slice(cursor);
};

/**
 * Apply the transforms to a whole stylesheet (no substitutions in it): `:host-context()` and
 * statement at-rules, renames, then minify or drop comments.
 */
export const transformCss = (css: string, options: CssTransformOptions): string => {
  let text = rewriteStatementAtRules(rewriteHostContext(css), options.file);
  if (options.selectorMap !== undefined && options.selectorMap.size > 0) {
    const selectorMap = options.selectorMap;
    text = renameCssClasses(text, (name) => selectorMap.get(name));
  }
  text = options.minify ? minifyCSS(text) : stripCssComments(text);
  if (options.onKeyframes && /@(?:-webkit-)?keyframes\s/.test(text)) options.onKeyframes();
  return text;
};

export const isCssTaggedTemplate = (node: ts.Node): node is ts.TaggedTemplateExpression =>
  ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === 'css';

/**
 * True when the module brings its own `css` (another library's tag, a local helper). Thane's
 * `css` is the import from 'thane' (or an undeclared `css`, which the type checker reports);
 * anything else is not Thane's to compile, and is neither compiled nor counted as a stylesheet
 * when selector renames are planned.
 */
export const declaresOwnCssTag = (sourceFile: ts.SourceFile): boolean => {
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (statement.moduleSpecifier.text === 'thane') continue;
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name?.text === 'css') return true;
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === 'css') return true;
      if (bindings && ts.isNamedImports(bindings) && bindings.elements.some((el) => el.name.text === 'css')) {
        return true;
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'css') {
      return true;
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === 'css') return true;
      }
    }
  }
  return false;
};

/**
 * Compile a `css` tagged template into the plain template literal that replaces it.
 *
 * The literal parts are taken from the source exactly as written (escapes included) and the
 * substitutions are located by the TypeScript parser, not by scanning for `${`: whatever an
 * expression contains (a string with a brace, a colon, another template) it is carried over
 * untouched and never read as CSS. A `css` template nested in a substitution is compiled the
 * same way.
 */
export const compileCssTemplate = (
  node: ts.TaggedTemplateExpression,
  sourceFile: ts.SourceFile,
  options: CssTransformOptions,
): string => {
  const source = sourceFile.text;
  const template = node.template;
  const cssOptions = { ...options, file: options.file ?? sourceFile.fileName };

  if (ts.isNoSubstitutionTemplateLiteral(template)) {
    const raw = source.slice(template.getStart(sourceFile) + 1, template.getEnd() - 1);
    return '`' + transformCss(raw, cssOptions) + '`';
  }

  const renderExpression = (expression: ts.Expression): string => {
    const start = expression.getStart(sourceFile);
    let text = source.slice(start, expression.getEnd());
    const nested: ts.TaggedTemplateExpression[] = [];
    const find = (child: ts.Node): void => {
      if (isCssTaggedTemplate(child)) {
        nested.push(child);
        return;
      }
      ts.forEachChild(child, find);
    };
    find(expression);
    for (const inner of nested.reverse()) {
      text =
        text.slice(0, inner.getStart(sourceFile) - start) +
        compileCssTemplate(inner, sourceFile, options) +
        text.slice(inner.getEnd() - start);
    }
    return text;
  };

  // head is `…${, a middle is }…${ and the tail is }…`
  let masked = source.slice(template.head.getStart(sourceFile) + 1, template.head.getEnd() - 2);
  const expressions: string[] = [];
  for (const span of template.templateSpans) {
    masked += MASK_OPEN + String(expressions.length) + MASK_CLOSE;
    expressions.push(renderExpression(span.expression));
    const closing = ts.isTemplateTail(span.literal) ? 1 : 2;
    masked += source.slice(span.literal.getStart(sourceFile) + 1, span.literal.getEnd() - closing);
  }

  const transformed = transformCss(masked, cssOptions);
  const restored = transformed.replace(
    new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, 'g'),
    (_match, index: string) => '${' + expressions[Number(index)]! + '}',
  );
  return '`' + restored + '`';
};
