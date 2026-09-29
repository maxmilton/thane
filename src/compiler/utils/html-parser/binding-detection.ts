/**
 * HTML Parser — Binding detection
 *
 * Finds signal bindings, events, when/whenElse/repeat directives in parsed HTML.
 */

import type { HtmlElement, BindingInfo } from './types.js';
import ts from 'typescript';
import { WHEN_ELSE_REGEX, REPEAT_REGEX, SIGNAL_EXPR_REGEX } from './types.js';
import { logger } from '../logger.js';
import { parseArrowFunction } from '../ast-utils.js';
import { ErrorCode } from '../../errors.js';

/**
 * Shared argument parser for both whenElse and repeat expressions.
 *
 * Parses a comma-separated argument list from a `${directive(` call: strings and template
 * literals are skipped whole by the expression scanner, and a comma splits only outside
 * every bracket.
 *
 * @param text - full text being parsed
 * @param startPos - position right after the opening paren of the directive
 * @returns parsed args and end position, or null if parsing fails
 */
function parseDirectiveArgs(text: string, startPos: number): { args: string[]; end: number } | null {
  let parenDepth = 1;
  let braceDepth = 0;
  let bracketDepth = 0;
  const args: string[] = [];
  let argStart = startPos;

  for (let pos = startPos; pos < text.length; pos++) {
    const char = text[pos];
    if (char === "'" || char === '"' || char === '`') {
      pos = literalEnd(text, pos);
      if (pos === -1) return null;
    } else if (char === '(') {
      parenDepth++;
    } else if (char === ')' && --parenDepth === 0) {
      const finalArg = text.slice(argStart, pos).trim();
      if (finalArg !== '') args.push(finalArg);
      return { args, end: text[pos + 1] === '}' ? pos + 2 : pos + 1 };
    } else if (char === '{') {
      braceDepth++;
    } else if (char === '}' && braceDepth > 0) {
      braceDepth--;
    } else if (char === '[') {
      bracketDepth++;
    } else if (char === ']' && bracketDepth > 0) {
      bracketDepth--;
    } else if (char === ',' && parenDepth === 1 && braceDepth === 0 && bracketDepth === 0) {
      args.push(text.slice(argStart, pos).trim());
      argStart = pos + 1;
    }
  }

  return null;
}

function extractHtmlTemplateContent(arg: string): string {
  const htmlMatch = arg.match(/^html`([\s\S]*)`$/);
  if (htmlMatch && htmlMatch[1] !== undefined) {
    return htmlMatch[1];
  }

  const plainMatch = arg.match(/^`([\s\S]*)`$/);
  if (plainMatch && plainMatch[1] !== undefined) {
    return plainMatch[1];
  }

  return arg;
}

/** What the signal detector knows of the names a component's templates see (see template-scope.ts) */
export interface TemplateScope {
  /** Whether the name is a function the component declares (not a signal) */
  isFunction(name: string): boolean;
  /** The signals such a function reads, its helpers' included */
  readsOf(name: string): string[];
}

/** The scope of the component being compiled; the component compiler sets it around its compile */
let templateScope: TemplateScope | undefined;

/** Set the scope the signal detector resolves names in, for the component being compiled (undefined after it) */
export const setTemplateScope = (scope: TemplateScope | undefined): void => {
  templateScope = scope;
};

export function extractSignalsFromExpression(expression: string): string[] {
  const signals: string[] = [];
  const sourceFile = ts.createSourceFile(
    '__thane_expr.ts',
    `(${expression})`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    // A function of the component is not a signal: the binding follows the signals it reads
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      templateScope?.isFunction(node.expression.text)
    ) {
      for (const signal of templateScope.readsOf(node.expression.text)) {
        if (!signals.includes(signal)) signals.push(signal);
      }
    } else if (ts.isCallExpression(node) && node.arguments.length === 0) {
      // `count()` reads a signal in scope; `props.count()` reads a signal passed as a prop
      const callee = node.expression;
      const signalName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === 'props' &&
            ts.isIdentifier(callee.name)
          ? `props.${callee.name.text}`
          : undefined;
      if (signalName !== undefined && !signals.includes(signalName)) {
        signals.push(signalName);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return signals;
}

/** Whether the character at `pos` is escaped: an odd run of backslashes before it (`\${` is text). */
export function isEscaped(text: string, pos: number): boolean {
  let i = pos;
  while (i > 0 && text[i - 1] === '\\') i--;
  return (pos - i) % 2 === 1;
}

/** The template with every `${…}` expression removed, nested template literals included. */
export function stripTemplateExpressions(value: string): string {
  let out = '';
  let last = 0;
  for (const span of findTemplateExpressions(value)) {
    out += value.slice(last, span.start);
    last = span.end;
  }
  return out + value.slice(last);
}

/**
 * End (exclusive) of the `${…}` that starts at `start`, or -1 when it is not closed. The one
 * expression scanner: braces count in code only, so a brace inside a string or a nested
 * template literal (whose own `${…}` are scanned the same way, at any depth) never ends it.
 */
export function templateExpressionEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start + 2; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}' && depth-- === 0) return i + 1;
    else if (ch === '"' || ch === "'" || ch === '`') {
      i = literalEnd(text, i);
      if (i === -1) return -1;
    }
  }
  return -1;
}

