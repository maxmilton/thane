import { defineComponent } from 'thane';

// P26a: :host() with a compound argument that contains its own parentheses.
// Correct scoping: the rule applies only while the host has .y and does not have .x.
export const P26a = defineComponent('hardening-p26a', () => ({
  template: html`<p class="p26a-a">p26a</p>`,
  styles: css`
    :host(:not(.x).y) .p26a-a {
      color: rgb(0, 128, 0);
    }
  `,
}));
