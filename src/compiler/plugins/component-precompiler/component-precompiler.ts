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
  generateComponentHTML,
  createBuildContext,
} from '../../utils/index.js';
import { transformDefineComponentSource } from '../reactive-binding-compiler/index.js';
import type { CompileOptions } from '../reactive-binding-compiler/index.js';
import { compileCssTemplate, declaresOwnCssTag, isCssTaggedTemplate } from '../minification/css-transform.js';
import { ErrorCode, createError } from '../../errors.js';
import { INTERNAL_RUNTIME_SPECIFIER, RUNTIME_HELPER } from '../../../contracts/index.js';

const NAME = PLUGIN_NAME.COMPONENT;

/** Child component mount point data, passed from CTFE to the binding compiler. */
export interface ChildMountInfo {
  /** Component class name, e.g. "MyElementComponent" */
  componentName: string;
  /** Kebab-case selector, e.g. "my-element-component" */
  selector: string;
  /** Raw source text of the props argument, e.g. "{ color: myColor }" */
  propsExpression: string;
  /** Pre-allocated anchor ID from the CTFE counter: "b0", "b1", … */
  anchorId: string;
}

interface CTFECallInfo {
  componentName: string;
  propsExpression: string;
  startIndex: number;
  endIndex: number;
}

const findComponentCallsCTFE = (
  source: string,
  sourceFile: ts.SourceFile,
  knownComponents: Map<string, ComponentDefinition>,
): CTFECallInfo[] => {
  const calls: CTFECallInfo[] = [];

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
    const componentDefinitions = new Map<string, ComponentDefinition>();

    // Read per file: a production build plans its selector renames in onStart, before any load
    const compileOptions = (): CompileOptions => ({ minify: ctx?.minify, selectorMap: ctx?.selectorMap });

    build.onStart(async () => {
      componentDefinitions.clear();

      if (ctx) {
        // Use shared context from BuildContext
        for (const [name, def] of ctx.componentsByName) {
          componentDefinitions.set(name, def);
        }
      } else {
        // Fallback: reuse createBuildContext to avoid duplicating the scan logic
        const fallbackCtx = await createBuildContext();
        for (const [name, def] of fallbackCtx.componentsByName) {
          componentDefinitions.set(name, def);
        }
      }

      if (componentDefinitions.size > 0) {
        logger.info(NAME, `Found ${componentDefinitions.size} component(s) for CTFE`);
      }
    });

    // ── Mount-call optimiser (Mode A → mountComponent) ────────────────
    // Rewrites `import { mount } from 'thane'` + `mount({ component: X, target?: T, props?: P })`
    // into `import { mountComponent } from 'thane/runtime'` + `mountComponent(X, T, P)` when there is no
    // `router` key, so the generic mount() wrapper, _routerMount hook, and __setRouterMount
    // are all tree-shaken away for non-router apps.
    const rewriteMountToMountComponent = (source: string): string | null => {
      const sf = ts.createSourceFile('__mount.ts', source, ts.ScriptTarget.Latest, true);

      // 1. Find the `mount(...)` call expression
      let mountCall: ts.CallExpression | null = null;
      const findMount = (node: ts.Node): void => {
        if (mountCall) return;
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'mount' &&
          node.arguments.length >= 1
        ) {
          const arg = node.arguments[0];
          if (arg && ts.isObjectLiteralExpression(arg)) {
            // Ensure it has 'component' and does NOT have 'router'
            let hasComponent = false;
            let hasRouter = false;
            for (const prop of arg.properties) {
              if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                if (prop.name.text === 'component') hasComponent = true;
                if (prop.name.text === 'router') hasRouter = true;
              }
            }
            if (hasComponent && !hasRouter) {
              mountCall = node;
            }
          }
        }
        ts.forEachChild(node, findMount);
      };
      findMount(sf);

      if (!mountCall) return null;
      const mc = mountCall as ts.CallExpression;

      // 2. Extract component, target, and props values from the object literal
      const objArg = mc.arguments[0] as ts.ObjectLiteralExpression;
      let componentText: string | null = null;
      let targetText: string | null = null;
      let propsText: string | null = null;

      for (const prop of objArg.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
          const valueText = prop.initializer.getText(sf);
          if (prop.name.text === 'component') componentText = valueText;
          else if (prop.name.text === 'target') targetText = valueText;
          else if (prop.name.text === 'props') propsText = valueText;
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

      // 4. Replace the mount call text
      const callStart = mc.getStart(sf);
      const callEnd = mc.getEnd();
      const call = `${RUNTIME_HELPER.MOUNT_COMPONENT}(${args.join(', ')})`;
      let result = source.substring(0, callStart) + call + source.substring(callEnd);

      // 5. Fix the imports: `mount` leaves the thane import, and mountComponent comes from the
      //    compiler's entry, with the other helpers compiled code calls
      result = result.replace(/import\s*\{([^}]*)\}\s*from\s*['"]thane['"]/, (_match, specifiers: string) => {
        const specs = specifiers
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean);
        if (!specs.includes('mount')) return `import { ${specs.join(', ')} } from 'thane'`;
        const rest = specs.filter((s: string) => s !== 'mount');
        const runtimeImport = `import { ${RUNTIME_HELPER.MOUNT_COMPONENT} } from '${INTERNAL_RUNTIME_SPECIFIER}'`;
        return rest.length > 0 ? `import { ${rest.join(', ')} } from 'thane';\n${runtimeImport}` : runtimeImport;
      });

      return result;
    };

    /**
     * Replace tagged templates with plain ones using the AST: html`...` loses its tag, and
     * css`...` is compiled (its tag goes, and a production build minifies the stylesheet).
     */
    const stripTemplateTags = (code: string): string => {
      const sf = ts.createSourceFile('__strip.ts', code, ts.ScriptTarget.Latest, true);
      // Collect positions to strip in reverse order (end → start)
      const edits: { start: number; end: number; replacement: string }[] = [];
      const ownCssTag = declaresOwnCssTag(sf);
      const walk = (node: ts.Node) => {
        if (!ownCssTag && isCssTaggedTemplate(node)) {
          edits.push({
            start: node.getStart(sf),
            end: node.getEnd(),
            replacement: compileCssTemplate(node, sf, compileOptions()),
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
      if (extendsComponentQuick(source)) {
        const transformed = transformDefineComponentSource(result, filePath, childMounts, compileOptions());
        if (transformed) {
          result = transformed;
        }
      }
      result = stripTemplateTags(result);
      return createLoaderResult(result);
    };

    build.onLoad({ filter: /\.ts$/ }, async (args) => {
      try {
        if (args.path.includes('scripts') || args.path.includes('node_modules')) {
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
            return createLoaderResult(source.includes(FN.CSS + '`') ? stripTemplateTags(rewritten) : rewritten);
          }
        }

        if (!source.includes(FN.HTML + '`')) {
          // A module with only css`` templates (shared styles) still needs them compiled:
          // the tag is a compile-time marker and does not exist at runtime.
          if (source.includes(FN.CSS + '`')) {
            return createLoaderResult(stripTemplateTags(source));
          }
          return undefined;
        }

        // ── CTFE: inline component calls if definitions are available ──
        let modifiedSource = source;
        let hasComponentCalls = false;
        for (const [componentName] of componentDefinitions) {
          if (source.includes(componentName + '(')) {
            hasComponentCalls = true;
            break;
          }
        }

        // Child mount data to pass to the binding compiler
        let childMounts: ChildMountInfo[] | undefined;

        if (hasComponentCalls) {
          const sourceFile = sourceCache.parse(args.path, source);
          const componentCalls = findComponentCallsCTFE(source, sourceFile, componentDefinitions);

          if (componentCalls.length > 0) {
            // CTFE counter — allocates b0, b1, … for child component anchors.
            // The binding compiler starts its idCounter at this offset.
            let childIdCounter = 0;
            const mounts: ChildMountInfo[] = [];

            const sortedCalls = [...componentCalls].sort((a, b) => b.startIndex - a.startIndex);

            for (const call of sortedCalls) {
              const componentDef = componentDefinitions.get(call.componentName);
              if (componentDef) {
                const anchorId = `b${childIdCounter++}`;
                const compiledHTML = generateComponentHTML({
                  selector: componentDef.selector,
                  props: {},
                  anchorId,
                });

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
