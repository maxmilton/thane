/**
 * Typed query parameters: a route's `search` schema names each parameter with its parser, and a page reads
 * the parsed values on `route.search`.
 *
 * ```ts
 * '/products': {
 *   component: () => import('./pages/products.js'),
 *   search: { page: searchNumber(1), q: searchString(''), sale: searchFlag(), sort: searchOneOf(['price', 'name'], 'name') },
 * },
 * // in the page: route.search.page is a number, route.search.sort 'price' | 'name'
 * ```
 *
 * A parser gets the parameter's raw value, or `undefined` when the URL has none. Any function of that shape
 * is a parser too; the generated route types then take its value's type from its return type annotation.
 */

/** A query parameter's parser: the raw value (undefined when the URL has none) to the value a page reads */
export type SearchParser<T = unknown> = (raw: string | undefined) => T;

/** A route's query parameters, each with its parser */
export type SearchSchema = Record<string, SearchParser>;

/** A string parameter: its value, or `fallback` when the URL has none */
export function searchString(): SearchParser<string | undefined>;
export function searchString(fallback: string): SearchParser<string>;
export function searchString(fallback?: string): SearchParser<string | undefined> {
  return (raw) => raw ?? fallback;
}

/** A number parameter: its value, or `fallback` when the URL has none or it is not a number */
export function searchNumber(): SearchParser<number | undefined>;
export function searchNumber(fallback: number): SearchParser<number>;
export function searchNumber(fallback?: number): SearchParser<number | undefined> {
  return (raw) => {
    const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
    return Number.isNaN(value) ? fallback : value;
  };
}

/** A flag: true when the parameter is there (`?sale`, `?sale=1`), false when it is missing, `0` or `false` */
export const searchFlag = (): SearchParser<boolean> => (raw) => raw !== undefined && raw !== '0' && raw !== 'false';

/** One of a list of values: the value when it is in the list, `fallback` otherwise */
export function searchOneOf<const V extends readonly string[]>(values: V): SearchParser<V[number] | undefined>;
export function searchOneOf<const V extends readonly string[]>(values: V, fallback: V[number]): SearchParser<V[number]>;
export function searchOneOf(values: readonly string[], fallback?: string): SearchParser<string | undefined> {
  return (raw) => (raw !== undefined && values.includes(raw) ? raw : fallback);
}
