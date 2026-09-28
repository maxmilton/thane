import { defineComponent, signal, html, repeat } from 'thane';
import { expose } from '../shared/expose.js';
import { ProbeCard } from '../shared/probe-card.js';

// Child hosts in the template where the parser keeps an element there (a paragraph, a row that
// is only the child), and comment anchors that the host replaces where it would not (a table row,
// svg).
export const A1Hosts = defineComponent('hardening-a1-hosts', () => {
  const rows = signal([
    { id: 1, g: 'g1' },
    { id: 2, g: 'g2' },
  ]);
  expose('a1hosts', { rows });
  return {
    // prettier-ignore
    template: html`<div class="a1h"><p class="a1h-p">${ProbeCard({ label: 'p' })}</p><table><tbody class="a1h-tbody">${repeat(rows(), (r) => html`<tr><td>${r.g}</td>${ProbeCard({ label: `tr-${r.g}` })}</tr>`, null, (r) => r.id)}</tbody></table><div class="a1h-list">${repeat(rows(), (r) => html`${ProbeCard({ label: `row-${r.g}` })}`, null, (r) => r.id)}</div><svg class="a1h-svg">${ProbeCard({ label: 'svg' })}</svg></div>`,
  };
});
