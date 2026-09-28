/** Helpers shared by the lint rules. */

import ts from 'typescript';
import type { Diagnostic, DiagnosticSeverity } from '../../../types.js';
import { createDiagnostic } from '../../../errors.js';
import { isDefineComponentCall } from '../../../utils/ast-utils.js';
import { unwrapParens } from '../../../utils/component-ast.js';
import { FN } from '../../../utils/constants.js';

/** 1-based line and column of a node's first token (after comments and whitespace). */
export const locate = (sourceFile: ts.SourceFile, node: ts.Node): { line: number; column: number } => {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
};

/** Records a diagnostic located at `node`. */
export type Report = (node: ts.Node, message: string) => void;

/**
 * The diagnostics of one rule run, and `report`, which adds one with the rule's code and severity,
 * located in `filePath` at the node's first token.
 */
export const createReporter = (
  sourceFile: ts.SourceFile,
  filePath: string,
  code: string,
  severity: DiagnosticSeverity,
): { diagnostics: Diagnostic[]; report: Report } => {
  const diagnostics: Diagnostic[] = [];
  const report: Report = (node, message) => {
    diagnostics.push(createDiagnostic(severity, message, { file: filePath, ...locate(sourceFile, node) }, code));
  };
  return { diagnostics, report };
};

/** Tags of the templates the compiler resolves at compile time. */
export const TEMPLATE_TAGS: readonly string[] = [FN.HTML, FN.CSS];

/** A `defineComponent(…)` call whose callee is the plain identifier (not `lib.defineComponent`). */
export const isDefineComponentExpr = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) && isDefineComponentCall(node);

/** A tagged template whose tag is a plain identifier in `names` (html`…`, not lib.html`…`). */
export const isTaggedWith = (
  node: ts.Node,
  names: readonly string[],
): node is ts.TaggedTemplateExpression & { readonly tag: ts.Identifier } =>
  ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && names.includes(node.tag.text);

/**
 * The keyword a declaration list is reported as: 'const' when the Const flag is set (`await using`
 * included), otherwise 'let' when the Let flag is set, otherwise 'var' (`using` included).
 */
export const declarationKeyword = (list: ts.VariableDeclarationList): 'const' | 'let' | 'var' =>
  list.flags & ts.NodeFlags.Const ? 'const' : list.flags & ts.NodeFlags.Let ? 'let' : 'var';

/**
 * The return objects THANE401 and THANE402 inspect. For each `defineComponent(…)` call, and each arrow
 * or function expression among its arguments: a concise body that is an object literal (in any number
 * of parentheses), or each top-level `return {…}` statement of a block body. Returns inside other
 * statements or nested functions and `return ({…})` are not included, and the arguments are not searched
 * for further calls. The compiler finds return objects differently (H-07).
 */
export const findReturnObjects = (root: ts.Node): ts.ObjectLiteralExpression[] => {
  const results: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (!isDefineComponentExpr(node)) {
      ts.forEachChild(node, visit);
      return;
    }
    for (const arg of node.arguments) {
      if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) continue;
      if (ts.isBlock(arg.body)) {
        for (const stmt of arg.body.statements) {
          if (ts.isReturnStatement(stmt) && stmt.expression && ts.isObjectLiteralExpression(stmt.expression)) {
            results.push(stmt.expression);
          }
        }
      } else {
        const expr = unwrapParens(arg.body);
        if (ts.isObjectLiteralExpression(expr)) results.push(expr);
      }
    }
  };
  visit(root);
  return results;
};
