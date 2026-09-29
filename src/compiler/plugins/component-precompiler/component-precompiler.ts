import fs from 'node:fs';
import type { Plugin } from 'esbuild';
import ts from 'typescript';
import type { ComponentDefinition, BuildContext } from '../../types.js';
import {
  sourceCache,
  logger,
  PLUGIN_NAME,
  FN,
  createLoaderResult,
  extendsComponentQuick,
  createBuildContext,
  refreshBuildContext,
  applyEdits,
} from '../../utils/index.js';
import { createComponentResolver, type ComponentResolver } from '../../utils/component-resolver.js';
import { transformDefineComponentSource } from '../reactive-binding-compiler/index.js';
import { anchorMark } from '../reactive-binding-compiler/template-utils.js';
import type { CompileOptions } from '../reactive-binding-compiler/index.js';
import {
  compileCssTemplate,
  declaresOwnCssTag,
  isCssTaggedTemplate,
  KEYFRAME_SCOPING,
} from '../minification/css-transform.js';
import { ErrorCode, createError } from '../../errors.js';
import { INTERNAL_RUNTIME_SPECIFIER, RUNTIME_HELPER } from '../../../contracts/index.js';

const NAME = PLUGIN_NAME.COMPONENT;

/** Child component mount point data, passed from the precompiler to the binding compiler. */
export interface ChildMountInfo {
  /** Component class name, e.g. "MyElementComponent" */
  componentName: string;
  /** Kebab-case selector, e.g. "my-element-component" */
  selector: string;
  /** Raw source text of the props argument, e.g. "{ color: myColor }" */
  propsExpression: string;
  /** Pre-allocated id ("b0", "b1", …): the child's placeholder is `<!--b0.-->` */
  anchorId: string;
}

interface ComponentCallInfo {
  componentName: string;
  propsExpression: string;
  startIndex: number;
  endIndex: number;
}

