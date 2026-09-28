/** Reactive binding compiler — source transformation and template processing. */

import fs from 'node:fs';
import type { Plugin } from 'esbuild';
import ts from 'typescript';
import type { ImportInfo, TemplateInfo } from '../../types.js';
import {
  findSignalInitializers,
  isHtmlTemplate,
  isDefineComponentCall,
  pascalToKebab,
  applyEdits,
  sourceCache,
  logger,
  hasHtmlTemplates,
  extendsComponentQuick,
  createLoaderResult,
  PLUGIN_NAME,
  BIND_FN,
} from '../../utils/index.js';
import { getSetupFunction, unwrapParens } from '../../utils/component-ast.js';
import type { BindingInfo, ConditionalBlock, WhenElseBlock, RepeatBlock, EventBinding } from './types.js';
import { CLOSURE_ACCESS } from './types.js';
import type { AccessPattern } from './types.js';
import { minifyHTML } from '../minification/template-minifier.js';
import { compileCssTemplate, declaresOwnCssTag, isCssTaggedTemplate } from '../minification/css-transform.js';
import type { SelectorMap } from '../minification/selector-minifier.js';
import { processHtmlTemplateWithConditionals } from './template-processing.js';
import { walkDirectives } from './directive-tree.js';
import type { ChildMountInfo } from '../component-precompiler/component-precompiler.js';

// ============================================================================
// Lifecycle hook stripping
// ============================================================================

/** Property names eligible for dead-code removal when their body is empty */
const STRIPPABLE_LIFECYCLE = new Set(['onMount', 'onDestroy']);

/** Properties that should be stripped when a compiled template is injected */
const STRIPPABLE_TEMPLATE = new Set(['template']);

/**
 * Check if an arrow function or function expression has an empty body.
 * Matches: `() => {}` and `() => { }` (with optional whitespace).
 */
const isEmptyArrowFunction = (node: ts.Node): boolean => {
  if (ts.isArrowFunction(node)) {
    const body = node.body;
    return ts.isBlock(body) && body.statements.length === 0;
  }
  return false;
};

/** Find the defineComponent return object */
const findReturnObject = (sf: ts.SourceFile): ts.ObjectLiteralExpression | null => {
  let returnObj: ts.ObjectLiteralExpression | null = null;
  const find = (node: ts.Node) => {
    if (returnObj) return;
    if (ts.isCallExpression(node) && isDefineComponentCall(node)) {
      const setupArg = getSetupFunction(node);
      if (setupArg) {
        if (ts.isArrowFunction(setupArg) && !ts.isBlock(setupArg.body)) {
          const bodyExpr = unwrapParens(setupArg.body);
          if (ts.isObjectLiteralExpression(bodyExpr)) {
            returnObj = bodyExpr;
            return;
          }
        }

        const findReturn = (n: ts.Node) => {
          if (returnObj) return;
          if (ts.isArrowFunction(n) && n !== setupArg) return;
          if (ts.isFunctionExpression(n) && n !== setupArg) return;
          if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression)) {
            returnObj = n.expression;
          }
          ts.forEachChild(n, findReturn);
        };
        findReturn(setupArg);
      }
    }
    ts.forEachChild(node, find);
  };
  find(sf);
  return returnObj;
};

/** Detect the styles/lifecycle feature flags of the defineComponent return object. */
const detectFeatures = (
  returnObj: ts.ObjectLiteralExpression | null,
): { hasStyles: boolean; hasLifecycle: boolean } => {
  let hasStyles = false;
  let hasLifecycle = false;

  for (const prop of returnObj?.properties ?? []) {
    // Handle shorthand property assignment: return { styles }
    if (ts.isShorthandPropertyAssignment(prop)) {
      if (prop.name.text === 'styles') {
        hasStyles = true;
      }
      continue;
    }

    if (!ts.isPropertyAssignment(prop)) continue;
    const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
    if (!name) continue;

    // ── Feature detection (styles) ──
    // Supports both inline css`` and imported CSS file strings
    if (name === 'styles') {
      hasStyles = true;
    }

    // ── Feature detection (lifecycle) — non-empty hooks that survive stripping ──
    if (STRIPPABLE_LIFECYCLE.has(name) && !isEmptyArrowFunction(prop.initializer)) {
      hasLifecycle = true;
    }
  }

  return { hasStyles, hasLifecycle };
};

