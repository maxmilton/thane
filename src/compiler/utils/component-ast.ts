/** AST helpers for `defineComponent(…)` calls. */

import ts from 'typescript';

/**
 * The setup function of a `defineComponent(…)` call: the second argument when there are two or
 * more (`defineComponent('x-card', () => …)`), otherwise the first. Undefined when that argument
 * is missing or is not an arrow function or function expression.
 */
export const getSetupFunction = (call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined => {
  const arg = call.arguments.length >= 2 ? call.arguments[1] : call.arguments[0];
  return arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) ? arg : undefined;
};

/** The expression inside any number of parentheses: `(({ … }))` gives the object literal. */
export const unwrapParens = (expr: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  return expr;
};
