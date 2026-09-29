import { defineComponent, signal, html, whenElse, repeat } from 'thane';
import { expose } from '../shared/expose.js';
import { F2Static, F2Badge, F2Tags, f2Tone, f2Tags } from '../shared/fragments.js';

// F2: fragments another module exports. The static one is written out in place; the ones with bindings
// are mounted at the top level, in a whenElse() branch and in rows, and follow their module's signals.
export const F2 = defineComponent('hardening-f2', () => {
  const open = signal(true);
  const rows = signal([1, 2]);
  expose('f2', { open, rows, tone: f2Tone, tags: f2Tags });
  return {
    template: html`<div class="f2">
      <p class="f2-top">${F2Static}${F2Badge}</p>
      <div class="f2-branch">${whenElse(open(), F2Tags, html``)}</div>
      <ol class="f2-rows">
        ${repeat(
          rows(),
          (row) => html`<li class="f2-row">${row}${F2Badge}</li>`,
          null,
          (row) => row,
        )}
      </ol>
    </div>`,
  };
});
