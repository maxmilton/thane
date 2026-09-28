import { defineComponent, signal } from 'thane';
import { Kid } from '../shared/kid.js';
import { l1Tick } from '../shared/store.js';

// L1: component-level rows subscribe to a store signal and mount a child component;
// destroying the component must release both.
export const L1 = defineComponent('hardening-l1', () => {
  const items = signal([
    { id: 1, n: 'a' },
    { id: 2, n: 'b' },
  ]);
  return {
    template: html`<ul>
      ${repeat(
        items(),
        (it) => html`<li class="l1-row"><span class="l1-m">${it.n}-${l1Tick()}</span>${Kid({ label: it.n })}</li>`,
        null,
        (it) => it.id,
      )}
    </ul>`,
  };
});
