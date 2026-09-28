import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';

// P14 (H-04): a hyphenated tag as a whenElse() branch root and as the element carrying when().
export const P14 = defineComponent('hardening-p14', () => {
  const flag = signal(false);
  const show = signal(false);
  expose('p14', { flag, show });
  return {
    template: html`<section class="p14">
      ${whenElse(flag(), html`<my-tag class="p14-we">A</my-tag>`, html`<b class="p14-we-else">B</b>`)}
      <my-tag class="p14-w" ${when(show())}>W</my-tag>
    </section>`,
  };
});
