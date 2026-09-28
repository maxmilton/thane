import { defineComponent, signal } from 'thane';
import { expose } from '../shared/expose.js';
import { CountingKid } from '../shared/counting-kid.js';

// when() / whenElse() as the only child of an element, next to text, and nested three deep,
// each with bindings, an event and a child component inside. The spec toggles each one five times
// and counts the children's onMount / onDestroy calls.
export const A1Dirs = defineComponent('hardening-a1-dirs', () => {
  const t = signal('t0');
  const only = signal(true);
  const text = signal(true);
  const l1 = signal(true);
  const l2 = signal(true);
  const l3 = signal(true);
  const clicks = signal(0);
  const inc = () => clicks(clicks() + 1);
  expose('a1dirs', { t, only, text, l1, l2, l3, clicks });
  return {
    // prettier-ignore
    template: html`<div class="a1dirs">
      <section class="a1d-only"><div class="a1d-only-w" ${when(only())} title=${t()}>${t()}<button class="a1d-only-btn" @click=${inc}>+</button>${CountingKid({ label: 'only' })}</div></section>
      <section class="a1d-text">before ${whenElse(text(), html`<i class="a1d-then" title=${t()}>${t()}<button class="a1d-then-btn" @click=${inc}>+</button>${CountingKid({ label: 'then' })}</i>`, html`<u class="a1d-else" title=${t()}>${t()}</u>`)} after</section>
      <section class="a1d-deep">
        <div class="a1d-l1" ${when(l1())} title=${t()}>
          L1:${t()}
          ${whenElse(l2(), html`<div class="a1d-l2" title=${t()}>L2:${t()}<p class="a1d-l3" ${when(l3())} title=${t()}>L3:${t()}<button class="a1d-l3-btn" @click=${inc}>+</button>${CountingKid({ label: 'l3' })}</p></div>`, html`<span class="a1d-l2-else">no</span>`)}
        </div>
      </section>
      <b class="a1d-clicks">${clicks()}</b>
    </div>`,
  };
});
