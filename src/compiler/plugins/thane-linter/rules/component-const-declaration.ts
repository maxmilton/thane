/**
 * THANE408 — component-const-declaration
 *
 * Component declarations using `defineComponent()` must use `const`,
 * not `let` or `var`. Reassigning a component variable after creation
 * would break the compiler's static analysis and could cause selector
 * collisions or lost references.
 *
 *   export const MyCounter = defineComponent(() => { ... });  // ✅
 *
 *   export let MyCounter = defineComponent(() => { ... });    // ❌ THANE408
 *   export var MyCounter = defineComponent(() => { ... });    // ❌ THANE408
 */

import ts from 'typescript';
import type { Diagnostic } from '../../../types.js';
import type { LintRuleDefinition } from './types.js';
import { ErrorCode } from '../../../errors.js';
import { createReporter, declarationKeyword, isDefineComponentExpr } from './lint-utils.js';

const check = (sourceFile: ts.SourceFile, filePath: string): Diagnostic[] => {
  const { diagnostics, report } = createReporter(sourceFile, filePath, ErrorCode.COMPONENT_CONST_DECLARATION, 'error');

  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node)) {
      const keyword = declarationKeyword(node.declarationList);

      if (keyword !== 'const') {
        for (const decl of node.declarationList.declarations) {
          if (decl.initializer && isDefineComponentExpr(decl.initializer)) {
            report(
              decl,
              `Component declaration must use 'const', not '${keyword}'. ` +
                "Reassigning a component variable breaks the compiler's static analysis " +
                'and can cause selector collisions.',
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

export const componentConstDeclaration: LintRuleDefinition = {
  meta: {
    code: ErrorCode.COMPONENT_CONST_DECLARATION,
    name: 'component-const-declaration',
    severity: 'error',
    description: "defineComponent() declarations must use 'const'.",
  },
  check,
};
