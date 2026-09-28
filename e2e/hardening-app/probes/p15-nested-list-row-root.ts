import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';

// P15 (H-06): a nested repeat() whose container is the outer row's root element; the inner list is
// driven by a component signal and goes from empty to non-empty for one row.
export const P15 = defineComponent('hardening-p15', () => {
  const outer = signal([{ id: 'A' }, { id: 'B' }]);
  const inner = signal<string[]>([]);
  expose('p15', { inner });
  return {
    template: html`<div class="p15">
      ${repeat(
        outer(),
        (o) =>
          html`<ul class="p15-row" data-id=${o.id}>
            ${repeat(
              inner().filter((x) => x.startsWith(o.id)),
              (x) => html`<li class="p15-inner">${x}</li>`,
            )}
          </ul>`,
        null,
        (o) => o.id,
      )}
    </div>`,
  };
});
