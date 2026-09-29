/**
 * Hardening app: one probe component per defect found by probing the compiler and runtime.
 *
 * `/?probe=<id>` mounts that one probe into #app, so every test sees only its own component, styles
 * and errors. `&manual=1` skips the mount, for tests that measure state before mounting and call
 * `window.__mountProbe()` themselves. `&target=body` mounts into document.body instead of #app. A mount
 * that throws is recorded in `window.__mountErrors`.
 */
import { mount, type ComponentHTMLSelector } from 'thane';
import { A1Body } from './probes/a1-body.js';
import { A1Dirs } from './probes/a1-dirs.js';
import { A1Ids } from './probes/a1-ids.js';
import { A1IdsNested } from './probes/a1-ids-nested.js';
import { A1K12 } from './probes/a1-k12.js';
import { A1Hosts } from './probes/a1-hosts.js';
import { A1K14 } from './probes/a1-k14.js';
import { A1Norm } from './probes/a1-norm.js';
import { A1RootList } from './probes/a1-rootlist.js';
import { A1Text } from './probes/a1-text.js';
import { A1TextHidden } from './probes/a1-text-hidden.js';
import { A1Top } from './probes/a1-top.js';
import { H52 } from './probes/h52-row-text-space.js';
import { H53 } from './probes/h53-text-next-to-elements.js';
import { I1 } from './probes/i1-index-child-props.js';
import { K13 } from './probes/k13-component-row-template.js';
import { L1 } from './probes/l1-destroy-rows.js';
import { L2 } from './probes/l2-hidden-rows.js';
import { M1 } from './probes/m1-multi-root-branch.js';
import { N1 } from './probes/n1-child-rows-in-when.js';
import { N2 } from './probes/n2-row-when-component-condition.js';
import { P1 } from './probes/p1-row-method-call.js';
import { P2 } from './probes/p2-nested-row-event.js';
import { P3 } from './probes/p3-nested-row-when.js';
import { P4 } from './probes/p4-row-whenelse-event.js';
import { P5 } from './probes/p5-nested-whenelse-child.js';
import { P6 } from './probes/p6-child-rows-in-when.js';
import { P7 } from './probes/p7-row-when-child.js';
import { P8 } from './probes/p8-helper-return.js';
import { P12 } from './probes/p12-pre-whitespace.js';
import { P13 } from './probes/p13-backslash-escape.js';
import { P14 } from './probes/p14-hyphenated-tag.js';
import { P15 } from './probes/p15-nested-list-row-root.js';
import { P18 } from './probes/p18-static-sibling.js';
import { P20 } from './probes/p20-row-when-repeat.js';
import { P26a } from './probes/p26a-host-compound.js';
import { P26b } from './probes/p26b-host-context.js';
import { P26c } from './probes/p26c-comment-quote.js';
import { CssNamespace } from './probes/css-namespace.js';
import { Quotes } from './probes/quotes-in-attrs.js';
import { RW2 } from './probes/rw2-row-directives.js';
import { RW2Sig } from './probes/rw2-signal-rows.js';
import { RW3 } from './probes/rw3-nested-lists.js';
import { R1 } from './probes/r1-reorder-before-anchor.js';
import { T1 } from './probes/t1-helper-calls.js';
import { X1 } from './probes/x1-row-when-attribute.js';

const probes: Record<string, ComponentHTMLSelector<any>> = {
  p1: P1,
  p2: P2,
  p3: P3,
  p4: P4,
  p5: P5,
  p6: P6,
  p7: P7,
  p8: P8,
  p12: P12,
  p13: P13,
  p14: P14,
  p15: P15,
  p18: P18,
  p20: P20,
  p26a: P26a,
  p26b: P26b,
  p26c: P26c,
  l1: L1,
  l2: L2,
  i1: I1,
  m1: M1,
  x1: X1,
  n1: N1,
  n2: N2,
  k13: K13,
  a1ids: A1Ids,
  a1idsnested: A1IdsNested,
  a1text: A1Text,
  a1norm: A1Norm,
  a1rootlist: A1RootList,
  a1dirs: A1Dirs,
  a1top: A1Top,
  a1body: A1Body,
  a1texthidden: A1TextHidden,
  a1k12: A1K12,
  a1hosts: A1Hosts,
  a1k14: A1K14,
  h52: H52,
  h53: H53,
  rw2: RW2,
  rw2sig: RW2Sig,
  rw3: RW3,
  quotes: Quotes,
  cssnamespace: CssNamespace,
  r1: R1,
  t1: T1,
};

const win = window as any;
const params = new URLSearchParams(location.search);
const probeId = params.get('probe') ?? '';
win.__mountErrors = [];

win.__mountProbe = (): boolean => {
  const component = probes[probeId];
  // `&target=body` mounts into document.body, after the nodes the page already has (Mode A)
  const target = params.get('target') === 'body' ? document.body : document.getElementById('app');
  if (!component || !target) {
    win.__mountErrors.push(`unknown probe "${probeId}"`);
    return false;
  }
  try {
    win.__handle = mount({ component, target });
    return true;
  } catch (error) {
    win.__mountErrors.push(String(error));
    return false;
  }
};

if (params.get('manual') !== '1') win.__mountProbe();
win.__ready = true;
