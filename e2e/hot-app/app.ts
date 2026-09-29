import { defineComponent, html } from 'thane';
import { clicks } from './store.js';
import { HotLabel } from './label.js';

export const HotApp = defineComponent('hot-app', () => ({
  template: html`<main>
    <button class="hot-click" @click=${() => clicks(clicks() + 1)}>click</button>
    <span class="hot-clicks">${clicks()}</span>
    ${HotLabel({ n: 1 })}
  </main>`,
}));
