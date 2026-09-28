import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';
import { ProbeCard } from '../shared/probe-card.js';

// P6: a repeat() whose row is a child component, inside a when() that starts hidden.
export const P6 = defineComponent('hardening-p6', () => {
  const show = signal(false);
  const items = signal(['x', 'y']);
  expose('p6', { show });
  return {
    template: html`<section>
      <div class="p6-when" ${when(show())}>
        <ul>
          ${repeat(items(), (i) => ProbeCard({ label: i }))}
        </ul>
      </div>
    </section>`,
  };
});
