/**
 * What the compiler knows of the routes' heads from the source alone:
 * - whether the app uses head support at all: a production build leaves the head renderer out when it
 *   does not (`__THANE_HEAD__`);
 * - the static values of each route's head, which a production build writes into the route's own
 *   `index.html`, for crawlers and link-preview bots that do not run JavaScript;
 * - the value types of the custom fields, which the generated route types give `setMeta()`.
 *
 * Values are read, not run: literals, objects, arrays, template strings, `+`, and `const` names in the
 * file or imported from the project's own files. Anything else is left to the browser.
 */
import path from 'node:path';
import ts from 'typescript';
import { safeReadFile, sourceCache } from '../../utils/index.js';
import { collectModuleGraph, createModuleResolver, type ModuleResolver } from '../../utils/module-graph.js';
import {
  headTagHtml,
  headTagKey,
  linkTag,
  metaName,
  metaProperty,
  resolveHead,
  type CustomMetaFields,
  type HeadTag,
} from '../../../runtime/router-head.js';

/** A value the source does not give statically */
const UNKNOWN: unique symbol = Symbol('unknown');
type Value = unknown;

/** A custom field as the source declares it */
export type CustomFieldSource =
  | { kind: 'name' | 'property'; id: string }
  | { kind: 'link'; rel: string; attributes: Record<string, string> }
  | { kind: 'function'; valueType: string };

export interface RouteTableHead {
  /** The file with the defineRoutes() call */
  file: string;
  /** The site's meta, as far as it is static */
  site: Record<string, unknown>;
  custom: Record<string, CustomFieldSource>;
  /** Every route but notFound and error; `meta` is null when the route computes it (a function) */
  routes: Array<{ path: string; meta: Record<string, unknown> | null }>;
  /** True when anything beyond a route title is used, or cannot be told */
  usesHead: boolean;
  /** True when a route has `canEnter` or `redirectTo`, or when that cannot be told */
  usesGuards: boolean;
  /** What could not be read, for a verbose note */
  notes: string[];
}

const HELPERS = new Set(['metaName', 'metaProperty', 'linkTag']);
const MAX_DEPTH = 8;

const propertyName = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) ||
  ts.isStringLiteral(name) ||
  ts.isNumericLiteral(name) ||
  ts.isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : null;

const unwrap = (node: ts.Expression): ts.Expression => {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
};

/** Imports of a file: local name to module specifier and imported name (`default` for a default import) */
const importsOf = (sourceFile: ts.SourceFile): Map<string, { specifier: string; name: string }> => {
  const imports = new Map<string, { specifier: string; name: string }>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    const specifier = statement.moduleSpecifier.text;
    if (clause.name) imports.set(clause.name.text, { specifier, name: 'default' });
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        imports.set(element.name.text, { specifier, name: (element.propertyName ?? element.name).text });
      }
    }
  }
  return imports;
};

/** The initializer of a top-level `const name = …` in the file, or of the export `name` */
const constInitializer = (sourceFile: ts.SourceFile, name: string, exported: boolean): ts.Expression | null => {
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
      const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
          if (!exported || isExported) return declaration.initializer;
        }
      }
    }
    if (exported && name === 'default' && ts.isExportAssignment(statement) && !statement.isExportEquals) {
      return statement.expression;
    }
    // export { local as name }
    if (exported && ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.name.text === name)
            return constInitializer(sourceFile, (element.propertyName ?? element.name).text, false);
        }
      }
    }
  }
  return null;
};

class StaticReader {
  constructor(private readonly resolve: ModuleResolver) {}

