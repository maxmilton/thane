import { defineComponent, signal, html, whenElse, repeat } from 'thane';
import { expose } from '../shared/expose.js';

// F1: fragments, html`` consts inlined wherever a template goes: a module fragment and a component
// fragment as whenElse() branches, one used twice with a signal and a child component in it, and one as
// a repeat() empty template.
const F1Kid = defineComponent<{ n: number }>(({ props }) => ({
  template: html`<em class="f1-kid-n">${props.n}</em>`,
}));

const busy = html`<span class="f1-busy">busy</span>`;

export const F1 = defineComponent('hardening-f1', () => {
  const loading = signal(true);
  const count = signal(1);
  const rows = signal<number[]>([]);
  const counter = html`<b class="f1-count">${count()}</b>${F1Kid({ n: 7 })}`;
  const done = html`<p class="f1-done">done</p>`;
  const empty = html`<li class="f1-empty">none</li>`;
  expose('f1', { loading, count, rows });
  return {
    template: html`<div class="f1">
      ${whenElse(loading(), busy, done)}
      <section class="f1-a">${counter}</section>
      <section class="f1-b">${counter}</section>
      <ul class="f1-rows">
        ${repeat(rows(), (r) => html`<li class="f1-row">${r}</li>`, empty)}
      </ul>
    </div>`,
  };
});
