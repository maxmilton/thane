import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';

type Row = { id: number; on: boolean; label: string };

// X1: attribute bindings inside a when() inside a repeat() row. Three rows, the second
// starts hidden; showing it must bind the second row's elements, not the first row's.
export const X1 = defineComponent('hardening-x1', () => {
  const rows = signal<Row[]>([
    { id: 1, on: true, label: 'one' },
    { id: 2, on: false, label: 'two' },
    { id: 3, on: true, label: 'three' },
  ]);
  const tag = signal('t0');
  const toggle = (id: number) => rows(rows().map((r) => (r.id === id ? { ...r, on: !r.on } : r)));
  expose('x1', { rows, tag, toggle });
  return {
    // prettier-ignore
    template: html`<div>
      <ul class="x1a-list">
        ${repeat(
          rows(),
          (r) => html`<li class="x1a-row"><b class="x1a" ${when(r.on)} title=${r.label}>A</b></li>`,
          null,
          (r) => r.id,
        )}
      </ul>
      <ul class="x1b-list">
        ${repeat(
          rows(),
          (r) => html`<li class="x1b-row"><div ${when(r.on)}><b class="x1b" title=${r.label}>B</b></div></li>`,
          null,
          (r) => r.id,
        )}
      </ul>
      <ul class="x1c-list">
        ${repeat(
          rows(),
          (r) => html`<li class="x1c-row"><div ${when(r.on)}><b class="x1c" data-tag=${tag()}>C</b></div></li>`,
          null,
          (r) => r.id,
        )}
      </ul>
      <ul class="x1d-list">
        ${repeat(
          rows(),
          (r) =>
            html`<li class="x1d-row">
              ${whenElse(r.on, html`<b class="x1d" title=${r.label}>D</b>`, html`<i class="x1d-off">off</i>`)}
            </li>`,
          null,
          (r) => r.id,
        )}
      </ul>
    </div>`,
  };
});
