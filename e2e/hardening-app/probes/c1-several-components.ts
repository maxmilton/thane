import { defineComponent, signal, html, css, repeat } from 'thane';
import { expose } from '../shared/expose.js';

// C1: several components in one file. C1Pill is not exported: C1 mounts it at the top level and in its
// rows. C1Count is exported next to C1. Each has a signal named `count` with its own initial value, and
// C1Pill's styles apply to its own elements only.
const C1Pill = defineComponent<{ label: string }>(({ props }) => {
  const count = signal(2);
  return {
    template: html`<span class="c1-pill-text">${props.label} ${count()}</span>`,
    styles: css`
      span {
        color: rgb(0, 128, 0);
      }
    `,
  };
});

export const C1Count = defineComponent(() => {
  const count = signal(3);
  expose('c1count', { count });
  return { template: html`<b class="c1-count-value">${count()}</b>` };
});

export const C1 = defineComponent('hardening-c1', () => {
  const count = signal(1);
  const items = signal([
    { id: 1, label: 'a' },
    { id: 2, label: 'b' },
  ]);
  expose('c1', { count, items });
  return {
    template: html`<div class="c1">
      <p class="c1-own">${count()}</p>
      <span class="c1-plain">plain</span>
      ${C1Pill({ label: 'top' })} ${C1Count({})}
      <ul class="c1-rows">
        ${repeat(
          items(),
          (item) => html`<li>${C1Pill({ label: item.label })}</li>`,
          null,
          (item) => item.id,
        )}
      </ul>
    </div>`,
  };
});
