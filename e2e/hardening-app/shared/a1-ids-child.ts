import { defineComponent } from 'thane';

/** A1-1: a child component whose element carries the same developer id as one in its parent. */
export const IdsChild = defineComponent('hardening-a1-ids-child', () => ({
  template: html`<p id="a1-shared" class="a1ids-child-p" title="child">child</p>`,
}));
