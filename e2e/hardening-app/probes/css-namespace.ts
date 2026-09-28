import { defineComponent } from 'thane';

// `@namespace` in a component stylesheet: the rule right after the statement stays scoped to the
// component (the runtime scoper used to read the statement as that rule's selector, and left it
// unscoped), and the namespace applies to the component's svg.
export const CssNamespace = defineComponent('hardening-css-namespace', () => ({
  template: html`<div>
    <svg class="ns-svg" width="10" height="10"><rect class="ns-rect" width="10" height="10"></rect></svg>
    <p class="ns-leak">inside</p>
  </div>`,
  styles: css`
    @namespace svg url(http://www.w3.org/2000/svg);
    .ns-leak {
      color: rgb(1, 2, 3);
    }
    svg|rect {
      fill: rgb(255, 0, 0);
    }
  `,
}));
