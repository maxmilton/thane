import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { getSetupFunction, unwrapParens } from './component-ast.js';

/** The first call expression in `source`. */
const firstCall = (source: string): ts.CallExpression => {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (!found && ts.isCallExpression(node)) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) throw new Error(`no call in ${source}`);
  return found;
};

/** The expression of the first expression statement in `source`. */
const firstExpression = (source: string): ts.Expression => {
  const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  const statement = sf.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) throw new Error(`no expression in ${source}`);
  return statement.expression;
};

const setupText = (source: string) => {
  const call = firstCall(source);
  const setup = getSetupFunction(call);
  return setup && [ts.SyntaxKind[setup.kind], setup.getText()];
};

describe('getSetupFunction', () => {
  test('one argument: the setup is the first', () => {
    expect(setupText('defineComponent(() => ({ template: html`` }))')).toEqual([
      'ArrowFunction',
      '() => ({ template: html`` })',
    ]);
    expect(setupText('defineComponent(function () { return {}; })')).toEqual([
      'FunctionExpression',
      'function () { return {}; }',
    ]);
  });

  test('two or more arguments: the setup is the second', () => {
    expect(setupText("defineComponent('x-card', (ctx) => ({}))")).toEqual(['ArrowFunction', '(ctx) => ({})']);
    expect(setupText("defineComponent('x-card', function setup() { return {}; })")).toEqual([
      'FunctionExpression',
      'function setup() { return {}; }',
    ]);
    expect(setupText("defineComponent('x-card', () => ({}), __tpl, 'extra')")).toEqual(['ArrowFunction', '() => ({})']);
  });

  test('the argument is chosen by count alone: a function first of two is not the setup', () => {
    expect(setupText('defineComponent(() => ({}), other)')).toBeUndefined();
  });

  test('anything other than an arrow function or function expression gives undefined', () => {
    expect(setupText('defineComponent(setup)')).toBeUndefined();
    expect(setupText("defineComponent('x-card', setup)")).toBeUndefined();
    expect(setupText("defineComponent('x-card')")).toBeUndefined();
    expect(setupText('defineComponent()')).toBeUndefined();
    expect(setupText("defineComponent('x-card', (() => ({})))")).toBeUndefined();
  });

  test('returns the argument node itself', () => {
    const call = firstCall("defineComponent('x-card', () => ({}))");
    expect(getSetupFunction(call)).toBe(call.arguments[1] as ts.ArrowFunction);
  });
});

describe('unwrapParens', () => {
  test('a non-parenthesised expression is returned as it is', () => {
    const expr = firstExpression('x;');
    expect(unwrapParens(expr)).toBe(expr);
  });

  test('any number of parentheses is removed', () => {
    for (const source of ['(x);', '((x));', '(((({ a: 1 }))));']) {
      const inner = unwrapParens(firstExpression(source));
      expect(ts.isParenthesizedExpression(inner)).toBe(false);
      expect(inner.getText()).toBe(source.replace(/^\(+|\)+;$/g, ''));
    }
  });

  test('only parentheses are unwrapped: a cast or a comma expression stays', () => {
    const cast = unwrapParens(firstExpression('((x as T));'));
    expect(ts.isAsExpression(cast)).toBe(true);
    const comma = unwrapParens(firstExpression('((a, b));'));
    expect(ts.isBinaryExpression(comma)).toBe(true);
  });

  test('the body of a concise arrow unwraps to its object literal', () => {
    const call = firstCall('defineComponent(() => (({ template: html`` })))');
    const setup = getSetupFunction(call) as ts.ArrowFunction;
    const body = unwrapParens(setup.body as ts.Expression);
    expect(ts.isObjectLiteralExpression(body)).toBe(true);
  });
});
