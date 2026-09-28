import { defineComponent, signal, html } from 'thane';
import { expose } from '../shared/expose.js';

// An event on an element with an empty id attribute. The id lookup ran
// querySelector('#'), which throws.
export const A1K14 = defineComponent('hardening-a1-k14', () => {
  const clicks = signal(0);
  expose('a1k14', { clicks });
  return {
    // prettier-ignore
    template: html`<div class="a1k14"><button id="" class="a1k14-btn" @click=${() => clicks(clicks() + 1)}>${clicks()}</button></div>`,
  };
});
