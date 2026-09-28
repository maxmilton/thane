import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';

// P20 (H-18, RW-6 + RW-2): a repeat() inside a when() inside a repeat() row.
export const P20 = defineComponent('hardening-p20', () => {
  const rows = signal([{ id: 1, tags: ['t1', 't2'] }]);
  const show = signal(true);
  expose('p20', { show });
  return {
    template: html`<ul>
      ${repeat(
        rows(),
        (r) =>
          html`<li>
            <div class="p20-wrap" ${when(show())}>
              <ol>
                ${repeat(r.tags, (t) => html`<li class="p20-tag">${t}</li>`)}
              </ol>
            </div>
          </li>`,
        null,
        (r) => r.id,
      )}
    </ul>`,
  };
});
