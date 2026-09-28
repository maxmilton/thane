/**
 * HTML Parser — Public API
 *
 * Re-exports all types and functions from the split parser modules.
 * Import from this file (or the parent utils/index) for the public API.
 */

// Types
export type { HtmlElement, BindingInfo, ParsedTemplate } from './types.js';

// Parser core
export { parseHtmlTemplate } from './parser-core.js';

// Binding detection
export type { BindingDetectionOptions } from './binding-detection.js';
export {
  findTemplateExpressions,
  extractSignalsFromExpression,
  stripTemplateExpressions,
} from './binding-detection.js';

// Utilities
export {
  walkElements,
  findElementsWithWhenDirective,
  getElementHtml,
  attributeDomProperty,
  escapeTemplateLiteral,
  escapeRawTemplateLiteral,
} from './html-utils.js';
