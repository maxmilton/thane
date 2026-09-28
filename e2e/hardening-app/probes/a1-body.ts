import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';

// A component whose template starts with text and holds a list, bindings and an event,
// mounted into document.body after the nodes the page already has (Mode A, `&target=body`).
export const A1Body = defineComponent('hardening-a1-body', () => {
  const t = signal('t0');
  const items = signal(['a', 'b']);
  const clicks = signal(0);
  expose('a1body', { t, items, clicks });
  return {
    // prettier-ignore
    template: html`body ${t()}
    <div class="a1body" title=${t()}>
      <ul class="a1body-list">${repeat(items(), (it) => html`<li class="a1body-row">${it}</li>`)}</ul>
      <button class="a1body-btn" @click=${() => clicks(clicks() + 1)}>${clicks()}</button>
    </div>`,
  };
});