/** Index of the quote that closes the string or template literal opened at `start`, or -1. */
function literalEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') i++;
    else if (ch === quote) return i;
    else if (quote === '`' && ch === '$' && text[i + 1] === '{') {
      i = templateExpressionEnd(text, i) - 1;
      if (i < 0) return -1;
    }
  }
  return -1;
}

export function findTemplateExpressions(
  value: string,
): Array<{ start: number; end: number; expression: string; full: string }> {
  const results: Array<{ start: number; end: number; expression: string; full: string }> = [];
  let searchPos = 0;
  let start: number;

  while ((start = value.indexOf('${', searchPos)) !== -1) {
    const end = isEscaped(value, start) ? -1 : templateExpressionEnd(value, start);
    if (end === -1) {
      searchPos = start + 2;
      continue;
    }
    const expression = value.substring(start + 2, end - 1).trim();
    results.push({ start, end, expression, full: value.substring(start, end) });
    searchPos = end;
  }

  return results;
}

type TemplateExpressionSpan = { start: number; end: number; expression: string; full: string };

interface StyleDeclaration {
  property: string;
  /** Range of the declaration's value inside the attribute value, surrounding whitespace excluded */
  valueStart: number;
  valueEnd: number;
  /** The `${…}` expressions that sit inside the value */
  expressions: TemplateExpressionSpan[];
}

/**
 * Split an inline style into its declarations. Expressions are masked first, so a `;` or
 * `:` inside `${a() ? 'x' : 'y'}` never ends a declaration or names a property; `;` inside
 * parentheses or quotes (`url(data:…;base64,…)`) is ignored the same way.
 */
function splitStyleDeclarations(styleValue: string, expressions: TemplateExpressionSpan[]): StyleDeclaration[] {
  const masked = styleValue.split('');
  for (const expr of expressions) {
    for (let i = expr.start; i < expr.end; i++) masked[i] = '';
  }

  const declarations: StyleDeclaration[] = [];
  const pushDeclaration = (start: number, end: number): void => {
    let colon = -1;
    for (let i = start; i < end; i++) {
      if (masked[i] === ':') {
        colon = i;
        break;
      }
    }
    if (colon === -1) return;
    const property = masked.slice(start, colon).join('').trim();
    if (!/^[\w-]+$/.test(property)) return;

    let valueStart = colon + 1;
    let valueEnd = end;
    while (valueStart < valueEnd && /\s/.test(styleValue[valueStart]!)) valueStart++;
    while (valueEnd > valueStart && /\s/.test(styleValue[valueEnd - 1]!)) valueEnd--;
    declarations.push({
      property,
      valueStart,
      valueEnd,
      expressions: expressions.filter((e) => e.start >= valueStart && e.end <= valueEnd),
    });
  };

  let declStart = 0;
  let parenDepth = 0;
  let quote = '';
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]!;
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') parenDepth++;
    else if (ch === ')' && parenDepth > 0) parenDepth--;
    else if (ch === ';' && parenDepth === 0) {
      pushDeclaration(declStart, i);
      declStart = i + 1;
    }
  }
  pushDeclaration(declStart, masked.length);
  return declarations;
}

