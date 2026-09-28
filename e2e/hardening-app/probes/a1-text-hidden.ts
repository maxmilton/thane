import { defineComponent, signal, html, whenElse } from 'thane';
import { expose } from '../shared/expose.js';

// M1: a text-only whenElse() branch that starts hidden. Showing it put the text "null" in
// place of its placeholder, and the binding went inert.
export const A1TextHidden = defineComponent('hardening-a1-text-hidden', () => {
  const on = signal(false);
  const n = signal(1);
  expose('a1texthidden', { on, n });
  return {
    // prettier-ignore
    template: html`<section class="a1th">${whenElse(on(), html`text-${n()}`, html`<u class="a1th-else">else</u>`)}</section>`,
  };
});
