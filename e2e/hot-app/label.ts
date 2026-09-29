import { defineComponent, html, css } from 'thane';

// The component the hot update test changes: its text and its colour
export const HotLabel = defineComponent<{ n: number }>('hot-label', ({ props }) => ({
  template: html`<b class="hot-label-text">v1 ${props.n}</b>`,
  styles: css`
    b {
      color: rgb(0, 0, 255);
    }
  `,
}));
