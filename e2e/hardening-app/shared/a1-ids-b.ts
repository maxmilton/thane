import { defineComponent, signal } from 'thane';
import { expose } from './expose.js';

/** A second component that uses the same developer ids as IdsA. */
export const IdsB = defineComponent('hardening-a1-ids-b', () => {
  const t = signal('b');
  expose('a1idsB', { t });
  return {
    template: html`<div class="a1ids-b">
      <p id="a1-attr" class="a1ids-b-attr" title=${t()}>P</p>
      <span id="a1-inner" class="a1ids-b-inner" title=${t()}>I</span>
    </div>`,
  };
});
