import { defineComponent, signal } from 'thane';
import { ProbeCard } from '../shared/probe-card.js';

// P7: a child component inside a when() inside a repeat() row.
export const P7 = defineComponent('hardening-p7', () => {
  const rows = signal([{ id: 1 }]);
  const show = signal(true);
  return {
    // prettier-ignore
    template: html`<ul>
      ${repeat(
        rows(),
        (r) => html`<li class="p7-row" data-row=${r.id}><div ${when(show())}>${ProbeCard({ label: 'p7-card' })}</div></li>`,
        null,
        (r) => r.id,
      )}
    </ul>`,
  };
});