function parseWhenElseExpression(
  text: string,
  startPos: number,
): {
  end: number;
  condition: string;
  thenTemplate: string;
  elseTemplate: string;
  signals: string[];
} | null {
  const argsStart = startPos + '${whenElse('.length;
  const parsed = parseDirectiveArgs(text, argsStart);
  if (!parsed) return null;

  const filteredArgs = parsed.args.filter((a) => a.trim() !== '');
  if (filteredArgs.length !== 3) return null;

  const condition = filteredArgs[0];
  const arg1 = filteredArgs[1];
  const arg2 = filteredArgs[2];
  if (!condition || !arg1 || !arg2) return null;

  const thenTemplate = extractHtmlTemplateContent(arg1);
  const elseTemplate = extractHtmlTemplateContent(arg2);
  const signals = extractSignalsFromExpression(condition);

  return {
    end: parsed.end,
    condition,
    thenTemplate,
    elseTemplate,
    signals,
  };
}

function parseRepeatExpression(
  text: string,
  startPos: number,
): {
  end: number;
  itemsExpression: string;
  itemVar: string;
  indexVar?: string | undefined;
  itemTemplate: string;
  emptyTemplate?: string | undefined;
  trackByFn?: string | undefined;
  signals: string[];
} | null {
  const argsStart = startPos + '${repeat('.length;
  const parsed = parseDirectiveArgs(text, argsStart);
  if (!parsed) return null;

  const filteredArgs = parsed.args.filter((a) => a.trim() !== '');

  if (filteredArgs.length < 2 || filteredArgs.length > 4) {
    return null;
  }

  const itemsExpression = filteredArgs[0];
  const templateFn = filteredArgs[1];
  if (!itemsExpression || !templateFn) {
    return null;
  }

  const arrowParsed = parseArrowFunction(templateFn);
  if (!arrowParsed) {
    return null;
  }

  const params = arrowParsed.params.split(',').map((p) => p.trim());
  const itemVar = params[0];
  if (!itemVar) return null;
  const indexVar = params[1];

  const templateBody = arrowParsed.body.trim();
  const itemTemplate = extractHtmlTemplateContent(templateBody);

  let emptyTemplate: string | undefined;
  const arg2 = filteredArgs[2];
  if (filteredArgs.length >= 3 && arg2 && arg2.trim() !== 'null' && arg2.trim() !== 'undefined') {
    emptyTemplate = extractHtmlTemplateContent(arg2.trim());
  }

  let trackByFn: string | undefined;
  const arg3 = filteredArgs[3];
  if (filteredArgs.length === 4 && arg3) {
    const trimmed = arg3.trim();
    const parsed2 = parseArrowFunction(trimmed);
    if (!parsed2) {
      logger.warn(
        'html-parser',
        `trackBy function should be an arrow function returning a key property, e.g., (item) => item.id`,
      );
    }
    trackByFn = trimmed;
  }

  const signals = extractSignalsFromExpression(itemsExpression);

  return {
    end: parsed.end,
    itemsExpression,
    itemVar,
    indexVar,
    itemTemplate,
    emptyTemplate,
    trackByFn,
    signals,
  };
}

/** Options for controlling binding detection behaviour */
export interface BindingDetectionOptions {
  /** When true, create bindings for non-signal expressions (e.g. product.image).
   *  Only appropriate for component-level templates (module scope). */
  detectNonSignalBindings?: boolean;
}

