import { defineComponent } from 'thane';
import { IdsA } from '../shared/a1-ids-a.js';
import { IdsB } from '../shared/a1-ids-b.js';

// Two instances of one component and a second component, all using the same developer ids.
export const A1Ids = defineComponent('hardening-a1-ids', () => ({
  template: html`<div class="a1ids-page">
    <div class="a1ids-one">${IdsA({ n: 1 })}</div>
    <div class="a1ids-two">${IdsA({ n: 2 })}</div>
    <div class="a1ids-three">${IdsB({})}</div>
  </div>`,
}));
