import { defineComponent } from 'thane';

export const NotFoundPage = defineComponent('meta-not-found', () => ({
  template: html`<main><h1 class="not-found">Not found</h1></main>`,
}));
