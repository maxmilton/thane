import { defineComponent, html } from 'thane';
import { countCall } from './expose.js';

/** A child component that records each `onDestroy` call per label in `window.__counts.kidDestroy`. */
export const Kid = defineComponent<{ label: string }>('hardening-kid', ({ props }) => ({
  template: html`<b class="kid">${props.label}</b>`,
  onDestroy: () => {
    countCall('kidDestroy', props.label);
  },
}));
