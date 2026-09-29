/** Reactive binding compiler — source transformation and template processing. */

import ts from 'typescript';
import type { ImportInfo, TemplateInfo } from '../../types.js';
import {
  findSignalInitializers,
  isHtmlTemplate,
  isDefineComponentCall,
  pascalToKebab,
  applyEdits,
  type SourceEdit,
  sourceCache,
  BIND_FN,
} from '../../utils/index.js';
import { getSetupFunction, unwrapParens } from '../../utils/component-ast.js';
import { checkBindingNames } from './binding-names.js';
import type { BindingInfo, ConditionalBlock, WhenElseBlock, RepeatBlock, EventBinding, EmitOptions } from './types.js';
import { minifyHTML } from '../minification/template-minifier.js';
import { compileCssTemplate, declaresOwnCssTag, isCssTaggedTemplate } from '../minification/css-transform.js';
import type { SelectorMap } from '../minification/selector-minifier.js';
import { processHtmlTemplateWithConditionals } from './template-processing.js';
import { anchorMark } from './template-utils.js';
import { placeChildHosts } from './child-hosts.js';
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

/**
 * The setup function's return objects, in source order: every `return {…}` in its body,
 * at any depth, but not inside a nested function-like (arrow, function expression or
 * declaration, method, accessor, constructor). A concise body's object literal is its single
 * return. With several, the last one is the component's (THANE412 reports the others).
 */
export const findReturnObjects = (setup: ts.ArrowFunction | ts.FunctionExpression): ts.ObjectLiteralExpression[] => {
  if (!ts.isBlock(setup.body)) {
    const body = unwrapParens(setup.body);
    return ts.isObjectLiteralExpression(body) ? [body] : [];
  }
  const objects: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      objects.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(setup.body, visit);
  return objects;
};

/** Detect the styles/lifecycle feature flags of the defineComponent return object. */
const detectFeatures = (
  returnObj: ts.ObjectLiteralExpression | undefined,
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
 * The removals that strip empty lifecycle hooks, and the `template` property once the template
 * is compiled, from the component's return object. Styles and non-empty hooks are kept: the
 * runtime needs them.
 */
const deadPropertyRemovals = (
  source: string,
  sf: ts.SourceFile,
  returnObj: ts.ObjectLiteralExpression,
  hasCompiledTemplate: boolean,
): SourceEdit[] => {
  const removals: SourceEdit[] = [];

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

    removals.push({ start, end, replacement: '' });
  }

  return removals;
};
import { generateInitBindingsFunction, generateStaticTemplate, generateUpdatedImport } from './codegen.js';

/** The order a compiled component imports runtime helpers in; a helper not listed here goes last. */
const HELPER_IMPORT_ORDER: readonly string[] = [
  BIND_FN.REGISTER_COMPONENT,
  BIND_FN.REGISTER_COMPONENT_LEAN,
  BIND_FN.IF,
  BIND_FN.IF_EXPR,
  BIND_FN.KEYED_RECONCILER,
  BIND_FN.SIGNAL,
  BIND_FN.ENABLE_STYLES,
  BIND_FN.DESTROY_CHILD,
];
const importRank = (helper: string): number => {
  const rank = HELPER_IMPORT_ORDER.indexOf(helper);
  return rank === -1 ? HELPER_IMPORT_ORDER.length : rank;
};

/** The import declaration that imports `defineComponent`: the compiler's helpers are imported next to it. */
export const findServicesImport = (sourceFile: ts.SourceFile): ImportInfo | null => {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    const namedImports = namedBindings.elements.map((element) => element.name.text);
    if (!namedImports.includes('defineComponent')) continue;

    const fullText = statement.moduleSpecifier.getFullText(sourceFile);
    return {
      namedImports,
      moduleSpecifier: statement.moduleSpecifier.text,
      start: statement.getStart(sourceFile),
      end: statement.getEnd(),
      quoteChar: fullText.includes("'") ? "'" : '"',
    };
  }
  return null;
};

// ============================================================================
// defineComponent Support
// ============================================================================

/**
 * Recursively extract template content from an html tagged template,
 * inlining any ${identifier} references that resolve to other html`` fragment variables.
 * The text is taken as written (raw), like every directive template the parser cuts from it:
 * the escape sequences stay in place until the template is emitted.
 */