  /** The value of `node` in `file`, or UNKNOWN */
  async value(node: ts.Expression, file: ts.SourceFile, depth = 0): Promise<Value | typeof UNKNOWN> {
    if (depth > MAX_DEPTH) return UNKNOWN;
    node = unwrap(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(node.operand)
    ) {
      return -Number(node.operand.text);
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const part = await this.value(span.expression, file, depth + 1);
        if (part === UNKNOWN || (typeof part !== 'string' && typeof part !== 'number')) return UNKNOWN;
        text += String(part) + span.literal.text;
      }
      return text;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = await this.value(node.left, file, depth + 1);
      const right = await this.value(node.right, file, depth + 1);
      if (
        (typeof left === 'string' || typeof left === 'number') &&
        (typeof right === 'string' || typeof right === 'number')
      ) {
        return (left as string) + (right as string);
      }
      return UNKNOWN;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const items: unknown[] = [];
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) {
          const spread = await this.value(element.expression, file, depth + 1);
          if (!Array.isArray(spread)) return UNKNOWN;
          items.push(...spread);
        } else {
          const item = await this.value(element, file, depth + 1);
          if (item === UNKNOWN) return UNKNOWN;
          items.push(item);
        }
      }
      return items;
    }
    if (ts.isObjectLiteralExpression(node)) return this.object(node, file, depth);
    if (ts.isIdentifier(node)) return this.identifier(node.text, file, depth);
    if (ts.isPropertyAccessExpression(node)) {
      const target = await this.value(node.expression, file, depth + 1);
      return target && typeof target === 'object' && node.name.text in target
        ? (target as Record<string, unknown>)[node.name.text]
        : UNKNOWN;
    }
    return UNKNOWN;
  }

  /** An object literal's static properties; a property that is not static is left out */
  async object(node: ts.ObjectLiteralExpression, file: ts.SourceFile, depth: number, unknownKeys?: string[]) {
    const out: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = await this.value(property.expression, file, depth + 1);
        if (spread && typeof spread === 'object') Object.assign(out, spread);
        else unknownKeys?.push('...');
        continue;
      }
      const name = property.name && propertyName(property.name as ts.PropertyName);
      if (!name) {
        unknownKeys?.push('[computed]');
        continue;
      }
      const initializer = ts.isPropertyAssignment(property)
        ? property.initializer
        : ts.isShorthandPropertyAssignment(property)
          ? property.name
          : null;
      const value = initializer ? await this.value(initializer, file, depth + 1) : UNKNOWN;
      if (value === UNKNOWN) unknownKeys?.push(name);
      else out[name] = value;
    }
    return out;
  }

  private async identifier(name: string, file: ts.SourceFile, depth: number): Promise<Value | typeof UNKNOWN> {
    if (name === 'undefined') return undefined;
    const local = constInitializer(file, name, false);
    if (local) return this.value(local, file, depth + 1);
    const imported = importsOf(file).get(name);
    if (!imported) return UNKNOWN;
    const target = this.resolve(imported.specifier, file.fileName);
    const cached = target ? await sourceCache.get(target) : null;
    if (!cached) return UNKNOWN;
    const exported = constInitializer(cached.sourceFile, imported.name, true);
    return exported ? this.value(exported, cached.sourceFile, depth + 1) : UNKNOWN;
  }
}

/** The text of a type as the generated file can name it, or null when it names a type that file cannot see */
const typeText = (type: ts.TypeNode, file: ts.SourceFile, generatedFile: string): string | null => {
  const imports = importsOf(file);
  const declared = new Map<string, boolean>(); // local type name → exported
  for (const statement of file.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      declared.set(
        statement.name.text,
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false,
      );
    }
  }
  const fromGenerated = (target: string): string => {
    const relative = path.relative(path.dirname(generatedFile), target).replace(/\\/g, '/');
    return relative.startsWith('.') ? relative : `./${relative}`;
  };
  const edits: Array<[start: number, end: number, text: string]> = [];
  let visible = true;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const first = ts.isIdentifier(node.typeName) ? node.typeName : leftmost(node.typeName);
      const name = first.text;
      const imported = imports.get(name);
      if (imported) {
        const specifier = imported.specifier.startsWith('.')
          ? fromGenerated(path.resolve(path.dirname(file.fileName), imported.specifier))
          : imported.specifier;
        const member = imported.name === 'default' ? 'default' : imported.name;
        edits.push([first.getStart(file), first.end, `import('${specifier}').${member}`]);
      } else if (declared.has(name)) {
        if (declared.get(name)) {
          const own = fromGenerated(file.fileName).replace(/\.ts$/, '.js');
          edits.push([first.getStart(file), first.end, `import('${own}').${name}`]);
        } else {
          visible = false;
        }
      }
    }
    if (ts.isTypeQueryNode(node)) visible = false; // `typeof x` names a value the generated file cannot see
    ts.forEachChild(node, visit);
  };
  visit(type);
  if (!visible) return null;
  let text = file.text.slice(type.getStart(file), type.end);
  const offset = type.getStart(file);
  for (const [start, end, replacement] of edits.reverse()) {
    text = text.slice(0, start - offset) + replacement + text.slice(end - offset);
  }
  return text;
};

