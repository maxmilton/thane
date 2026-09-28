import { defineComponent, signal } from 'thane';

// P4 (H-18, RW-2): an event handler inside a whenElse() branch inside a repeat() row.
export const P4 = defineComponent('hardening-p4', () => {
  const rows = signal([{ id: 1, on: true }]);
  const clicks = signal(0);
  return {
    template: html`<div>
      <b class="p4-clicks">${clicks()}</b>
      <ul>
        ${repeat(
          rows(),
          (r) =>
            html`<li>
              ${whenElse(
                r.on,
                html`<button class="p4-then" @click=${() => clicks(clicks() + 1)}>then</button>`,
                html`<i class="p4-else">else</i>`,
              )}
            </li>`,
          null,
          (r) => r.id,
        )}
      </ul>
    </div>`,
  };
});