/**
 * Strip empty lifecycle hooks and redundant `template` property from the
 * defineComponent return object. Styles and non-empty hooks are kept: the runtime needs them.
 */
const stripDeadProperties = (source: string, hasCompiledTemplate: boolean): string => {
  const sf = ts.createSourceFile('__strip.ts', source, ts.ScriptTarget.Latest, true);
  const returnObj = findReturnObject(sf);
  if (!returnObj) return source;

  // Collect ranges to remove (in reverse order for safe splicing)
  const removals: Array<{ start: number; end: number }> = [];

  for (const prop of returnObj.properties) {
    // shorthand props are never strippable
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
    if (!name) continue;

    // ── Strippable properties ──
    const shouldStripLifecycle = STRIPPABLE_LIFECYCLE.has(name) && isEmptyArrowFunction(prop.initializer);
    const shouldStripTemplate = hasCompiledTemplate && STRIPPABLE_TEMPLATE.has(name);

    if (!shouldStripLifecycle && !shouldStripTemplate) continue;

    // Calculate the full removal range including leading/trailing comma + whitespace
    let start = prop.getStart(sf);
    let end = prop.getEnd();

    // Extend to eat the trailing comma if present
    const textAfter = source.substring(end);
    const trailingCommaMatch = textAfter.match(/^\s*,/);
    if (trailingCommaMatch) {
      end += trailingCommaMatch[0].length;
    }

    // Extend to eat the preceding whitespace/newline so we don't leave blank lines
    const textBefore = source.substring(0, start);
    const precedingWhitespaceMatch = textBefore.match(/[\t ]*$/);
    if (precedingWhitespaceMatch) {
      start -= precedingWhitespaceMatch[0].length;
      // Also eat a preceding newline if present
      if (start > 0 && source[start - 1] === '\n') {
        start--;
        if (start > 0 && source[start - 1] === '\r') start--;
      }
    }

    removals.push({ start, end });
  }

  if (removals.length === 0) return source;

  // Apply removals in reverse order
  let modified = source;
  for (const { start, end } of removals.reverse()) {
    modified = modified.substring(0, start) + modified.substring(end);
  }

  return modified;
};
import { generateInitBindingsFunction, generateStaticTemplate, generateUpdatedImport } from './codegen.js';
import { ErrorCode, createError } from '../../errors.js';

const NAME = PLUGIN_NAME.REACTIVE;

/**
 * Compute a deterministic starting seed for generated binding ids (b0, b1, …).
 * Assigns each file a stable, non-overlapping id range to avoid DOM collisions.
 */
const computeInitialIdSeed = (filePath: string, source: string): number => {
  // FNV-1a 32-bit hash of normalized file path (fast, deterministic)
  let hash = 0x811c9dc5;
  for (let i = 0; i < filePath.length; i++) {
    hash ^= filePath.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const unsigned = hash >>> 0;

  // Allocate a file-specific block of ids. 1000 ids per file keeps generated
  // ids short while providing room for typical component templates.
  const blockBase = (unsigned % 100000) * 1000;

  // Respect any already-inserted bN ids present in the source (e.g. CTFE child mounts)
  // so the next generated id does not overlap.
  let maxExisting = -1;
  const idRegex = /id="b(\d+)"/g;
  let match: RegExpExecArray | null;
  while ((match = idRegex.exec(source)) !== null) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > maxExisting) maxExisting = n;
  }

  return Math.max(blockBase, maxExisting + 1);
};

/** Check if a module specifier refers to the Thane runtime. */
export const isThaneRuntimeImport = (specifier: string): boolean => {
  return (
    specifier.includes('shadow-dom') ||
    specifier.includes('dom/index') ||
    specifier === 'thane' ||
    specifier.startsWith('thane/')
  );
};

