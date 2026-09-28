import { defineComponent, signal, html, repeat } from 'thane';
import { expose } from '../shared/expose.js';

// A repeat() whose container is the component root (the rows sit directly in the host).
export const A1RootList = defineComponent('hardening-a1-rootlist', () => {
  const items = signal(['r1', 'r2']);
  expose('a1rootlist', { items });
  return {
    template: html`${repeat(items(), (it) => html`<p class="a1r-row">${it}</p>`)}`,
  };
});
