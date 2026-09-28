import { defineComponent } from 'thane';

export const AboutPage = defineComponent('meta-about', () => ({
  template: html`<main>
    <h1 class="about">About</h1>
    <a class="to-home" href="/" @click.prevent=${() => navigate('/')}>Home</a>
  </main>`,
}));
