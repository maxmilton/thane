import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';

// M1 (A1-3): whenElse() branches with more than one root node. The first section's then-branch has
// two root elements; the second section's then-branch is text only.
export const M1 = defineComponent('hardening-m1', () => {
  const two = signal(true);
  const text = signal(true);
  const n = signal(1);
  expose('m1', { two, text, n });
  return {
    // prettier-ignore
    template: html`<div>
      <section class="m1-two">${whenElse(two(), html`<b class="m1-a">A</b><i class="m1-b">${n()}</i>`, html`<u class="m1-e">E</u>`)}</section>
      <section class="m1-text">${whenElse(text(), html`text-${n()}`, html`<u class="m1-text-else">else</u>`)}</section>
    </div>`,
  };
});