const extractAndInlineFragment = (
  tplNode: ts.TaggedTemplateExpression,
  sourceFile: ts.SourceFile,
  scopeRoot: ts.Node,
  visited: Set<string>,
): string => {
  const templateLiteral = tplNode.template;

  if (ts.isNoSubstitutionTemplateLiteral(templateLiteral)) {
    return templateLiteral.rawText!;
  }

  if (!ts.isTemplateExpression(templateLiteral)) return '';

  let content = templateLiteral.head.rawText!;
  for (const span of templateLiteral.templateSpans) {
    const expr = span.expression;
    if (ts.isIdentifier(expr) && !visited.has(expr.text)) {
      const resolved = resolveTemplateIdentifier(sourceFile, scopeRoot, expr);
      if (resolved) {
        visited.add(expr.text);
        content += extractAndInlineFragment(resolved, sourceFile, scopeRoot, visited);
        content += span.literal.rawText!;
        continue;
      }
    }
    const exprText = span.expression.getText(sourceFile);
    content += '${' + exprText + '}';
    content += span.literal.rawText!;
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
 * Find html`` templates in the setup's return objects only.
 * Fragment templates (const piece = html`...`) are intentionally skipped.
 */
const findHtmlTemplates = (
  sourceFile: ts.SourceFile,
  setupArg: ts.ArrowFunction | ts.FunctionExpression,
  returnObjects: ts.ObjectLiteralExpression[],
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
        templateStart: start,
        templateEnd: tplNode.getEnd(),
      });
    }
  };

  returnObjects.forEach(collectFromReturnObject);
  return templates;
};

/** What a production build asks of the compiler; a development build passes nothing. */
export interface CompileOptions {
  /** Minify each compiled template and stylesheet where it is emitted */
  minify?: boolean | undefined;
  /** Selector renames planned for this build (see minification/selector-minifier.ts) */
  selectorMap?: SelectorMap | undefined;
  /** Called when a compiled stylesheet defines `@keyframes` */
  onKeyframes?: (() => void) | undefined;
}

/**
 * Transform a defineComponent source file: compile its templates and stylesheets, generate the
 * binding code, and turn the call into the registration call. The file is parsed once, and
 * every change is an edit positioned on that parse, applied in one pass: static templates
 * before the component's statement, `__b` into its return object, the registration name (and
 * a derived selector) at the call, `__tpl` as the call's last argument.
 */
