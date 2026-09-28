import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';

type Row = { id: number; label: string };

// N2: a when() inside a repeat() row whose condition reads only a component signal.
// On e4a17f1 the pre-rendered row template carries no ids, so the branch initializer finds nothing and
// the attribute binding inside stays empty until the branch has been hidden and shown once.
export const N2 = defineComponent('hardening-n2', () => {
  const rows = signal<Row[]>([
    { id: 1, label: 'one' },
    { id: 2, label: 'two' },
    { id: 3, label: 'three' },
  ]);
  const show = signal(true);
  expose('n2', { rows, show });
  return {
    // prettier-ignore
    template: html`<ul>
      ${repeat(
        rows(),
        (r) => html`<li class="n2-row"><div ${when(show())}><b class="n2-b" title=${r.label}>N2</b></div></li>`,
        null,
        (r) => r.id,
      )}
    </ul>`,
  };
});