export function findBindingsInText(
  text: string,
  textStart: number,
  parent: HtmlElement | null,
  bindings: BindingInfo[],
  options?: BindingDetectionOptions,
): void {
  if (!parent) return;

  const complexExprPositions: Array<{ start: number; end: number }> = [];

  const whenElseRegex = WHEN_ELSE_REGEX();
  let whenElseMatch: RegExpExecArray | null;

  while ((whenElseMatch = whenElseRegex.exec(text)) !== null) {
    const startPos = whenElseMatch.index;
    const parsed = isEscaped(text, startPos) ? null : parseWhenElseExpression(text, startPos);
    if (parsed) {
      complexExprPositions.push({ start: startPos, end: parsed.end });

      bindings.push({
        element: parent,
        type: 'whenElse',
        signalName: parsed.signals[0] || '',
        signalNames: parsed.signals,
        expressionStart: textStart + startPos,
        expressionEnd: textStart + parsed.end,
        fullExpression: text.substring(startPos, parsed.end),
        jsExpression: parsed.condition,
        thenTemplate: parsed.thenTemplate,
        elseTemplate: parsed.elseTemplate,
      });
    }
  }

  const repeatRegex = REPEAT_REGEX();
  let repeatMatch: RegExpExecArray | null;

  while ((repeatMatch = repeatRegex.exec(text)) !== null) {
    const startPos = repeatMatch.index;
    const parsed = isEscaped(text, startPos) ? null : parseRepeatExpression(text, startPos);
    if (parsed) {
      complexExprPositions.push({ start: startPos, end: parsed.end });

      bindings.push({
        element: parent,
        type: 'repeat',
        signalName: parsed.signals[0] || '',
        signalNames: parsed.signals,
        expressionStart: textStart + startPos,
        expressionEnd: textStart + parsed.end,
        fullExpression: text.substring(startPos, parsed.end),
        itemsExpression: parsed.itemsExpression,
        itemVar: parsed.itemVar,
        indexVar: parsed.indexVar,
        itemTemplate: parsed.itemTemplate,
        emptyTemplate: parsed.emptyTemplate,
        trackByFn: parsed.trackByFn,
      });
    }
  }

  const signalExprRegex = SIGNAL_EXPR_REGEX();
  let match: RegExpExecArray | null;

  // Track bare signal binding positions so we skip them for complex expression detection
  const bareSignalPositions: Array<{ start: number; end: number }> = [];

  while ((match = signalExprRegex.exec(text)) !== null) {
    const pos = match.index;
    const insideComplex = complexExprPositions.some((cp) => pos >= cp.start && pos < cp.end);
    if (insideComplex || isEscaped(text, pos)) continue;

    const signalName = match[1];
    // A function of the component is an expression: the loop below follows the signals it reads
    if (!signalName || templateScope?.isFunction(signalName)) continue;

    bareSignalPositions.push({ start: pos, end: pos + match[0].length });

    bindings.push({
      element: parent,
      type: 'text',
      signalName,
      expressionStart: textStart + match.index,
      expressionEnd: textStart + match.index + match[0].length,
      fullExpression: match[0],
    });
  }

  // ── Complex expression text bindings ──
  // Detect ${expr} interpolations that contain signal calls but aren't bare ${sig()}.
  // Examples: ${count() + 1}, ${isActive() ? 'Yes' : 'No'}, ${a() + b()}
  // A `${` inside a whenElse/repeat/bare-signal range is stepped over, not the whole `${…}` it
  // opens: a directive's range ends at its `)`, and an expression after that is still reached.
  const allSkipRanges = [...complexExprPositions, ...bareSignalPositions];
  let searchPos = 0;
  let dollarIdx: number;
  while ((dollarIdx = text.indexOf('${', searchPos)) !== -1) {
    const insideSkipRange = allSkipRanges.some((r) => dollarIdx >= r.start && dollarIdx < r.end);
    const end = insideSkipRange || isEscaped(text, dollarIdx) ? -1 : templateExpressionEnd(text, dollarIdx);
    if (end === -1) {
      searchPos = dollarIdx + 2;
      continue;
    }

    const exprContent = text.substring(dollarIdx + 2, end - 1); // inner expression (without ${ and })
    const signals = extractSignalsFromExpression(exprContent);
    // A non-signal expression (e.g. prop access like product.title) is a static expression binding
    if (signals.length > 0 || (options?.detectNonSignalBindings && exprContent.trim())) {
      bindings.push({
        element: parent,
        type: 'text',
        signalName: signals[0] ?? '',
        signalNames: signals,
        expressionStart: textStart + dollarIdx,
        expressionEnd: textStart + end,
        fullExpression: text.substring(dollarIdx, end),
        jsExpression: exprContent,
      });
    }

    searchPos = end;
  }
}