const leftmost = (name: ts.EntityName): ts.Identifier => (ts.isIdentifier(name) ? name : leftmost(name.left));

const isDefineRoutesCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineRoutes';

/** The custom fields of `customMeta: { … }` */
const readCustomFields = async (
  node: ts.Expression,
  file: ts.SourceFile,
  reader: StaticReader,
  generatedFile: string,
  notes: string[],
): Promise<Record<string, CustomFieldSource>> => {
  const out: Record<string, CustomFieldSource> = {};
  node = unwrap(node);
  if (!ts.isObjectLiteralExpression(node)) {
    notes.push('customMeta is not an object literal: its fields are typed as unknown in setMeta()');
    return out;
  }
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = propertyName(property.name);
    if (!key) continue;
    const init = unwrap(property.initializer);
    if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && HELPERS.has(init.expression.text)) {
      const args: unknown[] = [];
      for (const arg of init.arguments) args.push(await reader.value(arg, file));
      const [first, second] = args;
      if (typeof first !== 'string') {
        notes.push(
          `customMeta.${key}: the ${init.expression.text}() argument is not static; it is applied in the browser only`,
        );
        out[key] = { kind: 'function', valueType: 'string' };
      } else if (init.expression.text === 'linkTag') {
        const attributes = second && typeof second === 'object' ? (second as Record<string, string>) : {};
        out[key] = { kind: 'link', rel: first, attributes };
      } else {
        out[key] = { kind: init.expression.text === 'metaName' ? 'name' : 'property', id: first };
      }
    } else if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      const parameter = init.parameters[0];
      const type = parameter?.type ? typeText(parameter.type, file, generatedFile) : 'unknown';
      if (type === null)
        notes.push(
          `customMeta.${key}: its value type names a type that is not exported; setMeta() takes it as unknown`,
        );
      out[key] = { kind: 'function', valueType: type ?? 'unknown' };
    } else {
      out[key] = { kind: 'function', valueType: 'unknown' };
    }
  }
  return out;
};

