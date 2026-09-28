import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';
import { l2Tick } from '../shared/store.js';

// L2 (H-28): a list whose rows subscribe to a store signal, inside a when(). Hiding the when() must
// release the rows' subscriptions, and showing it again must not add a second set. (A child component
// in these rows is N1: on e4a17f1 it breaks the mount, so it is probed there instead.)
export const L2 = defineComponent('hardening-l2', () => {
  const items = signal([
    { id: 1, n: 'a' },
    { id: 2, n: 'b' },
  ]);
  const show = signal(true);
  expose('l2', { show });
  return {
    template: html`<section>
      <div class="l2-when" ${when(show())}>
        <ul>
          ${repeat(
            items(),
            (it) => html`<li class="l2-row"><span class="l2-m">${it.n}-${l2Tick()}</span></li>`,
            null,
            (it) => it.id,
          )}
        </ul>
      </div>
    </section>`,
  };
});