export function findBindingsInAttributes(
  element: HtmlElement,
  bindings: BindingInfo[],
  options?: BindingDetectionOptions,
): void {
  /** A value that is one `${…}`: a bare `${sig()}` binds the signal by name, anything else as an expression. */
  const pushExpressionBinding = (
    type: 'attr' | 'style',
    property: string,
    expr: TemplateExpressionSpan,
    offset: number,
  ): void => {
    const signals = extractSignalsFromExpression(expr.expression);
    if (signals.length === 0 && !options?.detectNonSignalBindings) return;
    const bareMatch = signals.length > 0 ? expr.expression.match(/^\s*(\w+)\(\)\s*$/) : null;
    const bareSignal = bareMatch && !templateScope?.isFunction(bareMatch[1]!) ? bareMatch : null;
    bindings.push({
      element,
      type,
      signalName: bareSignal?.[1] ?? signals[0] ?? '',
      ...(bareSignal ? {} : { signalNames: signals, jsExpression: expr.expression }),
      property,
      expressionStart: offset + expr.start,
      expressionEnd: offset + expr.end,
      fullExpression: expr.full,
    });
  };

  /** A value with static text or several expressions: one binding, written as a template literal. */
  const pushTemplateLiteralBinding = (
    type: 'attr' | 'style',
    property: string,
    valueText: string,
    start: number,
    expressions: TemplateExpressionSpan[],
  ): void => {
    const signals = [...new Set(expressions.flatMap((e) => extractSignalsFromExpression(e.expression)))];
    if (signals.length === 0 && !options?.detectNonSignalBindings) return;
    bindings.push({
      element,
      type,
      signalName: signals[0] ?? '',
      signalNames: signals,
      jsExpression: '`' + valueText + '`',
      property,
      expressionStart: start,
      expressionEnd: start + valueText.length,
      fullExpression: valueText,
    });
  };

  if (element.whenDirective) {
    const whenMatch = element.whenDirective.match(/^\$\{when\((.+)\)\}$/);
    if (whenMatch) {
      const innerExpr = whenMatch[1];
      if (!innerExpr) return;
      const signals = extractSignalsFromExpression(innerExpr);

      const primarySignal = signals[0] || '';
      bindings.push({
        element,
        type: 'when',
        signalName: primarySignal,
        signalNames: signals,
        expressionStart: element.whenDirectiveStart!,
        expressionEnd: element.whenDirectiveEnd!,
        fullExpression: element.whenDirective,
        jsExpression: innerExpr,
      });
    }
  }

  for (const [name, attr] of element.attributes) {
    if (name.startsWith(':')) {
      throw new Error(
        `${ErrorCode.PREFIXED_ATTRIBUTE}: attribute "${name}" — the ":" prefix is not a binding syntax. Write ${name.slice(1)}=\${…} instead.`,
      );
    }
    if (name.startsWith('@')) {
      const eventParts = name.slice(1).split('.');
      const eventName = eventParts[0];
      const modifiers = eventParts.slice(1);

      const eventExprMatch = attr.value.match(/^\$\{(.+)\}$/s);
      if (eventExprMatch && eventExprMatch[1]) {
        const handlerExpression = eventExprMatch[1].trim();
        bindings.push({
          element,
          type: 'event',
          signalName: '',
          eventName,
          eventModifiers: modifiers,
          handlerExpression,
          expressionStart: attr.start,
          expressionEnd: attr.end,
          fullExpression: `@${name.slice(1)}="${attr.value}"`,
        });
      }
      continue;
    }

    // `style=${expr}` (the whole value is one expression) is an attribute binding written
    // through cssText; `style="prop: ${expr}"` binds each property individually.
    const wholeValueIsExpression =
      /^\s*\$\{[\s\S]*\}\s*$/.test(attr.value) && findTemplateExpressions(attr.value).length === 1;
    if (name === 'style' && !wholeValueIsExpression) {
      const styleExprs = findTemplateExpressions(attr.value);
      for (const declaration of splitStyleDeclarations(attr.value, styleExprs)) {
        if (declaration.expressions.length === 0) continue;
        const expr = declaration.expressions[0]!;
        const valueIsOneExpression =
          declaration.expressions.length === 1 &&
          expr.start === declaration.valueStart &&
          expr.end === declaration.valueEnd;

        // `width: ${w()}px` or `margin: ${a()}px ${b()}em` — the static text belongs to the
        // value, so the whole declaration value is one binding written as a template literal.
        if (valueIsOneExpression) {
          pushExpressionBinding('style', declaration.property, expr, attr.valueStart);
        } else {
          pushTemplateLiteralBinding(
            'style',
            declaration.property,
            attr.value.substring(declaration.valueStart, declaration.valueEnd),
            attr.valueStart + declaration.valueStart,
            declaration.expressions,
          );
        }
      }
      continue;
    }

    const attrExprs = findTemplateExpressions(attr.value);
    // Static text around an expression, or several expressions, make one binding whose value is
    // the whole attribute as a template literal: `class="btn ${kind()}"` writes `btn primary`.
    const staticText = attrExprs.reduce((rest, e) => rest.replace(e.full, ''), attr.value);
    if (attrExprs.length > 1 || (attrExprs.length === 1 && staticText.trim() !== '')) {
      pushTemplateLiteralBinding('attr', name, attr.value, attr.valueStart, attrExprs);
      continue;
    }
    for (const expr of attrExprs) {
      pushExpressionBinding('attr', name, expr, attr.valueStart);
    }
  }
}
