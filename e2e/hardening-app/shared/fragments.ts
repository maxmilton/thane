import { defineComponent, html, repeat, signal } from 'thane';

// Fragments for F2, which another module's template uses: a static one, one that reads this module's
// signal and mounts a component this module does not export, and one with a list.
export const f2Tone = signal('calm');
export const f2Tags = signal(['a', 'b']);

const F2Kid = defineComponent<{ n: number }>(({ props }) => ({
  template: html`<em class="f2-kid-n">${props.n}</em>`,
}));

export const F2Static = html`<span class="f2-static">static</span>`;

export const F2Badge = html`<b class="f2-badge" data-tone=${f2Tone()}>${f2Tone()}</b>${F2Kid({ n: 3 })}`;

export const F2Tags = html`<ul class="f2-tags">
  ${repeat(
    f2Tags(),
    (tag) => html`<li class="f2-tag">${tag}</li>`,
    null,
    (tag) => tag,
  )}
</ul>`;