/** Find the Thane runtime import in a source file. */
export const findServicesImport = (sourceFile: ts.SourceFile): ImportInfo | null => {
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;

      if (isThaneRuntimeImport(specifier)) {
        const namedImports: string[] = [];

        if (statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
          for (const element of statement.importClause.namedBindings.elements) {
            namedImports.push(element.name.text);
          }
        }

        const fullText = statement.moduleSpecifier.getFullText(sourceFile);
        const quoteChar = fullText.includes("'") ? "'" : '"';
        const normalizedSpecifier =
          specifier === 'thane' || specifier.startsWith('thane/')
            ? specifier
            : specifier.includes('shadow-dom')
              ? specifier.replace('shadow-dom.js', 'index.js').replace('shadow-dom', 'index')
              : specifier;

        return {
          namedImports,
          moduleSpecifier: normalizedSpecifier,
          start: statement.getStart(sourceFile),
          end: statement.getEnd(),
          quoteChar,
        };
      }
    }
  }
  return null;
};

// ============================================================================
// defineComponent Support
// ============================================================================

/**
 * Recursively extract template content from an html tagged template,
 * inlining any ${identifier} references that resolve to other html`` fragment variables.
 */
const extractAndInlineFragment = (
  tplNode: ts.TaggedTemplateExpression,
  sourceFile: ts.SourceFile,
  scopeRoot: ts.Node,
  visited: Set<string>,
): string => {
  const templateLiteral = tplNode.template;

  if (ts.isNoSubstitutionTemplateLiteral(templateLiteral)) {
    return templateLiteral.text;
  }

  if (!ts.isTemplateExpression(templateLiteral)) return '';

  let content = templateLiteral.head.text;
  for (const span of templateLiteral.templateSpans) {
    const expr = span.expression;
    if (ts.isIdentifier(expr) && !visited.has(expr.text)) {
      const resolved = resolveTemplateIdentifier(sourceFile, scopeRoot, expr);
      if (resolved) {
        visited.add(expr.text);
        content += extractAndInlineFragment(resolved, sourceFile, scopeRoot, visited);
        content += span.literal.text;
        continue;
      }
    }
    const exprText = span.expression.getText(sourceFile);
    content += '${' + exprText + '}';
    content += span.literal.text;
  }
  return content;
};

const resolveTemplateIdentifier = (
  sourceFile: ts.SourceFile,
  scopeRoot: ts.Node,
  identifier: ts.Identifier,
): ts.TaggedTemplateExpression | null => {
  let resolved: ts.TaggedTemplateExpression | null = null;

  const visit = (node: ts.Node) => {
    if (resolved) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === identifier.text) {
      if (node.initializer && ts.isTaggedTemplateExpression(node.initializer) && isHtmlTemplate(node.initializer)) {
        resolved = node.initializer;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(scopeRoot);
  if (resolved) return resolved;

  let moduleResolved: ts.TaggedTemplateExpression | null = null;
  const visitModule = (node: ts.Node) => {
    if (moduleResolved) return;
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== identifier.text) continue;
        if (decl.initializer && ts.isTaggedTemplateExpression(decl.initializer) && isHtmlTemplate(decl.initializer)) {
          moduleResolved = decl.initializer;
          return;
        }
      }
    }
    ts.forEachChild(node, visitModule);
  };
  visitModule(sourceFile);
  return moduleResolved;
};

/**
 * Find html`` templates in the defineComponent return object only.
 * Fragment templates (const piece = html`...`) are intentionally skipped.
 */
const findHtmlTemplates = (
  sourceFile: ts.SourceFile,
  setupArg: ts.ArrowFunction | ts.FunctionExpression,
): TemplateInfo[] => {
  const templates: TemplateInfo[] = [];
  const seen = new Set<number>();

  const collectFromReturnObject = (obj: ts.ObjectLiteralExpression) => {
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== 'template') continue;

      let tplNode: ts.TaggedTemplateExpression | null = null;
      if (ts.isTaggedTemplateExpression(prop.initializer) && isHtmlTemplate(prop.initializer)) {
        tplNode = prop.initializer;
      } else if (ts.isIdentifier(prop.initializer)) {
        tplNode = resolveTemplateIdentifier(sourceFile, setupArg, prop.initializer);
      }

      if (!tplNode) continue;
      const start = tplNode.getStart(sourceFile);
      if (seen.has(start)) continue;
      seen.add(start);
      templates.push({
        node: tplNode,
        expressions: [],
        templateStart: start,
        templateEnd: tplNode.getEnd(),
      });
    }
  };

  // Handle expression-body arrows: () => ({ template: html`...` })
  // The body is a ParenthesizedExpression wrapping an ObjectLiteralExpression,
  // not a Block with a ReturnStatement, so we unwrap it directly.
  if (ts.isArrowFunction(setupArg) && !ts.isBlock(setupArg.body)) {
    // Unwrap parenthesized expression: () => ({...}) parses as Paren(ObjLiteral)
    const expr = unwrapParens(setupArg.body);
    if (ts.isObjectLiteralExpression(expr)) {
      collectFromReturnObject(expr);
    }
    return templates;
  }

  const visitSetup = (node: ts.Node) => {
    if (ts.isArrowFunction(node) && node !== setupArg) return;
    if (ts.isFunctionExpression(node) && node !== setupArg) return;
    if (ts.isFunctionDeclaration(node)) return;

    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      collectFromReturnObject(node.expression);
    }

    ts.forEachChild(node, visitSetup);
  };

  visitSetup(setupArg);
  return templates;
};

