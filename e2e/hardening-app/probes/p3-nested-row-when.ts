import { defineComponent, signal, html, when, repeat } from 'thane';
import { expose } from '../shared/expose.js';

// P3: a when() inside a nested repeat() row whose content reads the inner item.
export const P3 = defineComponent('hardening-p3', () => {
  const groups = signal([{ id: 1, tags: ['a'] }]);
  const show = signal(true);
  expose('p3', { show });
  return {
    template: html`<ul>
      ${repeat(
        groups(),
        (g) =>
          html`<li>
            <ol>
              ${repeat(g.tags, (t) => html`<li><em class="p3-w" ${when(show())}>${t}-shown</em></li>`)}
            </ol>
          </li>`,
        null,
        (g) => g.id,
      )}
    </ul>`,
  };
});
