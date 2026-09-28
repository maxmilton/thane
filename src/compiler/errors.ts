/**
 * Error handling utilities for the Thane compiler
 */

import type { Diagnostic, DiagnosticSeverity, SourceLocation } from './types.js';

/**
 * Error codes for different compiler issues
 */
export enum ErrorCode {
  // Parse errors
  PREFIXED_ATTRIBUTE = 'THANE006',
  REPEAT_ROW_ROOT = 'THANE007',
  ROW_ROOT_WHEN = 'THANE008',
  TEMPLATE_STRUCTURE = 'THANE009',

  // Build errors
  FILE_NOT_FOUND = 'THANE200',
  PLUGIN_ERROR = 'THANE202',

  // Lint rules
  NO_DEFAULT_EXPORT_COMPONENT = 'THANE400',
  COMPONENT_PROPERTY_ORDER = 'THANE401',
  LIFECYCLE_ARROW_FUNCTION = 'THANE402',
  REQUIRE_CONST_TAGGED_TEMPLATES = 'THANE403',
  NO_NESTED_HTML_TAGS = 'THANE404',
  NO_CONDITIONAL_TEMPLATE_INIT = 'THANE405',
  // THANE406 (no-element-id) is retired (A1-5) and not reused
  SINGLE_COMPONENT_PER_FILE = 'THANE407',
  COMPONENT_CONST_DECLARATION = 'THANE408',
  NO_ALIASED_COMPONENT_EXPORT = 'THANE409',
  NO_CROSS_FILE_HTML_TEMPLATE = 'THANE410',
  DUPLICATE_MOUNT_TARGET = 'THANE411',
  SINGLE_RETURN_OBJECT = 'THANE412',
}

/**
 * Create a diagnostic message
 */
export function createDiagnostic(
  severity: DiagnosticSeverity,
  message: string,
  location?: SourceLocation,
  code?: string,
): Diagnostic {
  return {
    severity,
    message,
    location,
    code,
  };
}

/**
 * Create an error diagnostic
 */
export function createError(message: string, location?: SourceLocation, code?: string): Diagnostic {
  return createDiagnostic('error', message, location, code);
}

/**
 * Create a warning diagnostic
 */
export function createWarning(message: string, location?: SourceLocation, code?: string): Diagnostic {
  return createDiagnostic('warning', message, location, code);
}

/**
 * Format a diagnostic for display
 */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const { severity, message, location, code } = diagnostic;

  let result = '';

  const prefix = severity === 'error' ? 'error' : severity === 'warning' ? 'warning' : 'info';
  result += `[${prefix}]`;

  if (code) {
    result += ` ${code}:`;
  }

  if (location) {
    result += ` ${location.file}:${location.line}:${location.column}`;
  }

  result += `\n  ${message}`;

  return result;
}

/**
 * Check if diagnostics contain any errors
 */
export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}