/** Every defineRoutes() table in `file` and what its heads say */
export const readRouteTableHeads = async (
  file: string,
  resolve: ModuleResolver,
  /** Where the generated route types go: the types that custom fields name are written relative to it */
  generatedFile: string = file,
): Promise<RouteTableHead[]> => {
  const cached = await sourceCache.get(file);
  if (!cached || !cached.source.includes('defineRoutes(')) return [];
  const sourceFile = cached.sourceFile;
  const reader = new StaticReader(resolve);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (isDefineRoutesCall(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const tables: RouteTableHead[] = [];
  for (const call of calls) {
    const notes: string[] = [];
    const [routesArg, optionsArg] = call.arguments;
    let usesHead = optionsArg !== undefined;
    let usesGuards = false;
    let site: Record<string, unknown> = {};
    let custom: Record<string, CustomFieldSource> = {};
    const options = optionsArg && unwrap(optionsArg);
    if (options && ts.isObjectLiteralExpression(options)) {
      for (const property of options.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = propertyName(property.name);
        if (key === 'meta') {
          const unknownKeys: string[] = [];
          const init = unwrap(property.initializer);
          const value = ts.isObjectLiteralExpression(init)
            ? await reader.object(init, sourceFile, 0, unknownKeys)
            : await reader.value(init, sourceFile);
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            site = value as Record<string, unknown>;
          } else {
            notes.push('the site meta is not static: it is applied in the browser only');
          }
          if (unknownKeys.length > 0)
            notes.push(`site meta ${unknownKeys.join(', ')}: not static, applied in the browser only`);
        } else if (key === 'customMeta') {
          custom = await readCustomFields(property.initializer, sourceFile, reader, generatedFile, notes);
        }
      }
    } else if (options) {
      notes.push('the defineRoutes() options are not an object literal: route heads are applied in the browser only');
    }

    const routes: RouteTableHead['routes'] = [];
    const table = routesArg && unwrap(routesArg);
    if (!table || !ts.isObjectLiteralExpression(table)) {
      usesHead = true; // cannot tell
      tables.push({ file, site, custom, routes, usesHead, usesGuards: true, notes });
      continue;
    }
    for (const property of table.properties) {
      if (!ts.isPropertyAssignment(property)) {
        usesHead = true;
        usesGuards = true;
        continue;
      }
      const routePath = propertyName(property.name);
      if (!routePath) continue;
      const route = unwrap(property.initializer);
      if (!ts.isObjectLiteralExpression(route)) {
        usesHead = true;
        usesGuards = true;
        if (routePath !== 'notFound' && routePath !== 'error') routes.push({ path: routePath, meta: null });
        continue;
      }
      let meta: Record<string, unknown> | null = {};
      for (const routeProperty of route.properties) {
        // A guard or a redirect, or a property that cannot be read (a spread): the router keeps its guard step
        const name = ts.isSpreadAssignment(routeProperty) ? null : propertyName(routeProperty.name);
        if (name === null || name === 'canEnter' || name === 'redirectTo') usesGuards = true;
        if (!ts.isPropertyAssignment(routeProperty) || name !== 'meta') continue;
        const init = unwrap(routeProperty.initializer);
        if (ts.isObjectLiteralExpression(init)) {
          const unknownKeys: string[] = [];
          meta = await reader.object(init, sourceFile, 0, unknownKeys);
          if (unknownKeys.length > 0) {
            notes.push(`${routePath}: meta ${unknownKeys.join(', ')} not static, applied in the browser only`);
          }
          if (unknownKeys.length > 0 || Object.keys(meta).some((k) => k !== 'title')) usesHead = true;
        } else {
          const value =
            ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? UNKNOWN : await reader.value(init, sourceFile);
          usesHead = true;
          meta = value !== UNKNOWN && value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
          if (meta === null) notes.push(`${routePath}: its meta is computed, applied in the browser only`);
        }
      }
      if (routePath !== 'notFound' && routePath !== 'error') routes.push({ path: routePath, meta });
    }
    tables.push({ file, site, custom, routes, usesHead, usesGuards, notes });
  }
  return tables;
};

/** Whether `file` imports setMeta from thane/router: the head renderer is then needed */
export const importsSetMeta = async (file: string): Promise<boolean> => {
  const cached = await sourceCache.get(file);
  if (!cached || !cached.source.includes('setMeta')) return false;
  for (const [, binding] of importsOf(cached.sourceFile)) {
    if (binding.name === 'setMeta' && binding.specifier === 'thane/router') return true;
  }
  return false;
};

/** The custom fields the build can render: those declared with a helper */
const staticCustomFields = (custom: Record<string, CustomFieldSource>): CustomMetaFields => {
  const fields: CustomMetaFields = {};
  for (const [key, field] of Object.entries(custom)) {
    if (field.kind === 'name') fields[key] = metaName(field.id);
    else if (field.kind === 'property') fields[key] = metaProperty(field.id);
    else if (field.kind === 'link') fields[key] = linkTag(field.rel, field.attributes);
  }
  return fields;
};

const decodeAttribute = (value: string): string =>
  value.replace(/&(amp|quot|#39|apos|lt|gt);/g, (_, e: string) =>
    e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'lt' ? '<' : e === 'gt' ? '>' : "'",
  );

/** A head tag written in HTML (`<meta name="description" content="…">`) as a HeadTag */
const parseTag = (kind: 'meta' | 'link' | 'script', source: string, text = ''): HeadTag => {
  const attributes: Record<string, string> = {};
  const body = source.slice(kind.length + 1).replace(/\/?>$/, '');
  for (const match of body.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attributes[match[1]!.toLowerCase()] = decodeAttribute(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return (kind === 'script' ? { script: { ...attributes, text } } : { [kind]: attributes }) as HeadTag;
};

/**
 * `html` with the head of one page: its `<title>`, and its tags in place of any the head already has
 * with the same key (the same rule the router follows in the browser).
 */
export const withHead = (html: string, head: { title: string | undefined; tags: HeadTag[] }): string => {
  const close = html.search(/<\/head>/i);
  if (close === -1) return html;
  const keys = new Set(head.tags.map(headTagKey));
  let start = html.search(/<head[\s>]/i);
  if (start === -1) start = 0;
  let before = html.slice(0, close);
  const region = before.slice(start);
  const kept = region
    .replace(
      /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi,
      (tag, text: string) =>
        keys.has(headTagKey(parseTag('script', tag.slice(0, tag.indexOf('>') + 1), text))) ? '' : tag,
    )
    .replace(/<(meta|link)\b[^>]*>/gi, (tag, kind: string) =>
      keys.has(headTagKey(parseTag(kind.toLowerCase() as 'meta' | 'link', tag))) ? '' : tag,
    )
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, (tag) => (head.title === undefined ? tag : ''));
  before = before.slice(0, start) + kept;
  const title = head.title === undefined ? '' : `<title>${escapeText(head.title)}</title>`;
  return before + title + head.tags.map(headTagHtml).join('') + html.slice(close);
};

const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The pages a production build writes for a route table: every route without parameters, with its
 * static head. `/` is the root `index.html`; `/about` is `about/index.html`.
 */
export const routePages = (html: string, table: RouteTableHead): Array<{ file: string; html: string }> => {
  const custom = staticCustomFields(table.custom);
  const pages: Array<{ file: string; html: string }> = [];
  for (const route of table.routes) {
    if (route.path.includes(':') || !route.path.startsWith('/')) continue;
    const head = resolveHead(table.site as never, (route.meta ?? {}) as never, route.path, custom);
    const file = route.path === '/' ? 'index.html' : `${route.path.replace(/^\/+|\/+$/g, '')}/index.html`;
    pages.push({ file, html: withHead(html, head) });
  }
  return pages;
};

/**
 * The route tables the entry points reach, and whether the app needs head support: another app's
 * routes elsewhere in the project change nothing in this one.
 */
/**
 * Whether markup holds a plain link to what may be a route: an `<a>` without a click handler of its own
 * whose `href` is a path (`/about`, `./x`) or an expression, which the router's link handling follows in
 * the app. An `href` to another site, `mailto:` or `#` never is. A tag that the scan cuts short (a `>`
 * inside an expression) may be missed; such a link then loads the page, as without the link handling.
 */
export const hasPlainLink = (markup: string): boolean => {
  for (const [tag] of markup.matchAll(/<a\s[^>]*>/gi)) {
    if (/\shref\s*=\s*["']?(\/(?!\/)|\.{1,2}\/|\$\{)/i.test(tag) && !/\s@click\b/.test(tag)) return true;
  }
  return false;
};

export const routeTablesOf = async (
  entryPoints: string[],
  projectRoot: string,
  htmlFile?: string,
): Promise<{ tables: RouteTableHead[]; usesHead: boolean; usesGuards: boolean; usesLinks: boolean }> => {
  const resolve = createModuleResolver(projectRoot);
  const tables: RouteTableHead[] = [];
  let usesSetMeta = false;
  let usesLinks = htmlFile !== undefined && hasPlainLink((await safeReadFile(htmlFile)) ?? '');
  for (const file of await collectModuleGraph(entryPoints, resolve)) {
    tables.push(...(await readRouteTableHeads(file, resolve)));
    if (await importsSetMeta(file)) usesSetMeta = true;
    if (!usesLinks) usesLinks = hasPlainLink((await sourceCache.get(file))?.source ?? '');
  }
  return {
    tables,
    usesHead: usesSetMeta || tables.some((table) => table.usesHead),
    usesGuards: tables.some((table) => table.usesGuards),
    usesLinks,
  };
};
