import { defineComponent } from 'thane';

export const HomePage = defineComponent('meta-home', () => ({
  template: html`<main>
    <h1 class="home">Home</h1>
    <a class="to-about" href="/about" @click.prevent=${() => navigate('/about')}>About</a>
    <a class="to-product" href="/products/42" @click.prevent=${() => navigate('/products/42')}>Product</a>
  </main>`,
}));
