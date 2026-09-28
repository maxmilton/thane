import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';
import { ProbeCard } from '../shared/probe-card.js';

// P5: a child component inside a whenElse() that is nested in a when().
export const P5 = defineComponent('hardening-p5', () => {
  const show = signal(true);
  const flag = signal(true);
  expose('p5', { show, flag });
  return {
    template: html`<section>
      <div class="p5-when" ${when(show())}>
        ${whenElse(flag(), html`<p class="p5-then">${ProbeCard({ label: 'p5-card' })}</p>`, html`<p class="p5-else">no</p>`)}
      </div>
    </section>`,
  };
});
