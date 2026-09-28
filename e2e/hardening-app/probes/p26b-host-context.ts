import { defineComponent, html, css } from 'thane';

// P26b: :host-context() applies while an ancestor of the component matches its argument.
export const P26b = defineComponent('hardening-p26b', () => ({
  template: html`<p class="p26b-a">p26b</p>`,
  styles: css`
    :host-context(.p26b-dark) .p26b-a {
      color: rgb(255, 0, 0);
    }
  `,
}));
