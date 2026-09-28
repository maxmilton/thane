/**
 * HTML Parser — Public API
 *
 * Re-exports all types and functions from the split parser modules.
 * Import from this file (or the parent utils/index) for the public API.
 */

// Types
export type {
  ParserState,
  AttributeInfo,
  TextNode,
  HtmlElement,
  BindingInfo,
  ParseDiagnostic,
  ParsedTemplate,
} from './types.js';

export { VOID_ELEMENTS } from './types.js';

// Parser core
export { parseHtmlTemplate } from './parser-core.js';

// Binding detection
export type { BindingDetectionOptions } from './binding-detection.js';
export {
  parseWhenElseExpression,
  parseRepeatExpression,
  findBindingsInText,
  findBindingsInAttributes,
  findTemplateExpressions,
  stripTemplateExpressions,
} from './binding-detection.js';

// Utilities
export {
  walkElements,
  findElements,
  findElementsWithWhenDirective,
  getElementHtml,
  isInsideSvg,
  attributeDomProperty,
  injectIdIntoFirstElement,
  firstElementId,
  escapeTemplateLiteral,
  escapeRawTemplateLiteral,
} from './html-utils.js';
