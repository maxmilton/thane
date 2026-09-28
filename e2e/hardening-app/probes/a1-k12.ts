import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';
import { ProbeCard } from '../shared/probe-card.js';

// In a row, a when() whose initial value is unknown at compile time, followed by a
// child component. The child mounted in place of the when() anchor. The second list has a nested
// list before the child, whose anchor the child's could be mistaken for the same way.
export const A1K12 = defineComponent('hardening-a1-k12', () => {
  const rows = signal([
    { id: 1, g: 'g1', tags: ['t1', 't2'] },
    { id: 2, g: 'g2', tags: ['t3'] },
  ]);
  const on = signal(Math.random() > 2);
  const lbl = signal('L');
  expose('a1k12', { rows, on, lbl });
  return {
    // prettier-ignore
    template: html`<div><ul class="a1k12">${repeat(rows(), (r) => html`<li class="a1k12-row"><b class="a1k12-b" ${when(on())}>${lbl()}</b>${ProbeCard({ label: r.g })}</li>`, null, (r) => r.id)}</ul><ul class="a1k12n">${repeat(rows(), (r) => html`<li class="a1k12n-row">${repeat(r.tags, (t) => html`<i>${t}</i>`)}${ProbeCard({ label: r.g })}</li>`, null, (r) => r.id)}</ul></div>`,
  };
});
