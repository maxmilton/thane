/**
 * THANE402 — lifecycle-arrow-function
 *
 * Lifecycle hooks in the defineComponent() return object must be
 * arrow functions, not method shorthand or regular function expressions:
 *
 *   onMount: () => { ... },   // ✅ arrow function
 *   onDestroy: () => { ... }, // ✅ arrow function
 *
 *   onMount() { ... },                   // ❌ THANE402 — method shorthand
 *   onMount: function() { ... },         // ❌ THANE402 — function expression
 *
 * This keeps a consistent code style and avoids accidental `this` binding
 * issues — arrow functions inherit the enclosing lexical scope, which is
 * the only correct context inside defineComponent.
 */

import ts from 'typescript';
import type { Diagnostic } from '../../../types.js';
import type { LintRuleDefinition } from './types.js';
import { ErrorCode } from '../../../errors.js';
import { createReporter, findReturnObjects, type Report } from './lint-utils.js';

/** Properties that must be arrow functions. */
const LIFECYCLE_PROPS = new Set(['onMount', 'onDestroy']);

// ============================================================================
// Rule check
// ============================================================================

/**
 * Inspect each property in the return object. If it is a lifecycle hook,
 * the value must be an arrow function — not a method declaration (shorthand)
 * and not a regular `function()` expression.
 */
const checkArrowFunctions = (obj: ts.ObjectLiteralExpression, report: Report): void => {
  for (const prop of obj.properties) {
    // Get the property name regardless of node type
    const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
    if (!name || !LIFECYCLE_PROPS.has(name)) continue;

    // ── Method declaration shorthand: onMount() { ... } ──────────────
    if (ts.isMethodDeclaration(prop)) {
      report(prop, `'${name}' must be an arrow function, not a method shorthand (use '${name}: () => { ... }')`);
      continue;
    }

    // ── Property assignment: onMount: <expr> ─────────────────────────
    if (ts.isPropertyAssignment(prop)) {
      const init = prop.initializer;

      // Regular function expression: onMount: function() { ... }
      if (ts.isFunctionExpression(init)) {
        report(prop, `'${name}' must be an arrow function, not a function expression (use '${name}: () => { ... }')`);
        continue;
      }

      // Arrow function — this is correct, no diagnostic
      if (ts.isArrowFunction(init)) {
        continue;
      }

      // Anything else (identifier reference, call expression, etc.) — also flag
      report(prop, `'${name}' must be an inline arrow function (use '${name}: () => { ... }')`);
    }
  }
};

const check = (sourceFile: ts.SourceFile, filePath: string): Diagnostic[] => {
  const { diagnostics, report } = createReporter(sourceFile, filePath, ErrorCode.LIFECYCLE_ARROW_FUNCTION, 'error');
  for (const obj of findReturnObjects(sourceFile)) {
    checkArrowFunctions(obj, report);
  }

  return diagnostics;
};

export const lifecycleArrowFunction: LintRuleDefinition = {
  meta: {
    code: ErrorCode.LIFECYCLE_ARROW_FUNCTION,
    name: 'lifecycle-arrow-function',
    severity: 'error',
    description: 'Lifecycle hooks (onMount, onDestroy) must use arrow functions.',
  },
  check,
};