const findComponentCalls = (
  source: string,
  sourceFile: ts.SourceFile,
  knownComponents: Map<string, ComponentDefinition>,
): ComponentCallInfo[] => {
  const calls: ComponentCallInfo[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag;
      if (ts.isIdentifier(tag) && tag.text === 'html') {
        const template = node.template;

        if (ts.isTemplateExpression(template)) {
          template.templateSpans.forEach((span) => {
            const expr = span.expression;

            if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
              const componentName = expr.expression.text;
              const componentDef = knownComponents.get(componentName);

              if (componentDef) {
                // Capture the raw props expression text (even for dynamic/signal props)
                let propsExpression = '{}';
                if (expr.arguments.length > 0 && expr.arguments[0]) {
                  propsExpression = expr.arguments[0].getText(sourceFile);
                }

                // Compute ${…} range in source file
                const spanIndex = template.templateSpans.indexOf(span);
                let dollarBraceStart: number;
                if (spanIndex === 0) {
                  dollarBraceStart = template.head.getEnd() - 2;
                } else {
                  const prevSpan = template.templateSpans[spanIndex - 1]!;
                  dollarBraceStart = prevSpan.literal.getEnd() - 2;
                }
                const closingBrace = span.literal.getStart(sourceFile) + 1;

                if (dollarBraceStart >= 0 && closingBrace <= source.length) {
                  calls.push({
                    componentName,
                    propsExpression,
                    startIndex: dollarBraceStart,
                    endIndex: closingBrace,
                  });
                }
              }
            }
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return calls;
};

export const ComponentPrecompilerPlugin = (ctx?: BuildContext): Plugin => ({
  name: NAME,
  setup(build) {
    // Which components each file can call; made anew for every build, so it sees the current sources
    let resolver: ComponentResolver | null = null;

    // Read per file: a production build plans its selector renames in onStart, before any load
    const compileOptions = (): CompileOptions => ({ minify: ctx?.minify, selectorMap: ctx?.selectorMap });
    let scanned = false;

    build.onStart(async () => {
      // A rebuild in watch mode scans again, so that a component file added meanwhile is found
      if (ctx && scanned) await refreshBuildContext(ctx);
      scanned = true;
      const buildContext = ctx ?? (await createBuildContext());
      resolver = createComponentResolver(buildContext.projectRoot, buildContext.components);
      if (buildContext.components.length > 0) {
        logger.info(NAME, `Found ${buildContext.components.length} component(s)`);
      }
    });

    // ── Mount-call optimiser (Mode A → mountComponent) ────────────────
    // Rewrites `import { mount } from 'thane'` + `mount({ component: X, target?: T, props?: P })`
    // into `import { mountComponent } from 'thane/runtime'` + `mountComponent(X, T, P)` when there is no
    // `router` key, so the generic mount() wrapper, _routerMount hook, and __setRouterMount
    // are all tree-shaken away for non-router apps.
    const rewriteMountToMountComponent = (source: string): string | null => {
      const sf = ts.createSourceFile('__mount.ts', source, ts.ScriptTarget.Latest, true);

      // 1. Only thane's `mount`, imported under its own name, and only when it is called once: the
      //    rewrite takes `mount` out of the import, so a second call, or a local function of that
      //    name, would be left without a definition
      const mountImport = sf.statements.find(
        (s): s is ts.ImportDeclaration =>
          ts.isImportDeclaration(s) &&
          ts.isStringLiteral(s.moduleSpecifier) &&
          s.moduleSpecifier.text === 'thane' &&
          !s.importClause?.phaseModifier &&
          !s.importClause?.name &&
          !!s.importClause?.namedBindings &&
          ts.isNamedImports(s.importClause.namedBindings) &&
          s.importClause.namedBindings.elements.some(
            (e) => !e.isTypeOnly && !e.propertyName && e.name.text === 'mount',
          ),
      );
      const mountCalls: ts.CallExpression[] = [];
      // Any other reference (`const m = mount`, `export { mount }`) still needs the import
      let otherReferences = 0;
      const findMount = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'mount') {
          mountCalls.push(node);
          node.arguments.forEach(findMount);
          return;
        }
        if (ts.isIdentifier(node) && node.text === 'mount' && !ts.isImportSpecifier(node.parent)) {
          const parent = node.parent;
          const isPropertyName =
            (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
            (ts.isPropertyAssignment(parent) && parent.name === node);
          if (!isPropertyName) otherReferences++;
        }
        ts.forEachChild(node, findMount);
      };
      findMount(sf);

      const mc = mountCalls[0];
      const objArg = mc?.arguments[0];
      if (
        !mountImport ||
        mountCalls.length !== 1 ||
        otherReferences > 0 ||
        !mc ||
        !objArg ||
        !ts.isObjectLiteralExpression(objArg)
      ) {
        return null;
      }

      // 2. Extract component, target, and props values from the object literal (no `router` key)
      let componentText: string | null = null;
      let targetText: string | null = null;
      let propsText: string | null = null;

      for (const prop of objArg.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
          const valueText = prop.initializer.getText(sf);
          if (prop.name.text === 'component') componentText = valueText;
          else if (prop.name.text === 'target') targetText = valueText;
          else if (prop.name.text === 'props') propsText = valueText;
          else if (prop.name.text === 'router') return null;
        }
      }

      if (!componentText) return null;

      // 3. Build the mountComponent(...) call arguments
      const args: string[] = [componentText];
      if (targetText || propsText) {
        args.push(targetText ?? 'document.body');
      }
      if (propsText) {
        args.push(propsText);
      }

      // 4. Replace the mount call, and fix the import: `mount` leaves it, and mountComponent comes
      //    from the compiler's entry, with the other helpers compiled code calls
      const rest = (mountImport.importClause!.namedBindings as ts.NamedImports).elements
        .map((e) => e.getText(sf))
        .filter((s) => s !== 'mount');
      const runtimeImport = `import { ${RUNTIME_HELPER.MOUNT_COMPONENT} } from '${INTERNAL_RUNTIME_SPECIFIER}'`;
      return applyEdits(source, [
        {
          start: mountImport.getStart(sf),
          end: mountImport.moduleSpecifier.getEnd(),
          replacement:
            rest.length > 0 ? `import { ${rest.join(', ')} } from 'thane';\n${runtimeImport}` : runtimeImport,
        },
        {
          start: mc.getStart(sf),
          end: mc.getEnd(),
          replacement: `${RUNTIME_HELPER.MOUNT_COMPONENT}(${args.join(', ')})`,
        },
      ]);
    };

    /**
     * Replace tagged templates with plain ones using the AST: html`...` loses its tag, and
     * css`...` is compiled (its tag goes, and a production build minifies the stylesheet).
     */
    const stripTemplateTags = (code: string, filePath: string, options: CompileOptions = compileOptions()): string => {
      const sf = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true);
      // Collect positions to strip in reverse order (end → start)
      const edits: { start: number; end: number; replacement: string }[] = [];
      const ownCssTag = declaresOwnCssTag(sf);
      const walk = (node: ts.Node) => {
        if (!ownCssTag && isCssTaggedTemplate(node)) {
          edits.push({
            start: node.getStart(sf),
            end: node.getEnd(),
            replacement: compileCssTemplate(node, sf, options),
          });
          return; // nested css templates are compiled along with this one
        }
        if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === 'html') {
          // Remove the tag identifier — keep only the template literal
          edits.push({ start: node.tag.getStart(sf), end: node.template.getStart(sf), replacement: '' });
        }
        ts.forEachChild(node, walk);
      };
      walk(sf);
      // Apply in reverse to preserve positions
      let result = code;
      for (let i = edits.length - 1; i >= 0; i--) {
        const edit = edits[i]!;
        result = result.substring(0, edit.start) + edit.replacement + result.substring(edit.end);
      }
      return result;
    };

    /**
     * Apply reactive binding transformation, strip template tags, and produce loader result.
     * When childMounts are present, passes them to the binding compiler so it can
     * emit mount calls in __b and start its idCounter at the correct offset.
     */
    const buildTransformedResult = (
      source: string,
      modifiedSource: string,
      filePath: string,
      childMounts?: ChildMountInfo[],
    ): { contents: string; loader: 'ts' } => {
      let result = modifiedSource;
      let keyframes = false;
      const options = { ...compileOptions(), onKeyframes: () => (keyframes = true) };
      if (extendsComponentQuick(source)) {
        const transformed = transformDefineComponentSource(result, filePath, childMounts, options);
        if (transformed) {
          result = transformed;
        }
      }
      result = stripTemplateTags(result, filePath, options);
      return createLoaderResult(keyframes ? result + '\n' + KEYFRAME_SCOPING : result);
    };

    /** css`` templates compiled, and keyframe scoping added when one of them defines keyframes */
    const compileCssOnly = (code: string, filePath: string): string => {
      let keyframes = false;
      const result = stripTemplateTags(code, filePath, { ...compileOptions(), onKeyframes: () => (keyframes = true) });
      return keyframes ? result + '\n' + KEYFRAME_SCOPING : result;
    };

    build.onLoad({ filter: /\.ts$/ }, async (args) => {
      try {
        if (args.path.includes('node_modules')) {
          return undefined;
        }

        const source = await fs.promises.readFile(args.path, 'utf8');

        // ── Mount-call optimiser ──
        // For Mode A (component-only), rewrite mount({component: X}) → mountComponent(X)
        // so the generic mount() wrapper + router hook are tree-shaken away entirely.
        if (source.includes('mount(') && !source.includes('router') && !source.includes(FN.HTML + '`')) {
          const rewritten = rewriteMountToMountComponent(source);
          if (rewritten) {
            logger.info(NAME, `Optimised mount() → mountComponent() in ${args.path}`);
            return createLoaderResult(source.includes(FN.CSS + '`') ? compileCssOnly(rewritten, args.path) : rewritten);
          }
        }

        if (!source.includes(FN.HTML + '`')) {
          // A module with only css`` templates (shared styles) still needs them compiled:
          // the tag is a compile-time marker and does not exist at runtime.
          if (source.includes(FN.CSS + '`')) {
            return createLoaderResult(compileCssOnly(source, args.path));
          }
          return undefined;
        }

        // ── Child component calls: the components this file declares or imports ──
        let modifiedSource = source;

        // Child mount data to pass to the binding compiler
        let childMounts: ChildMountInfo[] | undefined;

        const sourceFile = sourceCache.parse(args.path, source);
        const componentsInScope = resolver ? await resolver.componentsInScope(sourceFile) : new Map();
        if (componentsInScope.size > 0) {
          const componentCalls = findComponentCalls(source, sourceFile, componentsInScope);

          if (componentCalls.length > 0) {
            // Allocates b0, b1, … for child component placeholders, comments the
            // binding compiler turns into the child's host element or anchor. It starts its
            // own ids after these.
            let childIdCounter = 0;
            const mounts: ChildMountInfo[] = [];

            const sortedCalls = [...componentCalls].sort((a, b) => b.startIndex - a.startIndex);

            for (const call of sortedCalls) {
              const componentDef = componentsInScope.get(call.componentName);
              if (componentDef) {
                const anchorId = `b${childIdCounter++}`;
                const compiledHTML = anchorMark(anchorId, '.');

                modifiedSource =
                  modifiedSource.substring(0, call.startIndex) + compiledHTML + modifiedSource.substring(call.endIndex);

                mounts.push({
                  componentName: call.componentName,
                  selector: componentDef.selector,
                  propsExpression: call.propsExpression,
                  anchorId,
                });
              }
            }

            childMounts = mounts;
          }
        }

        return buildTransformedResult(source, modifiedSource, args.path, childMounts);
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
