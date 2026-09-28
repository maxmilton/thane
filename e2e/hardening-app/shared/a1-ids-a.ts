import { defineComponent, signal } from 'thane';
import { expose } from './expose.js';

/**
 * Developer ids on bound elements, on directive roots, on a repeat container and on an element
 * inside a hidden branch. The a1ids probe places two instances of it and one IdsB on one page, so
 * every id is duplicated; each instance must bind its own elements.
 */
export const IdsA = defineComponent<{ n: number }>('hardening-a1-ids-a', ({ props }) => {
  const t = signal(`a${props.n}`);
  const show = signal(true);
  const hidden = signal(false);
  const items = signal(['x', 'y']);
  const clicks = signal(0);
  expose(`a1ids${props.n}`, { t, show, hidden, items, clicks });
  return {
    template: html`<div class="a1ids">
      <p id="a1-attr" class="a1ids-attr" title=${t()}>P</p>
      <div id="a1-when" class="a1ids-when" ${when(show())}><b class="a1ids-when-b" title=${t()}>W</b></div>
      ${whenElse(
        show(),
        html`<i id="a1-then" class="a1ids-then" title=${t()}>T</i>`,
        html`<i id="a1-else" class="a1ids-else" title=${t()}>E</i>`,
      )}
      <ul id="a1-list" class="a1ids-list">
        ${repeat(items(), (it) => html`<li class="a1ids-row">${it}</li>`)}
      </ul>
      <button id="a1-btn" class="a1ids-btn" @click=${() => clicks(clicks() + 1)}>${clicks()}</button>
      <section class="a1ids-hidden" ${when(hidden())}>
        <span id="a1-inner" class="a1ids-inner" title=${t()}>I</span>
      </section>
    </div>`,
  };
});
