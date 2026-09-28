import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';

// A1-1: markup the browser's parser rebuilds. A table written without <tbody> (the parser inserts
// one), a <p> followed by a block element (the parser closes the <p> first, and the stray </p>
// becomes a second, empty <p>), an unclosed <li> (closed by the next one), and a <select> with a
// static <option> before a repeat().
export const A1Norm = defineComponent('hardening-a1-norm', () => {
  const t = signal('t1');
  const x = signal('x1');
  const opts = signal(['o1', 'o2']);
  const picks = signal(0);
  expose('a1norm', { t, x, opts, picks });
  return {
    // prettier-ignore
    template: html`<div class="a1norm">
      <table class="a1n-table"><tr class="a1n-tr" title=${t()}><td class="a1n-td">${x()}</td><td class="a1n-td2" title=${t()} @click=${() => picks(picks() + 1)}>c</td></tr></table>
      <div class="a1n-pwrap"><p class="a1n-p">intro<div class="a1n-div" title=${t()}>${x()}</div></p><span class="a1n-after" title=${t()}>${x()}</span></div>
      <ul class="a1n-list"><li class="a1n-li" title=${t()}>one<li class="a1n-li2" title=${t()}>${x()}</ul>
      <select class="a1n-select"><option value="">Choose</option>${repeat(opts(), (o) => html`<option class="a1n-opt" value=${o}>${o}</option>`)}</select>
      <b class="a1n-picks">${picks()}</b>
    </div>`,
  };
});
