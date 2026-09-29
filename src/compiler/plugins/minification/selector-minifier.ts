/**
 * Selector minification, planned before anything is compiled.
 *
 * A component selector lives in three places the compiler writes itself (the registration
 * call, the host element it creates for a child, tags in index.html) and in one place the
 * developer writes: stylesheets that address a component's host class (`.product-card`).
 * All of them are rewritten at compile time, from a plan made up front. Emitted JavaScript is
 * never searched or edited.
 *
 * The plan is conservative: a selector is renamed only when every appearance of its text in
 * the project's own sources is one of those places. Anything else (a route, an asset path,
 * a class attribute, a static stylesheet, a comment inside CSS) keeps the selector's name
 * everywhere, because that appearance could not be renamed along with the rest.
 */

import path from 'node:path';
import ts from 'typescript';
import { countCssClass, declaresOwnCssTag } from './css-transform.js';

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
  private stylesheets = new Set<string>();
  private nextIndex = 0;

  /**
   * Give a selector its short name. `isTaken` lets the caller refuse a generated name that
   * already means something in the project (another selector, or a class of the same spelling).
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

  /** The short name of a selector, or undefined when it keeps its own. */
  get(originalSelector: string): string | undefined {
    return this.originalToMinified.get(originalSelector);
  }

  /** Record a stylesheet file the plan read as renameable: only those are renamed in. */
  addStylesheet(filePath: string): void {
    this.stylesheets.add(normalisePath(filePath));
  }

  hasStylesheet(filePath: string): boolean {
    return this.stylesheets.has(normalisePath(filePath));
  }

  entries(): IterableIterator<[string, string]> {
    return this.originalToMinified.entries();
  }

  get size(): number {
    return this.originalToMinified.size;
  }

  clear(): void {
    this.originalToMinified.clear();
    this.stylesheets.clear();
    this.nextIndex = 0;
  }
}

const escapeRegExp = (value: string): string => value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

/** Selectors shaped like a custom element name; single words are too easily ordinary strings. */
export const isMinifiableSelector = (selector: string): boolean => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(selector);

