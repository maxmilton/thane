import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';
import { ProbeCard } from '../shared/probe-card.js';

// K13 (H-44): a row that is a component call with a template literal in its props.
export const K13 = defineComponent('hardening-k13', () => {
  const rows = signal([
    { id: 1, label: 'a' },
    { id: 2, label: 'b' },
  ]);
  expose('k13', { rows });
  return {
    template: html`<div class="k13">
      ${repeat(
        rows(),
        (item) => ProbeCard({ label: `x-${item.label}` }),
        null,
        (item) => item.id,
      )}
    </div>`,
  };
});
