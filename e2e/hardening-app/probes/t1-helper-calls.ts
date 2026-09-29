import { defineComponent, signal, html } from 'thane';
import { expose } from '../shared/expose.js';

// T1: calls to the component's own functions in a template. A zero-argument function is not a signal:
// `total()` follows the signals it reads, and `label()` renders once. A helper called with arguments
// follows its body's signals too.
export const T1 = defineComponent('hardening-t1', () => {
  const price = signal(2);
  const qty = signal(3);
  const currency = signal('EUR');
  const label = () => 'Total';
  const total = () => price() * qty();
  const format = (n: number) => `${n} ${currency()}`;
  expose('t1', { price, qty, currency });
  return {
    template: html`<p class="t1">
      <span class="t1-label">${label()}</span>
      <span class="t1-total" title=${total()}>${total()}</span>
      <span class="t1-formatted">${format(price())}</span>
    </p>`,
  };
});
