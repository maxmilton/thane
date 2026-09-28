import { defineComponent, html, css } from 'thane';

// P26c: a quote inside a CSS comment (dev build). Every rule stays scoped to the component,
// so the rule for .p26c-leak must not reach the element with that class outside the component.
export const P26c = defineComponent('hardening-p26c', () => ({
  template: html`<div><p class="p26c-a">p26c</p><p class="p26c-leak">inside</p></div>`,
  styles: css`
    .p26c-a {
      /* it's a comment */
      color: rgb(0, 0, 255);
    }
    .p26c-leak {
      color: rgb(1, 2, 3);
    }
  `,
}));
