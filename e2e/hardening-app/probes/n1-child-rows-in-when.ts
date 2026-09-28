import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';
import { Kid } from '../shared/kid.js';

// N1: a child component in the rows of a repeat() inside a when(). On e4a17f1 the
// child's mount is emitted at component level (`_gid("b0").replaceWith(...)`, with the row item out of
// scope), so the component fails to mount.
export const N1 = defineComponent('hardening-n1', () => {
  const items = signal([
    { id: 1, n: 'a' },
    { id: 2, n: 'b' },
  ]);
  const show = signal(true);
  expose('n1', { show });
  return {
    template: html`<section>
      <div class="n1-when" ${when(show())}>
        <ul>
          ${repeat(
            items(),
            (it) => html`<li class="n1-row">${Kid({ label: it.n })}</li>`,
            null,
            (it) => it.id,
          )}
        </ul>
      </div>
    </section>`,
  };
});
