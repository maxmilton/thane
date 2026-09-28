/**
 * THANE400 — no-default-export-component
 *
 * defineComponent() must use a named export so the compiler can auto-derive
 * the component selector from the export name:
 *
 *   export const MyCounter = defineComponent(() => { ... });  // ✅
 *   export default defineComponent(() => { ... });            // ❌ THANE400
 */

import ts from 'typescript';
import type { Diagnostic } from '../../../types.js';
import type { LintRuleDefinition } from './types.js';
import { ErrorCode } from '../../../errors.js';
import { createReporter, isDefineComponentExpr } from './lint-utils.js';

const check = (sourceFile: ts.SourceFile, filePath: string): Diagnostic[] => {
  const { diagnostics, report } = createReporter(sourceFile, filePath, ErrorCode.NO_DEFAULT_EXPORT_COMPONENT, 'error');

  for (const stmt of sourceFile.statements) {
    // export default defineComponent(...)
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals && isDefineComponentExpr(stmt.expression)) {
      report(stmt, 'defineComponent must use a named export: export const MyComponent = defineComponent(...)');
    }
  }

  return diagnostics;
};

export const noDefaultExportComponent: LintRuleDefinition = {
  meta: {
    code: ErrorCode.NO_DEFAULT_EXPORT_COMPONENT,
    name: 'no-default-export-component',
    severity: 'error',
    description: 'defineComponent() must use a named export so the selector can be auto-derived.',
  },
  check,
};
