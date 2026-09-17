/**
 * Compile-time transforms for stylesheet text the compiler owns: a `css` tagged template or an
 * imported `.css` file. The text is known to be CSS here, so nothing has to be guessed from its
 * content, and no emitted JavaScript is ever involved.
 */

import ts from 'typescript';
import { minifyCSS } from './template-minifier.js';
import type { SelectorMap } from './selector-minifier.js';

// Private-use characters: never part of an identifier, never CSS syntax, never in real source.
// A `${…}` substitution of a `css` template is replaced by MASK_OPEN <index> MASK_CLOSE while
// the stylesheet around it is transformed.
const MASK_OPEN = '';
const MASK_CLOSE = '';

const isIdentStart = (ch: string | undefined): boolean => ch !== undefined && /[a-zA-Z_-]/.test(ch);
const isIdentChar = (ch: string | undefined): boolean => ch !== undefined && /[\w-]/.test(ch);

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

    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? length : end + 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      let end = i + 1;
      while (end < length && css[end] !== ch) {
        if (css[end] === '\\') end++;
        end++;
      }
      i = end;
      continue;
    }

    if ((ch === 'u' || ch === 'U') && /^url\(/i.test(css.slice(i, i + 4)) && !isIdentChar(css[i - 1])) {
      let end = i + 4;
      while (end < length && /\s/.test(css[end]!)) end++;
      // a quoted url("…") is skipped by the string branch on the next iterations
      if (css[end] !== '"' && css[end] !== "'") {
        const close = css.indexOf(')', end);
        i = close === -1 ? length : close;
      } else {
        i = end - 1;
      }
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
}

/** Apply the production transforms to a whole stylesheet (no substitutions in it). */
export const transformCss = (css: string, options: CssTransformOptions): string => {
  let text = css;
  if (options.selectorMap !== undefined && options.selectorMap.size > 0) {
    const selectorMap = options.selectorMap;
    text = renameCssClasses(text, (name) => selectorMap.get(name));
  }
  if (options.minify) text = minifyCSS(text);
  return text;
};

export const isCssTaggedTemplate = (node: ts.Node): node is ts.TaggedTemplateExpression =>
  ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === 'css';

/**
 * True when the module brings its own `css` (another library's tag, a local helper). Thane's
 * `css` is a global, or an import from 'thane'; anything else is not Thane's to compile, and
 * is neither compiled nor counted as a stylesheet when selector renames are planned.
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

  if (ts.isNoSubstitutionTemplateLiteral(template)) {
    const raw = source.slice(template.getStart(sourceFile) + 1, template.getEnd() - 1);
    return '`' + transformCss(raw, options) + '`';
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

  const transformed = transformCss(masked, options);
  const restored = transformed.replace(
    new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, 'g'),
    (_match, index: string) => '${' + expressions[Number(index)]! + '}',
  );
  return '`' + restored + '`';
};
