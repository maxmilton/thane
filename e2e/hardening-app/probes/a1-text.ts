import { defineComponent, signal, html } from 'thane';
import { expose } from '../shared/expose.js';

// Text bindings at the start, middle and end of mixed text, two in a row, next to developer
// comments, inside <pre>, as sole content, and at the top level of the template.
export const A1Text = defineComponent('hardening-a1-text', () => {
  const a = signal('A');
  const b = signal('B');
  expose('a1text', { a, b });
  return {
    // prettier-ignore
    template: html`top ${a()} level
    <div class="a1text">
      <p class="a1t-start">${a()} tail</p>
      <p class="a1t-mid">head ${a()} tail</p>
      <p class="a1t-end">head ${a()}</p>
      <p class="a1t-two">${a()}${b()}</p>
      <p class="a1t-expr">${a() + '-' + b()}!</p>
      <p class="a1t-cmt"><!-- note -->${a()}<!-- other --> x ${b()}</p>
      <pre class="a1t-pre">line1
  ${a()} line2
${b()}</pre>
      <span class="a1t-sole">${b()}</span>
    </div>
    ${b()} end`,
  };
});
