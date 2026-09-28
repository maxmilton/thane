import { defineComponent } from 'thane';

// P8 (H-07): the setup declares a helper function that returns an object literal before its own return.
export const P8 = defineComponent('hardening-p8', ({ root }) => {
  function helper() {
    return { a: 1 };
  }
  helper();
  return {
    template: html`<p class="p8">p8</p>`,
    onMount: () => {
      root.setAttribute('data-mounted', 'yes');
    },
  };
});
