/**
 * Typed query parameters: the parser helpers, and search values written into a path by href().
 * (route.search itself is covered with the router's lifecycle, router-lifecycle.test.ts.)
 */
import { describe, expect, test } from 'bun:test';
import { href } from './router.js';
import { searchFlag, searchNumber, searchOneOf, searchString } from './router-search.js';

describe('search parsers', () => {
  test('searchString: the value, or the fallback when the URL has none', () => {
    expect(searchString()('a b')).toBe('a b');
    expect(searchString()(undefined)).toBeUndefined();
    expect(searchString('all')(undefined)).toBe('all');
    expect(searchString('all')('')).toBe('');
  });

  test('searchNumber: a number, or the fallback when missing, empty or not a number', () => {
    expect(searchNumber(1)('3')).toBe(3);
    expect(searchNumber(1)('2.5')).toBe(2.5);
    expect(searchNumber(1)(undefined)).toBe(1);
    expect(searchNumber(1)('')).toBe(1);
    expect(searchNumber(1)('abc')).toBe(1);
    expect(searchNumber()('abc')).toBeUndefined();
  });

  test('searchFlag: true when present, false when missing, 0 or false', () => {
    expect(searchFlag()('')).toBe(true);
    expect(searchFlag()('1')).toBe(true);
    expect(searchFlag()(undefined)).toBe(false);
    expect(searchFlag()('0')).toBe(false);
    expect(searchFlag()('false')).toBe(false);
  });

  test('searchOneOf: a listed value, or the fallback', () => {
    const sort = searchOneOf(['price', 'name'], 'name');
    expect(sort('price')).toBe('price');
    expect(sort('other')).toBe('name');
    expect(sort(undefined)).toBe('name');
    expect(searchOneOf(['a'])('b')).toBeUndefined();
  });
});

describe('href with search values', () => {
  test('values that are not path parameters go into the query, encoded; a flag that is on is its bare name', () => {
    expect(href('/users/:id', { id: 7, tab: 'posts' })).toBe('/users/7?tab=posts');
    expect(href('/products', { page: 2, q: 'a&b', sale: true })).toBe('/products?page=2&q=a%26b&sale=');
    expect(href('/products', { sale: false, q: undefined as never })).toBe('/products');
  });
});

test('a search value whose name starts a parameter name is still a search value', () => {
  expect(href('/users/:identity', { identity: 'a', id: 2 })).toBe('/users/a?id=2');
});
