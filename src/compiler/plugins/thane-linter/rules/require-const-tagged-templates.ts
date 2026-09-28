/**
 * THANE403 — require-const-tagged-templates
 *
 * Tagged template literals `html` and `css` must be declared with `const`,
 * not `let` or `var`:
 *
 *   const header = html`<header>Title</header>`;  // ✅
 *   const styles = css`:host { color: red }`;     // ✅
 *
 *   let header = html`<header>Title</header>`;    // ❌ THANE403
 *   var styles = css`:host { color: red }`;       // ❌ THANE403
 *
 * Templates declared with `let`/`var` can be reassigned, making it
 * impossible for the compiler to resolve their value at compile time.
 * The compiler's template processing pipeline requires a statically
 * known template literal to generate binding code.
 */

import ts from 'typescript';
import type { Diagnostic } from '../../../types.js';
import type { LintRuleDefinition } from './types.js';
import { ErrorCode } from '../../../errors.js';
import { TEMPLATE_TAGS, createReporter, declarationKeyword, isTaggedWith } from './lint-utils.js';

const check = (sourceFile: ts.SourceFile, filePath: string): Diagnostic[] => {
  const { diagnostics, report } = createReporter(
    sourceFile,
    filePath,
    ErrorCode.REQUIRE_CONST_TAGGED_TEMPLATES,
    'error',
  );

  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node)) {
      const keyword = declarationKeyword(node.declarationList);

      if (keyword !== 'const') {
        for (const decl of node.declarationList.declarations) {
          if (decl.initializer && isTaggedWith(decl.initializer, TEMPLATE_TAGS)) {
            const tagName = decl.initializer.tag.text;
            report(
              decl,
              `'${tagName}\`\`' tagged template must use 'const', not '${keyword}'. ` +
                `Templates declared with '${keyword}' can be reassigned and cannot be resolved at compile time.`,
            );
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return diagnostics;
};

export const requireConstTaggedTemplates: LintRuleDefinition = {
  meta: {
    code: ErrorCode.REQUIRE_CONST_TAGGED_TEMPLATES,
    name: 'require-const-tagged-templates',
    severity: 'error',
    description: "html`` and css`` tagged templates must use 'const' declarations.",
  },
  check,
};
