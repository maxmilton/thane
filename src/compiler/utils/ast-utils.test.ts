import { describe, expect, test } from 'bun:test';
import { replaceReferences } from './ast-utils.js';

describe('replaceReferences', () => {
  test('preserves explicit object property keys while renaming values', () => {
    expect(replaceReferences('{ product: product, nested: product.id }', 'product', 'item')).toBe(
      '{ product: item, nested: item.id }',
    );
  });

  test('expands shorthand properties to preserve original key name', () => {
    expect(replaceReferences('{ product, count: product.count }', 'product', 'item')).toBe(
      '{ product: item, count: item.count }',
    );
  });

  test('supports expression replacements (not only identifiers)', () => {
    expect(replaceReferences('{ product }', 'product', 'product$()')).toBe('{ product: product$() }');
    expect(replaceReferences('select(product)', 'product', 'product$()')).toBe('select(product$())');
  });

  test('does not rename property-access names', () => {
    expect(replaceReferences('obj.product + product', 'product', 'item')).toBe('obj.product + item');
  });

  test('keeps the text of everything else: a tagged template stays html`…`', () => {
    expect(replaceReferences('show(row, html`<b>${row.name}</b>`)', 'row', 'item')).toBe(
      'show(item, html`<b>${item.name}</b>`)',
    );
    expect(replaceReferences("row.a  +  'row' // row", 'row', 'item')).toBe("item.a  +  'row' // row");
  });

  test('a function that declares the name shadows it', () => {
    expect(replaceReferences('rows.map((row) => row.id).concat(row)', 'row', 'item')).toBe(
      'rows.map((row) => row.id).concat(item)',
    );
    expect(replaceReferences('rows.find(({ row }) => row).x + row', 'row', 'item')).toBe(
      'rows.find(({ row }) => row).x + item',
    );
  });
});
