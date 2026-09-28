/**
 * The template markers: the `html` and `css` template tags and the `when()`, `whenElse()` and `repeat()`
 * directives. The compiler turns each of them into DOM code, so none of them runs in a built app; they
 * are imported so that editors, tests and the type checker know them as real symbols. Nothing is
 * bundled for them: a component's use of them is compiled away, and the import then goes unused.
 *
 * Called at run time, which only happens outside a compiled component template (in a file the
 * compiler does not compile, or under another name than the marker's own), they throw.
 */

const compiledAway = (marker: string): never => {
  throw new Error(
    `[thane] ${marker} runs only inside a component's template, which the compiler turns into DOM code. ` +
      'Use it in the template a defineComponent() setup returns, under its own name.',
  );
};

/** An HTML template: a component's markup, or a row's or a branch's. */
export function html(_strings: TemplateStringsArray, ..._values: any[]): any {
  return compiledAway('html``');
}

/** A CSS template: a component's scoped styles. */
export function css(_strings: TemplateStringsArray, ..._values: any[]): any {
  return compiledAway('css``');
}

/** Shows the element it is written on while `condition` is true: `<p ${when(open())}>…</p>`. */
export function when(_condition: boolean | (() => boolean)): string {
  return compiledAway('when()');
}

/** Shows `thenTemplate` while `condition` is true, `elseTemplate` otherwise. */
export function whenElse<T, F>(_condition: boolean | (() => boolean), _thenTemplate: T, _elseTemplate: F): T | F {
  return compiledAway('whenElse()');
}

/**
 * A keyed list: one row per item.
 * @param emptyTemplate shown while the list is empty: an html template, or null; the key function goes fourth
 */
export function repeat<T>(
  _items: T[] | (() => T[]),
  _templateFn: (item: T, index: number) => any,
  _emptyTemplate?: string | null,
  _trackBy?: (item: T, index: number) => string | number,
): any[] {
  return compiledAway('repeat()');
}
