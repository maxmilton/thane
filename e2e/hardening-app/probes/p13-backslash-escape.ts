import { defineComponent } from 'thane';

// P13: a backslash and an escaped \${ in template text. The template's value is the text
// `C:\dir` and the literal characters `${notExpr}`; neither is an interpolation.
export const P13 = defineComponent('hardening-p13', () => ({
  // prettier-ignore
  template: html`<div><p class="p13-bs">C:\\dir</p><p class="p13-dollar">\${notExpr}</p></div>`,
}));