export const transformDefineComponentSource = (
  source: string,
  filePath: string,
  childMounts?: ChildMountInfo[],
  options: CompileOptions = {},
): string | null => {
  const sourceFile = sourceCache.parse(filePath, source);

  // Find the defineComponent call and the statement that declares it
  let defineComponentCall: ts.CallExpression | null = null;
  let componentStatement: ts.VariableStatement | null = null;
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
          componentStatement = node;
          exportName = hasExport ? decl.name.text : null;
        }
      }
    }
    if (!defineComponentCall) ts.forEachChild(node, findDefineComponent);
  };
  findDefineComponent(sourceFile);

  if (!defineComponentCall || !componentStatement) return null;

  // Narrow for TypeScript — the null check above guarantees this
  const dcCall: ts.CallExpression = defineComponentCall;
  const statement: ts.VariableStatement = componentStatement;

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
  // Every return object's template is compiled; the last object is the component's: it
  // decides the features, loses its dead properties and receives the binding function.
  const returnObjects = setupArg ? findReturnObjects(setupArg) : [];
  const returnObj = returnObjects[returnObjects.length - 1];
  const htmlTemplates = setupArg ? findHtmlTemplates(sourceFile, setupArg, returnObjects) : [];

  // Every change to the file, positioned on this one parse of it
  const edits: SourceEdit[] = [];
  let allBindings: BindingInfo[] = [];
  let allConditionals: ConditionalBlock[] = [];
  let allWhenElseBlocks: WhenElseBlock[] = [];
  let allRepeatBlocks: RepeatBlock[] = [];
  let allEventBindings: EventBinding[] = [];
  // Ids are names inside this file only: they count from 0, after the child placeholders'
  // (b0…, numbered by the precompiler), and no longer depend on where the file is
  let idCounter = childMounts?.length ?? 0;
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

  // Styles and non-empty lifecycle hooks, read once from the component's return object.
  // They decide the styles import and call, and the registration function: the lean variant when
  // the component has no styles and no lifecycle hooks, so esbuild can tree-shake the styles
  // subsystem entirely for style-free apps.
  const { hasStyles, hasLifecycle } = detectFeatures(returnObj);
  const registerFnName = hasStyles || hasLifecycle ? BIND_FN.REGISTER_COMPONENT : BIND_FN.REGISTER_COMPONENT_LEAN;

  // ── Partition child mounts by directive containment ──
  const directiveChildMounts = new Map<string, { cm: ChildMountInfo; globalIndex: number }[]>();
  const topLevelChildMounts: { cm: ChildMountInfo; globalIndex: number }[] = [];

  // A child is mounted by the innermost directive whose own template holds its placeholder: a
  // branch's initializer, or the row factory of a list, at any depth. The templates that
  // hold it are nested in one another (a pre-rendered branch is in its parent's too), and the walk
  // visits a block before the blocks inside it, so the last one found is the innermost. A child in
  // no directive is a top-level mount.
  (childMounts ?? []).forEach((cm, globalIndex) => {
    const marker = anchorMark(cm.anchorId, '.');
    let owner: string | undefined;
    walkDirectives(
      { conditionals: allConditionals, whenElse: allWhenElseBlocks, repeats: allRepeatBlocks },
      {
        cond: (c) => void (c.templateContent.includes(marker) && (owner = c.id)),
        whenElse: (we) =>
          void (we.thenTemplate.includes(marker)
            ? (owner = we.thenId)
            : we.elseTemplate.includes(marker) && (owner = we.elseId)),
        repeat: (rep) => void (rep.itemTemplate.includes(marker) && (owner = rep.id)),
      },
    );
    if (!owner) topLevelChildMounts.push({ cm, globalIndex });
    else if (directiveChildMounts.has(owner)) directiveChildMounts.get(owner)!.push({ cm, globalIndex });
    else directiveChildMounts.set(owner, [{ cm, globalIndex }]);
  });

  // Generate bindings code. A production build minifies templates and renames selectors.
  const emit: EmitOptions = {
    html: options.minify ? minifyHTML : (template) => template,
    selector: (name) => options.selectorMap?.get(name) ?? name,
  };
  // Each child's host goes into the template in place of its placeholder, where it fits
  const component = { template: lastProcessedTemplateContent };
  const childHosts = placeChildHosts(
    childMounts ?? [],
    component,
    { conditionals: allConditionals, whenElse: allWhenElseBlocks, repeats: allRepeatBlocks },
    emit,
  );
  lastProcessedTemplateContent = component.template;
  const {
    code: bindingsBody,
    staticTemplates: repeatStaticTemplates,
    helpers,
    elementList,
  } = generateInitBindingsFunction(
    allBindings,
    allConditionals,
    allWhenElseBlocks,
    allRepeatBlocks,
    allEventBindings,
    emit,
    directiveChildMounts.size > 0 ? directiveChildMounts : undefined,
    topLevelChildMounts,
    lastProcessedTemplateContent,
    childHosts,
  );

  // A template that reads one of the binding code's own names would read the compiler's value (THANE012)
  if (setupArg) checkBindingNames(setupArg, bindingsBody);

  let staticTemplateCode = '';
  if (lastProcessedTemplateContent) {
    staticTemplateCode = generateStaticTemplate(lastProcessedTemplateContent, emit);
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
  // The binding function goes into the component's return object
  const injectBindings = hasAnyBindings && returnObj !== undefined;

  if (servicesImport) {
    // Filter out defineComponent (replaced by __registerComponent in compiled output)
    const filteredImport: typeof servicesImport = {
      ...servicesImport,
      namedImports: servicesImport.namedImports.filter((n) => n !== 'defineComponent'),
    };
    // The registration function, the styles switch, and exactly the helpers the binding code
    // calls (when that code is emitted)
    const used = new Set<string>([registerFnName, ...(injectBindings ? helpers : [])]);
    if (hasStyles) used.add(BIND_FN.ENABLE_STYLES);
    // The component's and the lists' templates are built by the runtime's __T
    if (staticTemplateCode) used.add(BIND_FN.TEMPLATE);
    const requiredFunctions = [...used].sort((a, b) => importRank(a) - importRank(b));

    const newImport = generateUpdatedImport(filteredImport, requiredFunctions);
    edits.push({
      start: servicesImport.start,
      end: servicesImport.end,
      replacement: newImport,
    });
  }

  // Static templates go before the component's statement (they have no closure dependencies)
  const declarations = staticTemplateCode.trim();
  if (declarations) {
    const at = statement.getStart(sourceFile);
    edits.push({ start: at, end: at, replacement: declarations + '\n\n' });
  }

  // `defineComponent<…>(` becomes the registration call; a selector derived from the export
  // name goes in as its first argument
  edits.push({
    start: dcCall.expression.getStart(sourceFile),
    end: dcCall.arguments.pos,
    replacement: `${registerFnName}(` + (hasExplicitSelector ? '' : `'${emittedSelector}', `),
  });

  if (returnObj) {
    // Dead properties leave the return object. A removed `template: html\`…\`` takes the
    // template's own edit with it.
    for (const removal of deadPropertyRemovals(source, sourceFile, returnObj, !!lastProcessedTemplateContent)) {
      for (let i = edits.length - 1; i >= 0; i--) {
        if (edits[i]!.start >= removal.start && edits[i]!.end <= removal.end) edits.splice(i, 1);
      }
      edits.push(removal);
    }
    // The binding function becomes the object's first property. It is listed after the
    // removals: applyEdits applies edits that start at one position in list order, each in front
    // of the text already there, so it lands before a removal that starts at the same `{`.
    if (injectBindings) {
      const at = returnObj.getStart(sourceFile) + 1;
      // The registration factory passes the template's elements when the code reaches them by position
      const params = elementList ? '_ctx, _ns' : '_ctx';
      edits.push({ start: at, end: at, replacement: `\n  __b: (${params}) => {\n  ${bindingsBody.trim()}\n  },` });
    }
  }

  // The compiled template is the registration call's last argument
  if (lastProcessedTemplateContent) {
    const at = dcCall.getEnd() - 1;
    edits.push({ start: at, end: at, replacement: ', __tpl' });
  }

  if (hasStyles) {
    edits.push({ start: source.length, end: source.length, replacement: '\n__enableComponentStyles();\n' });
  }

  return applyEdits(source, edits);
};
