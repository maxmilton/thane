import { defineComponent } from 'thane';
import { countCall } from './expose.js';

/**
 * A child component that counts its `onMount` and `onDestroy` calls per label in
 * `window.__counts.a1Mount` / `window.__counts.a1Destroy` (children inside directives).
 */
export const CountingKid = defineComponent<{ label: string }>('hardening-counting-kid', ({ props }) => ({
  template: html`<em class="ckid">${props.label}</em>`,
  onMount: () => {
    countCall('a1Mount', props.label);
  },
  onDestroy: () => {
    countCall('a1Destroy', props.label);
  },
}));
