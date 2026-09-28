/**
 * ANSI color utilities with automatic TTY / NO_COLOR detection.
 *
 * Colours are disabled when:
 * - stdout is not a TTY (piped / CI logs)
 * - the `NO_COLOR` env var is set (https://no-color.org)
 * - the `FORCE_COLOR` env var is explicitly "0"
 *
 * Colours are force-enabled when:
 * - `FORCE_COLOR` is set to a truthy value ("1", "true", etc.)
 */

const _forceColor = process.env['FORCE_COLOR'];
const _noColor = process.env['NO_COLOR'];

/** Whether ANSI escape codes should be emitted */
export const supportsColor: boolean =
  _forceColor !== undefined
    ? _forceColor !== '0' && _forceColor !== 'false'
    : _noColor === undefined && (process.stdout?.isTTY ?? false);

const _wrap = (code: string): string => (supportsColor ? code : '');

export const ansi = {
  green: _wrap('\x1b[32m'),
  yellow: _wrap('\x1b[33m'),
  blue: _wrap('\x1b[94m'),
  cyan: _wrap('\x1b[36m'),
  red: _wrap('\x1b[31m'),
  magenta: _wrap('\x1b[35m'),
  orange: _wrap('\x1b[38;5;208m'),
  gray: _wrap('\x1b[90m'),
  dim: _wrap('\x1b[2m'),
  reset: _wrap('\x1b[0m'),
} as const;

export const consoleColors = {
  green: `${ansi.green}%s${ansi.reset}`,
  yellow: `${ansi.yellow}%s${ansi.reset}`,
  blue: `${ansi.blue}%s${ansi.reset}`,
  cyan: `${ansi.cyan}%s${ansi.reset}`,
  red: `${ansi.red}%s${ansi.reset}`,
  orange: `${ansi.orange}%s${ansi.reset}`,
} as const;
