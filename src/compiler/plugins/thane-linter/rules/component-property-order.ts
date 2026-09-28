/**
 * THANE401 — component-property-order
 *
 * The return object of defineComponent() must declare properties in
 * canonical lifecycle order:
 *
 *   template → styles → onMount → onDestroy
 *
 * Out-of-order declarations are a build error.
 */

import ts from 'typescript';
import type { Diagnostic } from '../../../types.js';
import type { LintRuleDefinition } from './types.js';
import { ErrorCode } from '../../../errors.js';
import { createReporter, findReturnObjects, type Report } from './lint-utils.js';

/** Canonical property order. Properties not in this list are ignored. */
const CANONICAL_ORDER = ['template', 'styles', 'onMount', 'onDestroy'] as const;

const orderIndex = new Map<string, number>(CANONICAL_ORDER.map((name, i) => [name, i]));

/**
 * Check a single return object for out-of-order properties.
 */
const checkPropertyOrder = (obj: ts.ObjectLiteralExpression, report: Report): void => {
  let lastIdx = -1;
  let lastName = '';

  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop) && !ts.isMethodDeclaration(prop)) {
      continue;
    }
    const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
    if (!name) continue;

    const idx = orderIndex.get(name);
    if (idx === undefined) continue; // not a lifecycle property — skip

    if (idx < lastIdx) {
      // Build the "expected order" hint
      const orderHint = CANONICAL_ORDER.join(' → ');

      report(prop, `'${name}' must be declared before '${lastName}' (required order: ${orderHint})`);
    }

    lastIdx = idx;
    lastName = name;
  }
};

const check = (sourceFile: ts.SourceFile, filePath: string): Diagnostic[] => {
  const { diagnostics, report } = createReporter(sourceFile, filePath, ErrorCode.COMPONENT_PROPERTY_ORDER, 'error');
  for (const obj of findReturnObjects(sourceFile)) {
    checkPropertyOrder(obj, report);
  }

  return diagnostics;
};

export const componentPropertyOrder: LintRuleDefinition = {
  meta: {
    code: ErrorCode.COMPONENT_PROPERTY_ORDER,
    name: 'component-property-order',
    severity: 'error',
    description:
      'Enforce canonical property order in defineComponent return objects (template → styles → onMount → onDestroy).',
  },
  check,
};
