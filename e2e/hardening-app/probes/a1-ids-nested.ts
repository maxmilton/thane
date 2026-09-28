import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';
import { IdsChild } from '../shared/a1-ids-child.js';

// A1-2: a lookup inside a when() that shows later must not find a same-id element of a child
// component that sits before it (the id lookup searched the whole component root, children included).
export const A1IdsNested = defineComponent('hardening-a1-ids-nested', () => {
  const t = signal('own');
  const show = signal(false);
  expose('a1idsNested', { t, show });
  return {
    template: html`<div class="a1ids-nested">
      ${IdsChild({})}
      <div ${when(show())}><p id="a1-shared" class="a1ids-own-p" title=${t()}>own</p></div>
    </div>`,
  };
});