/** How often `name` appears as a whole identifier-like token, in any context. */
export const countTokens = (text: string, name: string): number => {
  if (!text.includes(name)) return 0;
  const pattern = new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`, 'g');
  let count = 0;
  while (pattern.exec(text) !== null) count++;
  return count;
};

const tagPattern = (names: string): RegExp => new RegExp(`(</?)(${names})(?=[\\s>/])`, 'g');

/** How often the selector is used as an element tag (`<my-card`, `</my-card>`). */
export const countHtmlTags = (html: string, name: string): number => {
  let count = 0;
  const pattern = tagPattern(escapeRegExp(name));
  while (pattern.exec(html) !== null) count++;
  return count;
};

/** Rename component tags in index.html. Only tags: nothing else in the file is touched. */
export const renameSelectorsInHtml = (html: string, selectorMap: SelectorMap): string => {
  if (selectorMap.size === 0) return html;
  const names = Array.from(selectorMap.entries())
    .map(([original]) => original)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  return html.replace(tagPattern(names), (_match, open: string, name: string) => `${open}${selectorMap.get(name)}`);
};

export interface SelectorPlanInput {
  /** Every selector the compiler found in the project */
  selectors: string[];
  /** Selectors of components outside the project: never renamed, never used as a new name */
  reserved?: string[];
  /** Every TypeScript file in the project, with its parse when the build has one */
  tsFiles: Array<{ path: string; text: string; sourceFile?: ts.SourceFile | undefined }>;
  /** Every stylesheet in the project, imported by a module or not */
  cssFiles: Array<{ path: string; text: string }>;
  /** The source index.html */
  html: string;
  /**
   * Read a stylesheet that a project module imports from outside the project (a package, a
   * sibling folder). Its text is searched like everything else, and never renamed in.
   */
  readExternalStylesheet?: (specifier: string, importer: string) => string | undefined;
}

interface TextSegment {
  text: string;
  /** Text of a `css` tagged template: class selectors in it are renamed */
  isCss: boolean;
}

interface AnalysedSources {
  segments: TextSegment[];
  /** Selectors written out as the first argument of defineComponent('…', …) */
  explicitSelectors: string[];
  /** Resolved path of every relative `.css` import */
  importedCss: Set<string>;
  cssImports: Array<{ specifier: string; importer: string; resolved: string }>;
}

/** Compare paths the way the file system does: Windows paths differ in case between tools. */
export const normalisePath = (filePath: string): string => {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/**
 * Everything in the project's TypeScript that is text rather than code: string literals and
 * the literal parts of template literals. Identifiers cannot hold a hyphenated selector and
 * comments are never emitted, so neither is looked at.
 */
const analyseSources = (tsFiles: SelectorPlanInput['tsFiles']): AnalysedSources => {
  const segments: TextSegment[] = [];
  const explicitSelectors: string[] = [];
  const importedCss = new Set<string>();
  const cssImports: AnalysedSources['cssImports'] = [];

  for (const file of tsFiles) {
    const sourceFile =
      file.sourceFile ?? ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const literalText = (node: ts.Node): string => file.text.slice(node.getStart(sourceFile), node.getEnd());
    const thaneCssTag = !declaresOwnCssTag(sourceFile);

    const visit = (node: ts.Node, insideCss: boolean): void => {
      // Module specifiers are consumed by the bundler and never reach the output as written
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (specifier.endsWith('.css')) {
          const resolved = normalisePath(path.resolve(path.dirname(file.path), specifier));
          if (specifier.startsWith('.')) importedCss.add(resolved);
          cssImports.push({ specifier, importer: file.path, resolved });
        }
        return;
      }
      if (ts.isExportDeclaration(node)) return;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [specifier, ...rest] = node.arguments;
        if (specifier && !ts.isStringLiteral(specifier)) visit(specifier, false);
        for (const argument of rest) visit(argument, false);
        return;
      }

      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'defineComponent' &&
        node.arguments.length >= 2 &&
        ts.isStringLiteral(node.arguments[0]!)
      ) {
        explicitSelectors.push(node.arguments[0].text);
        for (const argument of node.arguments.slice(1)) visit(argument, false);
        return;
      }

      if (ts.isTaggedTemplateExpression(node)) {
        const isCssTag = thaneCssTag && ts.isIdentifier(node.tag) && node.tag.text === 'css';
        visit(node.tag, false);
        visit(node.template, isCssTag);
        return;
      }

      if (ts.isTemplateExpression(node)) {
        segments.push({ text: literalText(node.head), isCss: insideCss });
        for (const span of node.templateSpans) {
          visit(span.expression, false);
          segments.push({ text: literalText(span.literal), isCss: insideCss });
        }
        return;
      }

      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        segments.push({ text: literalText(node), isCss: insideCss });
        return;
      }

      ts.forEachChild(node, (child) => visit(child, false));
    };
    visit(sourceFile, false);
  }

  return { segments, explicitSelectors, importedCss, cssImports };
};

/** Decide which selectors are renamed, and to what. Pure: everything it reads is passed in. */
export const planSelectorRenames = (input: SelectorPlanInput): SelectorMap => {
  const selectorMap = new SelectorMap();
  const candidates = Array.from(new Set(input.selectors)).filter(isMinifiableSelector).sort();
  if (candidates.length === 0) return selectorMap;

  const { segments, explicitSelectors, importedCss, cssImports } = analyseSources(input.tsFiles);

  // Stylesheets imported from outside the project are searched, but are not the project's to rename in
  const projectCss = new Set(input.cssFiles.map((file) => normalisePath(file.path)));
  const externalCss: string[] = [];
  for (const cssImport of cssImports) {
    if (projectCss.has(cssImport.resolved)) continue;
    const text = input.readExternalStylesheet?.(cssImport.specifier, cssImport.importer);
    if (text !== undefined) externalCss.push(text);
  }

  const countEverywhere = (name: string): number => {
    let total = countTokens(input.html, name) + explicitSelectors.filter((selector) => selector === name).length;
    for (const segment of segments) total += countTokens(segment.text, name);
    for (const file of input.cssFiles) total += countTokens(file.text, name);
    for (const text of externalCss) total += countTokens(text, name);
    return total;
  };

  const countRenameable = (name: string): number => {
    let renameable = countHtmlTags(input.html, name) + explicitSelectors.filter((selector) => selector === name).length;
    for (const segment of segments) if (segment.isCss) renameable += countCssClass(segment.text, name);
    for (const file of input.cssFiles) {
      if (importedCss.has(normalisePath(file.path))) renameable += countCssClass(file.text, name);
    }
    return renameable;
  };

  for (const file of input.cssFiles) {
    if (importedCss.has(normalisePath(file.path))) selectorMap.addStylesheet(file.path);
  }

  const known = new Set([...input.selectors, ...(input.reserved ?? [])]);
  for (const selector of candidates) {
    if (countEverywhere(selector) !== countRenameable(selector)) continue;
    selectorMap.register(selector, (name) => known.has(name) || countEverywhere(name) > 0);
  }
  return selectorMap;
};
