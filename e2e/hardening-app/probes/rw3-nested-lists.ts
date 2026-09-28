import { defineComponent, signal, html, when, whenElse, repeat } from 'thane';
import { expose } from '../shared/expose.js';
import { CountingKid } from '../shared/counting-kid.js';
import { ProbeCard } from '../shared/probe-card.js';

type Leaf = { id: number; n: string };
type Mid = { id: number; name: string; on: boolean; leaves: Leaf[] };
type Top = { id: number; title: string; mids: Mid[] };

/** The probe's starting data; the spec sends changed copies through `window.__probe.rw3.tops`. */
export const RW3_TOPS: Top[] = [
  {
    id: 1,
    title: 'A',
    mids: [
      {
        id: 11,
        name: 'a1',
        on: true,
        leaves: [
          { id: 111, n: 'x' },
          { id: 112, n: 'y' },
        ],
      },
      { id: 12, name: 'a2', on: false, leaves: [] },
    ],
  },
  { id: 2, title: 'B', mids: [{ id: 21, name: 'b1', on: true, leaves: [{ id: 211, n: 'z' }] }] },
  { id: 3, title: 'C', mids: [] },
];

// A list inside a row is generated like any other list, at any depth.
// - three: three lists, each row reading the rows above it, a handler on each level's row, a .stop one
//   on the innermost;
// - idx: index bindings in inner rows, then a reorder;
// - kids: child components in inner rows, their props reading the outer row;
// - empty: an inner list's empty template;
// - rrw: a when() and a whenElse() in inner rows (P3's shape);
// - mixed: repeat › whenElse › repeat › when / whenElse;
// - shadow: an inner list whose item has the outer item's name;
// - after: a handler of the outer row on a static element after an inner list, in the list's container;
// - oitem: a child in an inner row whose props read an outer item named `item`;
// - sigitem: rows whose items are signals and whose parameter is named `item`, read as `item()` in inner rows.
type SigRow = { id: number; name: string; tags: string[] };

export const RW3 = defineComponent('hardening-rw3', () => {
  const tops = signal<Top[]>(RW3_TOPS);
  const show = signal(true);
  const log = signal<string[]>([]);
  const sigRows = signal([
    signal<SigRow>({ id: 1, name: 'A', tags: ['x', 'y'] }),
    signal<SigRow>({ id: 2, name: 'B', tags: ['z'] }),
  ]);
  const bump = (what: string) => log([...log(), what]);
  expose('rw3', { tops, show, log, sigRows });
  return {
    // prettier-ignore
    template: html`<div class="rw3">
      <ul class="rw3-three">${repeat(tops(), (t) => html`<li class="rw3-top" @click=${() => bump('top' + t.id)}><b class="rw3-top-title">${t.title}</b><ol>${repeat(t.mids, (m) => html`<li class="rw3-mid" @click=${() => bump('mid' + m.id)}><i class="rw3-mid-name">${t.title}/${m.name}</i><ul>${repeat(m.leaves, (l) => html`<li class="rw3-leaf"><button class="rw3-leaf-btn" @click=${() => bump('leaf' + l.id)}>${t.title}/${m.name}/${l.n}</button><button class="rw3-leaf-stop" @click.stop=${() => bump('stop' + l.id)}>s</button></li>`, null, (l) => l.id)}</ul></li>`, null, (m) => m.id)}</ol></li>`, null, (t) => t.id)}</ul>
      <ul class="rw3-idx">${repeat(tops(), (t) => html`<li><ol>${repeat(t.mids, (m, j) => html`<li class="rw3-idx-row">${j}:${m.name}</li>`, null, (m) => m.id)}</ol></li>`, null, (t) => t.id)}</ul>
      <ul class="rw3-kids">${repeat(tops(), (t) => html`<li><ol>${repeat(t.mids, (m) => html`<li class="rw3-kid-row">${CountingKid({ label: t.title + '/' + m.name })}</li>`, null, (m) => m.id)}</ol></li>`, null, (t) => t.id)}</ul>
      <ul class="rw3-empty">${repeat(tops(), (t) => html`<li><ol>${repeat(t.mids, (m) => html`<li class="rw3-e-row">${m.name}</li>`, html`<li class="rw3-e-none">none</li>`, (m) => m.id)}</ol></li>`, null, (t) => t.id)}</ul>
      <ul class="rw3-rrw">${repeat(tops(), (t) => html`<li><ol>${repeat(t.mids, (m) => html`<li class="rw3-rrw-row"><b class="rw3-rrw-on" ${when(m.on)}>${m.name}</b>${whenElse(m.on, html`<i class="rw3-rrw-t">${t.title}</i>`, html`<i class="rw3-rrw-f">off</i>`)}</li>`, null, (m) => m.id)}</ol></li>`, null, (t) => t.id)}</ul>
      <ul class="rw3-mixed">${repeat(tops(), (t) => html`<li>${whenElse(show(), html`<ol>${repeat(t.mids, (m) => html`<li class="rw3-mx-row"><span class="rw3-mx-on" ${when(m.on)}>${t.title}:${m.name}</span>${whenElse(m.on, html`<i class="rw3-mx-t">on</i>`, html`<i class="rw3-mx-f">off</i>`)}</li>`, null, (m) => m.id)}</ol>`, html`<p class="rw3-mx-hidden">hidden</p>`)}</li>`, null, (t) => t.id)}</ul>
      <ul class="rw3-shadow">${repeat(tops(), (t) => html`<li><ol>${repeat(t.mids, (t) => html`<li class="rw3-sh-row">${t.name}</li>`, null, (t) => t.id)}</ol></li>`, null, (t) => t.id)}</ul>
      <ul class="rw3-after">${repeat(tops(), (t) => html`<li><ol>${repeat(t.mids, (m) => html`<li class="rw3-af-row">${m.name}</li>`, null, (m) => m.id)}<li class="rw3-af-btn" @click=${() => bump('after' + t.id)}>after</li></ol></li>`, null, (t) => t.id)}</ul>
      <ul class="rw3-oitem">${repeat(tops(), (item) => html`<li><ol>${repeat(item.mids, (m) => html`<li class="rw3-oi-row">${ProbeCard({ label: item.title + ':' + m.name })}</li>`, null, (m) => m.id)}</ol></li>`, null, (item) => item.id)}</ul>
      <ul class="rw3-sigitem">${repeat(sigRows(), (item) => html`<li><ol>${repeat(item().tags, (tag) => html`<li class="rw3-si-row">${item().name}/${tag}</li>`)}</ol></li>`)}</ul>
    </div>`,
  };
});
