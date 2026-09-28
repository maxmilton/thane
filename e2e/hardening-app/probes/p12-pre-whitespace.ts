import { defineComponent } from 'thane';

// P12 (H-03): whitespace inside <pre> in a component template.
export const P12 = defineComponent('hardening-p12', () => ({
  // prettier-ignore
  template: html`<pre class="p12-pre">line1
    line2</pre>`,
}));
