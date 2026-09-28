import { defineComponent, signal } from 'thane';

// P2: an event handler on an element in a nested repeat() row.
export const P2 = defineComponent('hardening-p2', () => {
  const groups = signal([{ id: 1, tags: ['a', 'b'] }]);
  const picked = signal('none');
  return {
    template: html`<div>
      <b class="p2-picked">${picked()}</b>
      <ul>
        ${repeat(
          groups(),
          (g) =>
            html`<li>
              <ol>
                ${repeat(
                  g.tags,
                  (t) => html`<li><button class="p2-inner" @click=${() => picked(t)}>${t}</button></li>`,
                )}
              </ol>
            </li>`,
          null,
          (g) => g.id,
        )}
      </ul>
    </div>`,
  };
});