/**
 * Transform a defineComponent source file by processing HTML templates,
 * generating binding code, and injecting static templates.
 *
 * The pipeline natively supports defineComponent's closure-based access pattern:
 * 1. Parse templates directly — bare signal() calls are detected by the regex pipeline
 * 2. Run template processing and codegen with CLOSURE_ACCESS pattern
 * 3. Generated code uses bare signal references, ctx.root, etc.
 * 4. Inject __template and __bindings as properties on the setup function
 */
/** What a production build asks of the compiler; a development build passes nothing. */
export interface CompileOptions {
  /** Minify each compiled template and stylesheet where it is emitted */
  minify?: boolean | undefined;
  /** Selector renames planned for this build (see minification/selector-minifier.ts) */
  selectorMap?: SelectorMap | undefined;
}

export const transformDefineComponentSource = (
  source: string,
  filePath: string,
  childMounts?: ChildMountInfo[],
  options: CompileOptions = {},
): string | null => {
  const sourceFile = sourceCache.parse(filePath, source);

  // Find the defineComponent call
  let defineComponentCall: ts.CallExpression | null = null;
  let exportName: string | null = null;

  const findDefineComponent = (node: ts.Node) => {
    if (ts.isVariableStatement(node)) {
      const hasExport = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          ts.isCallExpression(decl.initializer) &&
          isDefineComponentCall(decl.initializer)
        ) {
          defineComponentCall = decl.initializer;
          exportName = hasExport ? decl.name.text : null;
        }
      }
    }
    if (!defineComponentCall) ts.forEachChild(node, findDefineComponent);
  };
  findDefineComponent(sourceFile);

  if (!defineComponentCall) return null;

  // Narrow for TypeScript — the null check above guarantees this
  const dcCall: ts.CallExpression = defineComponentCall;

  // Determine selector
  let selector: string | null = null;
  let hasExplicitSelector = false;
  const args = dcCall.arguments;

  if (args.length >= 2 && ts.isStringLiteral(args[0]!)) {
    selector = (args[0] as ts.StringLiteral).text;
    hasExplicitSelector = true;
  } else if (exportName) {
    selector = pascalToKebab(exportName);
  }

  if (!selector) return null;

  // The name the selector is emitted under: its own, or the short name planned for this build.
  const emittedSelector = options.selectorMap?.get(selector) ?? selector;

  const signalInitializers = findSignalInitializers(sourceFile);

  // Find html templates directly — no normalization needed.
  // The regex pipeline natively matches bare signal() calls.
  const servicesImport = findServicesImport(sourceFile);
  const setupArg = getSetupFunction(dcCall);
  const htmlTemplates = setupArg ? findHtmlTemplates(sourceFile, setupArg) : [];

  const edits: Array<{ start: number; end: number; replacement: string }> = [];
  let allBindings: BindingInfo[] = [];
  let allConditionals: ConditionalBlock[] = [];
  let allWhenElseBlocks: WhenElseBlock[] = [];
  let allRepeatBlocks: RepeatBlock[] = [];
  let allEventBindings: EventBinding[] = [];
  let idCounter = computeInitialIdSeed(filePath, source);
  let lastProcessedTemplateContent = '';

  for (const templateInfo of htmlTemplates) {
    // htmlTemplates is empty without a setup function
    let templateContent = extractAndInlineFragment(templateInfo.node, sourceFile, setupArg!, new Set());

    const result = processHtmlTemplateWithConditionals(templateContent, signalInitializers, idCounter);
    templateContent = result.processedContent;
    allBindings = [...allBindings, ...result.bindings];
    allConditionals = [...allConditionals, ...result.conditionals];
    allWhenElseBlocks = [...allWhenElseBlocks, ...result.whenElseBlocks];
    allRepeatBlocks = [...allRepeatBlocks, ...result.repeatBlocks];
    allEventBindings = [...allEventBindings, ...result.eventBindings];
    idCounter = result.nextId;

    lastProcessedTemplateContent = templateContent;

    edits.push({
      start: templateInfo.templateStart,
      end: templateInfo.templateEnd,
      replacement: '``',
    });
  }

  // An explicit selector is a string literal in the source: write the emitted name over it
  if (hasExplicitSelector && emittedSelector !== selector) {
    const selectorArg = args[0]!;
    edits.push({
      start: selectorArg.getStart(sourceFile),
      end: selectorArg.getEnd(),
      replacement: `'${emittedSelector}'`,
    });
  }

  // Strip css tags. The text is known to be a stylesheet here, so this is where it is
  // minified and where class selectors that address a renamed component host are renamed.
  const ownCssTag = declaresOwnCssTag(sourceFile);
  const visitCss = (node: ts.Node) => {
    if (!ownCssTag && isCssTaggedTemplate(node)) {
      edits.push({
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        replacement: compileCssTemplate(node, sourceFile, options),
      });
      return; // a css template nested in a substitution is compiled along with this one
    }
    ts.forEachChild(node, visitCss);
  };
  visitCss(sourceFile);

  // Styles and non-empty lifecycle hooks, read once from the return object the strip pass edits.
  // They decide the styles import and call, and the registration function: the lean variant when
  // the component has no styles and no lifecycle hooks, so esbuild can tree-shake the styles
  // subsystem entirely for style-free apps.
  const { hasStyles, hasLifecycle } = detectFeatures(findReturnObject(sourceFile));
  const registerFnName = hasStyles || hasLifecycle ? BIND_FN.REGISTER_COMPONENT : BIND_FN.REGISTER_COMPONENT_LEAN;

  // ── Partition child mounts by directive containment ──
  const directiveChildMounts = new Map<string, { cm: ChildMountInfo; globalIndex: number }[]>();
  const topLevelChildMounts: { cm: ChildMountInfo; globalIndex: number }[] = [];

  if (childMounts && childMounts.length > 0) {
    const addToDirective = (key: string, cm: ChildMountInfo, idx: number) => {
      if (!directiveChildMounts.has(key)) directiveChildMounts.set(key, []);
      directiveChildMounts.get(key)!.push({ cm, globalIndex: idx });
    };

    // Recursive helpers: search nested directives first so the innermost match wins.
    // A child mount inside a directive branch must be set up by that branch's initializer.
    const findInConditionals = (marker: string, conds: ConditionalBlock[]): string | null => {
      for (const c of conds) {
        const inner = findInConditionals(marker, c.nestedConditionals) ?? findInWhenElse(marker, c.nestedWhenElse);
        if (inner) return inner;
        if (c.templateContent.includes(marker)) return c.id;
      }
      return null;
    };

    const findInWhenElse = (marker: string, wes: WhenElseBlock[]): string | null => {
      for (const we of wes) {
        const inner =
          findInConditionals(marker, we.thenConditionals) ??
          findInWhenElse(marker, we.thenWhenElse) ??
          findInConditionals(marker, we.elseConditionals) ??
          findInWhenElse(marker, we.elseWhenElse);
        if (inner) return inner;
        if (we.thenTemplate.includes(marker)) return we.thenId;
        if (we.elseTemplate.includes(marker)) return we.elseId;
      }
      return null;
    };

    for (let i = 0; i < childMounts.length; i++) {
      const cm = childMounts[i]!;
      const marker = `id="${cm.anchorId}"`;
      let placed = false;

      // Check repeat blocks (and their nested directives)
      for (const rep of allRepeatBlocks) {
        if (!rep.itemTemplate.includes(marker)) continue;
        const innerCond = findInConditionals(marker, rep.nestedConditionals);
        if (innerCond) {
          addToDirective(innerCond, cm, i);
          placed = true;
          break;
        }
        const innerWE = findInWhenElse(marker, rep.nestedWhenElse);
        if (innerWE) {
          addToDirective(innerWE, cm, i);
          placed = true;
          break;
        }
        addToDirective(rep.id, cm, i);
        placed = true;
        break;
      }
      if (placed) continue;

      // Check top-level conditionals
      const condId = findInConditionals(marker, allConditionals);
      if (condId) {
        addToDirective(condId, cm, i);
        continue;
      }

      // Check whenElse blocks
      const weId = findInWhenElse(marker, allWhenElseBlocks);
      if (weId) {
        addToDirective(weId, cm, i);
        continue;
      }

      // Top-level mount
      topLevelChildMounts.push({ cm, globalIndex: i });
    }
  }

  // Generate bindings code with CLOSURE_ACCESS — natively emits bare signal refs,
  // ctx.root, and closure-compatible code. No post-hoc stripping needed.
  const ap: AccessPattern = {
    ...CLOSURE_ACCESS,
    html: options.minify ? minifyHTML : CLOSURE_ACCESS.html,
    selector: (name) => options.selectorMap?.get(name) ?? name,
  };
  const { code: initBindingsFunction, staticTemplates: repeatStaticTemplates = [] } = generateInitBindingsFunction(
    allBindings,
    allConditionals,
    allWhenElseBlocks,
    allRepeatBlocks,
    allEventBindings,
    filePath,
    ap,
    directiveChildMounts.size > 0 ? directiveChildMounts : undefined,
  );

  let staticTemplateCode = '';
  if (lastProcessedTemplateContent) {
    staticTemplateCode = generateStaticTemplate(lastProcessedTemplateContent, ap);
  }

  if (repeatStaticTemplates.length > 0) {
    staticTemplateCode += '\n' + repeatStaticTemplates.join('\n');
  }

  // Update imports: always replace defineComponent → __registerComponent,
  // and add binding / styles imports as needed.
  const hasAnyBindings =
    allBindings.length > 0 ||
    allConditionals.length > 0 ||
    allWhenElseBlocks.length > 0 ||
    allRepeatBlocks.length > 0 ||
    allEventBindings.length > 0 ||
    (childMounts != null && childMounts.length > 0);

  if (servicesImport) {
    // Filter out defineComponent (replaced by __registerComponent in compiled output)
    const filteredImport: typeof servicesImport = {
      ...servicesImport,
      namedImports: servicesImport.namedImports.filter((n) => n !== 'defineComponent'),
    };
    const requiredFunctions: string[] = [registerFnName];

    // ── Binding function imports ──
    if (hasAnyBindings) {
      // Directives nest arbitrarily (when → whenElse → repeat → when …); walk every level so a
      // helper that is only used deep inside a branch is still imported.
      const everyConditional: ConditionalBlock[] = [];
      const everyWhenElse: WhenElseBlock[] = [];
      const everyRepeat: RepeatBlock[] = [];
      walkDirectives(
        { conditionals: allConditionals, whenElse: allWhenElseBlocks, repeats: allRepeatBlocks },
        {
          cond: (c) => void everyConditional.push(c),
          whenElse: (we) => void everyWhenElse.push(we),
          repeat: (rep) => void everyRepeat.push(rep),
        },
      );

      const isSimpleConditional = (c: ConditionalBlock): boolean =>
        c.signalNames.length === 1 && c.jsExpression === `${c.signalName}()`;
      if (everyConditional.some(isSimpleConditional)) requiredFunctions.push(BIND_FN.IF);
      if (everyConditional.some((c) => !isSimpleConditional(c)) || everyWhenElse.length > 0) {
        requiredFunctions.push(BIND_FN.IF_EXPR);
      }
      if (everyRepeat.length > 0) requiredFunctions.push(BIND_FN.KEYED_RECONCILER);
      if (everyRepeat.some((r) => (r.rowSignalVars?.length ?? 0) > 0)) requiredFunctions.push(BIND_FN.SIGNAL);
      // Events now use direct addEventListener — no runtime import needed
    }

    // ── Styles enablement import ──
    if (hasStyles) {
      requiredFunctions.push(BIND_FN.ENABLE_STYLES);
    }

    // ── Child destroy helper — needed for child mounts and direct repeat components ──
    const hasDirectRepeatComponent = allRepeatBlocks.some((rep) =>
      /^\s*[A-Za-z_$][\w$]*\(/.test(rep.itemTemplate.trim()),
    );
    if ((childMounts && childMounts.length > 0) || hasDirectRepeatComponent) {
      requiredFunctions.push(BIND_FN.DESTROY_CHILD);
    }

    const newImport = generateUpdatedImport(filteredImport, requiredFunctions);
    edits.push({
      start: servicesImport.start,
      end: servicesImport.end,
      replacement: newImport,
    });
  }

  // Apply all edits to the source (no normalization pass — edits are against the original)
  let result = applyEdits(source, edits);

  // Injection strategy: static templates go BEFORE the export (no closure deps),
  // __b binding function goes INSIDE the return object (needs closure access),
  // and __tpl is passed as an extra arg to defineComponent().

  // Extract initializeBindings body for use as __b arrow function.
  let processedBindings = initBindingsFunction
    .replace(/\s*initializeBindings = \(\) => \{\s*/, '')
    .replace(/\};\s*$/, '');

  // ── Child component mount code ──
  // Top-level mounts are appended here; directive-nested mounts are handled by codegen.
  if (topLevelChildMounts.length > 0) {
    const mountLines: string[] = [];
    for (const { cm, globalIndex } of topLevelChildMounts) {
      const varName = `_cm${globalIndex}`;
      mountLines.push(`const ${varName} = document.createElement('${ap.selector(cm.selector)}');`);
      mountLines.push(`_gid('${cm.anchorId}').replaceWith(${varName});`);
      mountLines.push(
        `_subs.push(${BIND_FN.DESTROY_CHILD}(${cm.componentName}.__f(${varName}, ${cm.propsExpression})));`,
      );
    }
    const mountCode = '\n    ' + mountLines.join('\n    ');
    // Insert BEFORE the return statement so code is reachable
    const returnIdx = processedBindings.lastIndexOf('return () =>');
    if (returnIdx !== -1) {
      processedBindings =
        processedBindings.substring(0, returnIdx) +
        mountCode.trimStart() +
        '\n    ' +
        processedBindings.substring(returnIdx);
    } else {
      processedBindings += mountCode;
    }
  }

  // Inject selector if auto-derived (before the setup function argument)
  if (!hasExplicitSelector && selector) {
    result = result.replace(/defineComponent\s*((?:<[^(]*>)?)\s*\(/, `defineComponent$1('${emittedSelector}', `);
  }

  // ── AST-based injection: re-parse the transformed source for reliable positions ──
  const injectionSf = ts.createSourceFile('__injection.ts', result, ts.ScriptTarget.Latest, true);

  // Find the export declaration and defineComponent call via AST
  let exportStart: number | null = null;
  let dcCallNode: ts.CallExpression | null = null;
  let dcCallCloseParen: number | null = null;
  let returnObjectBracePos: number | null = null;

  const findInjectionPoints = (node: ts.Node) => {
    // Find: [export] const X = defineComponent(...)
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer && ts.isCallExpression(decl.initializer) && isDefineComponentCall(decl.initializer)) {
          exportStart = node.getStart(injectionSf);
          dcCallNode = decl.initializer;
          // The closing paren is at the end of the CallExpression minus 1
          dcCallCloseParen = dcCallNode.getEnd() - 1;
        }
      }
    }
    ts.forEachChild(node, findInjectionPoints);
  };
  findInjectionPoints(injectionSf);

  // Find the return statement inside the setup function
  if (dcCallNode) {
    const setupArg = getSetupFunction(dcCallNode as ts.CallExpression);
    if (setupArg) {
      // Handle concise arrow: () => ({...}) — no ReturnStatement in AST
      if (ts.isArrowFunction(setupArg) && !ts.isBlock(setupArg.body)) {
        const bodyExpr = unwrapParens(setupArg.body);
        if (ts.isObjectLiteralExpression(bodyExpr)) {
          returnObjectBracePos = bodyExpr.getStart(injectionSf) + 1; // after {
        }
      } else {
        // Block body: () => { return {...}; }
        const findReturn = (node: ts.Node) => {
          // Only look at direct returns in this function, not nested functions
          if (ts.isArrowFunction(node) && node !== setupArg) return;
          if (ts.isFunctionExpression(node) && node !== setupArg) return;
          if (ts.isFunctionDeclaration(node)) return;
          if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
            returnObjectBracePos = node.expression.getStart(injectionSf) + 1; // after {
          }
          ts.forEachChild(node, findReturn);
        };
        findReturn(setupArg);
      }
    }
  }

  if (exportStart !== null) {
    // ── Insert static template declarations before the export ──
    let declarations = '';
    if (staticTemplateCode.trim()) {
      declarations += staticTemplateCode.trim() + '\n';
    }

    if (declarations) {
      result = result.substring(0, exportStart) + declarations + '\n' + result.substring(exportStart);
      // Adjust downstream positions for the inserted text
      const offset = declarations.length + 1; // +1 for newline
      if (returnObjectBracePos !== null) returnObjectBracePos = returnObjectBracePos + offset;
      if (dcCallCloseParen !== null) dcCallCloseParen = dcCallCloseParen + offset;
    }

    // ── Inject __bindings into the return object ──
    if (hasAnyBindings && processedBindings.trim() && returnObjectBracePos !== null) {
      const bindingsFnBody = `\n  __b: (ctx) => {\n  ${processedBindings.trim()}\n  },`;
      result = result.substring(0, returnObjectBracePos) + bindingsFnBody + result.substring(returnObjectBracePos);
      // Adjust closing paren position
      if (dcCallCloseParen !== null) dcCallCloseParen = dcCallCloseParen + bindingsFnBody.length;
    }

    // Strip dead properties, then pass __tpl as an extra arg to defineComponent()
    if (dcCallCloseParen !== null) {
      // Strip dead properties before inserting extra args (positions would shift)
      const hasCompiledTemplate = !!lastProcessedTemplateContent;
      const stripped = stripDeadProperties(result, hasCompiledTemplate);

      // Adjust dcCallCloseParen for any characters removed by stripping
      const charDelta = stripped.length - result.length;
      result = stripped;
      dcCallCloseParen = dcCallCloseParen + charDelta;

      if (lastProcessedTemplateContent) {
        result = result.substring(0, dcCallCloseParen) + ', __tpl' + result.substring(dcCallCloseParen);
      }

      if (hasStyles) {
        result += '\n__enableComponentStyles();\n';
      }
    }
  }

  // Rename defineComponent → __registerComponent or __registerComponentLean
  result = result.replace(/\bdefineComponent\s*(?:<[^(]*>)?\s*\(/, `${registerFnName}(`);

  return result;
};

// ============================================================================
// esbuild Plugin
// ============================================================================

/**
 * `getOptions` is read per file, after the build's onStart callbacks have run, so a production
 * build's selector plan is in place by the time anything is compiled.
 */
export const createReactiveBindingPlugin = (getOptions: () => CompileOptions = () => ({})): Plugin => ({
  name: NAME,
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, async (args) => {
      if (args.path.includes('scripts') || args.path.includes('node_modules')) {
        return undefined;
      }

      const source = await fs.promises.readFile(args.path, 'utf8');

      if (!extendsComponentQuick(source) || !hasHtmlTemplates(source)) {
        return undefined;
      }

      try {
        const transformed = transformDefineComponentSource(source, args.path, undefined, getOptions());

        if (transformed === null) {
          return undefined;
        }

        return createLoaderResult(transformed);
      } catch (error) {
        const diagnostic = createError(
          `Error processing ${args.path}: ${error instanceof Error ? error.message : error}`,
          { file: args.path, line: 0, column: 0 },
          ErrorCode.PLUGIN_ERROR,
        );
        logger.diagnostic(diagnostic);
        // A component the compiler cannot process must fail the build rather than ship uncompiled
        return { errors: [{ text: diagnostic.message, location: { file: args.path } }] };
      }
    });
  },
});

export const ReactiveBindingPlugin: Plugin = createReactiveBindingPlugin();
