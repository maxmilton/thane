import { defineComponent } from 'thane';

/** A child component without lifecycle hooks (registered lean). */
export const ProbeCard = defineComponent<{ label: string }>('hardening-probe-card', ({ props }) => ({
  template: html`<span class="card">${props.label}</span>`,
}));
