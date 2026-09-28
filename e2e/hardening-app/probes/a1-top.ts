import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';

// Directives at the top level of the template: a when() element and a whenElse() that are
// direct children of the component root, next to a static element.
export const A1Top = defineComponent('hardening-a1-top', () => {
  const t = signal('t0');
  const a = signal(true);
  const b = signal(false);
  expose('a1top', { t, a, b });
  return {
    // prettier-ignore
    template: html`<b class="a1top-w" ${when(a())} title=${t()}>${t()}</b>${whenElse(b(), html`<i class="a1top-then" title=${t()}>${t()}</i>`, html`<u class="a1top-else" title=${t()}>${t()}</u>`)}<span class="a1top-static">S</span>`,
  };
});
