import { defineComponent, signal, type Signal } from 'thane';
import { expose } from '../shared/expose.js';

type SigRow = { id: number; on: boolean; name: string };

// RW-2 (H-18): rows whose items are signals (the Signal<Signal<T>[]> pattern) with a when() on the item
// signal and a binding that reads it inside. The row's directives read the item variable itself, which
// the row factory declares (`const row = item;`).
export const RW2Sig = defineComponent('hardening-rw2-sig', () => {
  const rows = signal<Signal<SigRow>[]>([
    signal({ id: 1, on: true, name: 's1' }),
    signal({ id: 2, on: false, name: 's2' }),
  ]);
  const set = (i: number, patch: Partial<SigRow>) => {
    const s = rows()[i]!;
    s({ ...s(), ...patch });
  };
  expose('rw2sig', { set });
  return {
    // prettier-ignore
    template: html`<ul class="rw2-sig">${repeat(rows(), (row) => html`<li class="rw2-sig-row"><b ${when(row().on)}>${row().name}</b></li>`, null, (row) => row().id)}</ul>`,
  };
});
