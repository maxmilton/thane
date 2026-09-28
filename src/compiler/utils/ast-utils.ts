/** Helpers for working with the TypeScript AST. */

import ts from 'typescript';
import type { ComponentDefinition } from '../types.js';
import { FN } from './constants.js';

// ============================================================================
// Source File Creation
// ============================================================================

export const createSourceFile = (filePath: string, source: string): ts.SourceFile => {
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
};

// ============================================================================
// Function Call Detection
// ============================================================================

export const isFunctionCall = (node: ts.CallExpression, functionName: string): boolean => {
  return ts.isIdentifier(node.expression) && node.expression.text === functionName;
};

export const isSignalCall = (node: ts.CallExpression): boolean => {
  return isFunctionCall(node, FN.SIGNAL);
};

export const isDefineComponentCall = (node: ts.CallExpression): boolean => {
  return isFunctionCall(node, FN.DEFINE_COMPONENT);
};

/**
 * Convert PascalCase to kebab-case for auto-derived selectors.
 * Example: 'MyCounter' → 'my-counter', 'TodoItem' → 'todo-item'
 */
export const pascalToKebab = (name: string): string => {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
};

// ============================================================================
// Signal Detection
// ============================================================================

/**
 * Extract static value from an expression if possible
 * Used for signal initializers and compile-time evaluation
 */
export const extractStaticValue = (arg: ts.Expression): string | number | boolean | null => {
  if (ts.isStringLiteral(arg)) return arg.text;
  if (ts.isNumericLiteral(arg)) return Number(arg.text);
  if (arg.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (arg.kind === ts.SyntaxKind.FalseKeyword) return false;

  // Simple string concatenation: "a" + "b"
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = extractStaticValue(arg.left);
    const right = extractStaticValue(arg.right);
    if (typeof left === 'string' && typeof right === 'string') {
      return left + right;
    }
  }
  return null;
};

/**
 * Find all signal property declarations and their initial values.
 * Supports both class property pattern (this._count = signal(0))
 * and variable pattern (const count = signal(0)).
 */
export const findSignalInitializers = (sourceFile: ts.SourceFile): Map<string, string | number | boolean> => {
  const initializers = new Map<string, string | number | boolean>();

  const visit = (node: ts.Node) => {
    // Class property pattern: private _count = signal(0)
    if (
      ts.isPropertyDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      isSignalCall(node.initializer)
    ) {
      const args = node.initializer.arguments;
      const firstArg = args[0];
      if (args.length > 0 && firstArg) {
        const value = extractStaticValue(firstArg);
        if (value !== null) {
          initializers.set(node.name.text, value);
        }
      }
    }

    // Variable pattern: const count = signal(0)
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      isSignalCall(node.initializer)
    ) {
      const args = node.initializer.arguments;
      const firstArg = args[0];
      if (args.length > 0 && firstArg) {
        const value = extractStaticValue(firstArg);
        if (value !== null) {
          initializers.set(node.name.text, value);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return initializers;
};

// ============================================================================
// Template Detection
// ============================================================================

export const isHtmlTemplate = (node: ts.TaggedTemplateExpression): boolean => {
  return ts.isIdentifier(node.tag) && node.tag.text === FN.HTML;
};

export const hasHtmlTemplates = (source: string): boolean => {
  return source.includes('html`');
};

// ============================================================================
// Component Registration
// ============================================================================

/**
 * Extract all component definitions from a source file.
 * Supports defineComponent() pattern.
 */
export const extractComponentDefinitions = (sourceFile: ts.SourceFile, filePath: string): ComponentDefinition[] => {
  const definitions: ComponentDefinition[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node)) {
      const hasExport = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (hasExport) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer && ts.isCallExpression(decl.initializer)) {
            const exportName = decl.name.text;
            const call = decl.initializer;

            // defineComponent pattern
            if (isDefineComponentCall(call)) {
              let selector: string | null = null;

              // Check if first arg is a string literal (explicit selector)
              const firstArg = call.arguments[0];
              if (firstArg && ts.isStringLiteral(firstArg)) {
                selector = firstArg.text;
              } else {
                // Auto-derive from export name
                selector = pascalToKebab(exportName);
              }

              if (selector) {
                definitions.push({
                  name: exportName,
                  selector,
                  filePath,
                });
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return definitions;
};

// ============================================================================
// Utility Functions
// ============================================================================

export const toCamelCase = (str: string): string => {
  return str.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
};

// ============================================================================
// AST-based Expression Utilities
// ============================================================================

/**
 * `expr` with each reference to the variable `name` replaced by `replacement`. A string, a property
 * name or a property access is not a reference. Everything else keeps its text: printed again, an
 * html`` template inside would read `html \`…\``, which the template parser takes for markup. A
 * function inside that declares its own `name` shadows it there, as in JavaScript.
 */
export const replaceReferences = (expr: string, name: string, replacement: string): string => {
  const sf = ts.createSourceFile('__expr.ts', `(${expr})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: [start: number, end: number, text: string][] = [];
  const binds = (n: ts.BindingName): boolean =>
    ts.isIdentifier(n) ? n.text === name : n.elements.some((e) => !ts.isOmittedExpression(e) && binds(e.name));
  const isPropertyName = (node: ts.Identifier): boolean => {
    const p = node.parent;
    return (
      ((ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) &&
        p.name === node) ||
      ((ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === node) ||
      (ts.isBindingElement(p) && p.propertyName === node)
    );
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node.parameters.some((p) => binds(p.name))) return;
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === name) {
      // `{ name }` keeps its key: `{ name: replacement }`
      edits.push([node.name.end, node.name.end, `: ${replacement}`]);
      return;
    }
    if (ts.isIdentifier(node) && node.text === name && !isPropertyName(node)) {
      edits.push([node.getStart(sf), node.end, replacement]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  let out = `(${expr})`;
  for (const [start, end, text] of edits.reverse()) out = out.slice(0, start) + text + out.slice(end);
  return out.slice(1, -1);
};

/** Check whether an expression references a given identifier (AST-based, not regex). */
export const expressionReferencesIdentifier = (expression: string, identifierName: string): boolean => {
  const wrapped = `(${expression})`;
  const sf = ts.createSourceFile('__expr.ts', wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === identifierName) {
      const parent = node.parent;
      if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) {
        // This is the .prop part — not a reference to the identifier
      } else {
        found = true;
      }
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};

/**
 * Parse an arrow function expression and return its parameter list and body.
 * Uses TS AST to correctly handle destructuring, defaults, and nested parens.
 * Returns null if the expression is not an arrow function.
 */
export const parseArrowFunction = (
  expression: string,
): {
  params: string;
  body: string;
  isBlockBody: boolean;
} | null => {
  const wrapped = `(${expression})`;
  const sf = ts.createSourceFile('__expr.ts', wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  let result: { params: string; body: string; isBlockBody: boolean } | null = null;

  const visit = (node: ts.Node) => {
    if (result) return;
    if (ts.isArrowFunction(node)) {
      const params = node.parameters.map((p) => p.getText(sf)).join(', ');
      const body = node.body.getText(sf);
      const isBlockBody = ts.isBlock(node.body);
      result = { params, body, isBlockBody };
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result;
};
