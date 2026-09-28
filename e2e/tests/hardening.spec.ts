import { expect, test, type Page } from '@playwright/test';

// ═══════════════════════════════════════════════════════════════════════
// F0-3 hardening probes: one test per defect confirmed on e4a17f1
// (framework analysis/simplification.md §1.8), run against e2e/hardening-app.
//
// Each test asserts the CORRECT behaviour and stays `test.fixme` until the task named in its title
// fixes the defect; that task changes `test.fixme` to `test`. Every page mounts one probe
// (`/?probe=<id>`), so a test sees only its own component, styles and errors.
//
// X1 did not reproduce on e4a17f1 and runs as a normal test. N1 and N2 are defects found while
// writing these probes (F0-3 hand-off note); N1 became H-40 and N2 H-41 (A1-2).
// ═══════════════════════════════════════════════════════════════════════

type Probe = {
  /** Uncaught page errors since the page was opened. */
  pageErrors: string[];
  /** Errors thrown by mounting the probe (main.ts records them instead of letting them escape). */
  mountErrors: () => Promise<string[]>;
};

const openProbe = async (
  page: Page,
  id: string,
  options: { manual?: boolean; target?: 'body' } = {},
): Promise<Probe> => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(
    `/?probe=${id}${options.manual ? '&manual=1' : ''}${options.target ? `&target=${options.target}` : ''}`,
  );
  await page.waitForFunction(() => (window as any).__ready === true);
  return { pageErrors, mountErrors: () => page.evaluate(() => (window as any).__mountErrors as string[]) };
};

/** Opens a probe and checks that it mounted without an error. */
const mountProbe = async (page: Page, id: string): Promise<Probe> => {
  const probe = await openProbe(page, id);
  expect(await probe.mountErrors()).toEqual([]);
  return probe;
};

/** Live subscribers of a store signal from e2e/hardening-app/shared/store.ts (non-null subscriber slots). */
const liveSubscribers = (page: Page, name: 'l1Tick' | 'l2Tick'): Promise<number> =>
  page.evaluate((signalName) => {
    const slots = (window as any).__probe.store[signalName]._s;
    if (!Array.isArray(slots)) throw new Error('signal internals changed: update liveSubscribers in hardening.spec.ts');
    return slots.filter((callback: unknown) => callback != null).length;
  }, name);

const kidDestroyCounts = (page: Page): Promise<Record<string, number>> =>
  page.evaluate(() => ({ ...((window as any).__counts?.kidDestroy ?? {}) }));

test.describe('F0-3 hardening probes', () => {
  test('H-01 P1 a method call on the row item renders in row text', async ({ page }) => {
    const probe = await mountProbe(page, 'p1');
    await expect(page.locator('.p1-row')).toHaveText(['ALPHA', 'BETA']);

    await page.evaluate(() => (window as any).__probe.p1.items([{ id: 3, name: 'gamma' }]));
    await expect(page.locator('.p1-row')).toHaveText(['GAMMA']);
    expect(probe.pageErrors).toEqual([]);
  });

  test.fixme('H-18 (RW-3) P2 click handlers in nested repeat() rows fire', async ({ page }) => {
    const probe = await mountProbe(page, 'p2');
    await expect(page.locator('.p2-picked')).toHaveText('none');

    await page.locator('.p2-inner', { hasText: 'b' }).click();
    await expect(page.locator('.p2-picked')).toHaveText('b');
    await page.locator('.p2-inner', { hasText: 'a' }).click();
    await expect(page.locator('.p2-picked')).toHaveText('a');
    expect(probe.pageErrors).toEqual([]);
  });

  test.fixme('H-18 (RW-2) P3 a when() in a nested repeat() row renders the inner item', async ({ page }) => {
    const probe = await mountProbe(page, 'p3');
    await expect(page.locator('.p3-w')).toHaveText(['a-shown']);

    await page.evaluate(() => (window as any).__probe.p3.show(false));
    await expect(page.locator('.p3-w')).toHaveCount(0);
    await page.evaluate(() => (window as any).__probe.p3.show(true));
    await expect(page.locator('.p3-w')).toHaveText(['a-shown']);
    expect(probe.pageErrors).toEqual([]);
  });

  test.fixme('H-18 (RW-2) P4 click handlers in a whenElse() branch inside a row fire', async ({ page }) => {
    const probe = await mountProbe(page, 'p4');
    await expect(page.locator('.p4-clicks')).toHaveText('0');

    await page.locator('.p4-then').click();
    await expect(page.locator('.p4-clicks')).toHaveText('1');
    await page.locator('.p4-then').click();
    await expect(page.locator('.p4-clicks')).toHaveText('2');
    expect(probe.pageErrors).toEqual([]);
  });

  test('H-17 P5 a child component in a whenElse() nested in a when() is mounted', async ({ page }) => {
    const probe = await mountProbe(page, 'p5');
    await expect(page.locator('.p5-then .card')).toHaveText(['p5-card']);

    await page.evaluate(() => (window as any).__probe.p5.flag(false));
    await expect(page.locator('.p5-else')).toHaveText('no');
    await expect(page.locator('.card')).toHaveCount(0);
    await page.evaluate(() => (window as any).__probe.p5.flag(true));
    await expect(page.locator('.p5-then .card')).toHaveText(['p5-card']);

    await page.evaluate(() => (window as any).__probe.p5.show(false));
    await expect(page.locator('.p5-when')).toHaveCount(0);
    await page.evaluate(() => (window as any).__probe.p5.show(true));
    await expect(page.locator('.p5-then .card')).toHaveText(['p5-card']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('H-16 P6 child-component rows inside a when() mount when it shows', async ({ page }) => {
    const probe = await mountProbe(page, 'p6');
    await expect(page.locator('.card')).toHaveCount(0);

    await page.evaluate(() => (window as any).__probe.p6.show(true));
    await expect(page.locator('.p6-when .card')).toHaveText(['x', 'y']);
    await page.evaluate(() => (window as any).__probe.p6.show(false));
    await expect(page.locator('.card')).toHaveCount(0);
    await page.evaluate(() => (window as any).__probe.p6.show(true));
    await expect(page.locator('.p6-when .card')).toHaveText(['x', 'y']);
    expect(probe.pageErrors).toEqual([]);
  });

  test.fixme('H-18 (RW-2) P7 a child component in a when() inside a row is mounted', async ({ page }) => {
    const probe = await mountProbe(page, 'p7');
    await expect(page.locator('.p7-row .card')).toHaveText(['p7-card']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('H-07 P8 onMount runs when the setup declares a helper that returns an object', async ({ page }) => {
    const probe = await mountProbe(page, 'p8');
    await expect(page.locator('.p8')).toHaveText('p8');
    await expect(page.locator('#app')).toHaveAttribute('data-mounted', 'yes');
    expect(probe.pageErrors).toEqual([]);
  });

  test('H-03 P12 whitespace inside <pre> is kept', async ({ page }) => {
    const probe = await mountProbe(page, 'p12');
    expect(await page.locator('.p12-pre').textContent()).toBe('line1\n    line2');
    expect(probe.pageErrors).toEqual([]);
  });

  test('H-02 P13 a backslash and an escaped interpolation in template text render literally', async ({ page }) => {
    const probe = await mountProbe(page, 'p13');
    expect(await page.locator('.p13-bs').textContent()).toBe('C:\\dir');
    expect(await page.locator('.p13-dollar').textContent()).toBe('${notExpr}');
    expect(probe.pageErrors).toEqual([]);
  });

  test('H-04 P14 hyphenated tags keep their name as a whenElse() root and with when()', async ({ page }) => {
    const probe = await mountProbe(page, 'p14');
    await expect(page.locator('.p14-we-else')).toHaveText('B');
    await expect(page.locator('section.p14 my-tag')).toHaveCount(0);

    await page.evaluate(() => {
      (window as any).__probe.p14.flag(true);
      (window as any).__probe.p14.show(true);
    });
    await expect(page.locator('section.p14 my-tag.p14-we')).toHaveText('A');
    await expect(page.locator('section.p14 my-tag.p14-w')).toHaveText('W');
    await expect(page.locator('.p14-we-else')).toHaveCount(0);
    await expect(page.locator('section.p14 my')).toHaveCount(0);
    expect(
      await page.locator('section.p14 my-tag').evaluateAll((els) => els.flatMap((el) => el.getAttributeNames())),
    ).not.toContain('-tag');

    await page.evaluate(() => {
      (window as any).__probe.p14.flag(false);
      (window as any).__probe.p14.show(false);
    });
    await expect(page.locator('section.p14 my-tag')).toHaveCount(0);
    await expect(page.locator('.p14-we-else')).toHaveText('B');
    expect(probe.pageErrors).toEqual([]);
  });

  test('H-06 P15 a nested list in the row root does not reorder the outer rows', async ({ page }) => {
    const probe = await mountProbe(page, 'p15');
    const rowIds = () => page.locator('.p15-row').evaluateAll((els) => els.map((el) => el.getAttribute('data-id')));
    expect(await rowIds()).toEqual(['A', 'B']);

    await page.evaluate(() => (window as any).__probe.p15.inner(['A1']));
    await expect(page.locator('.p15-row[data-id="A"] .p15-inner')).toHaveText(['A1']);
    expect(await rowIds()).toEqual(['A', 'B']);

    await page.evaluate(() => (window as any).__probe.p15.inner(['A1', 'B1', 'B2']));
    await expect(page.locator('.p15-row[data-id="B"] .p15-inner')).toHaveText(['B1', 'B2']);
    expect(await rowIds()).toEqual(['A', 'B']);

    await page.evaluate(() => (window as any).__probe.p15.inner([]));
    await expect(page.locator('.p15-inner')).toHaveCount(0);
    expect(await rowIds()).toEqual(['A', 'B']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('H-05 P18 static siblings survive clearing a list', async ({ page }) => {
    const probe = await mountProbe(page, 'p18');
    await expect(page.locator('ul.p18 > li')).toHaveText(['H', 'a', 'b']);

    await page.evaluate(() => (window as any).__probe.p18.items([]));
    await expect(page.locator('ul.p18 > li')).toHaveText(['H']);
    await page.evaluate(() => (window as any).__probe.p18.items(['c']));
    await expect(page.locator('ul.p18 > li')).toHaveText(['H', 'c']);
    expect(probe.pageErrors).toEqual([]);
  });

  test.fixme('H-18 (RW-6, RW-2) P20 a repeat() inside a when() inside a row renders', async ({ page }) => {
    const probe = await mountProbe(page, 'p20');
    await expect(page.locator('.p20-tag')).toHaveText(['t1', 't2']);

    await page.evaluate(() => (window as any).__probe.p20.show(false));
    await expect(page.locator('.p20-wrap')).toHaveCount(0);
    await page.evaluate(() => (window as any).__probe.p20.show(true));
    await expect(page.locator('.p20-tag')).toHaveText(['t1', 't2']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('H-19 P26a :host() with a compound argument applies only while the host matches it', async ({ page }) => {
    const probe = await mountProbe(page, 'p26a');
    const text = page.locator('.p26a-a');
    const setHostClasses = (classes: string[]) =>
      page.evaluate((list) => {
        const host = document.getElementById('app')!;
        host.classList.remove('x', 'y');
        host.classList.add(...list);
      }, classes);
    const green = 'rgb(0, 128, 0)';

    await expect(text).not.toHaveCSS('color', green);
    await setHostClasses(['y']);
    await expect(text).toHaveCSS('color', green);
    await setHostClasses(['x', 'y']);
    await expect(text).not.toHaveCSS('color', green);
    await setHostClasses(['x']);
    await expect(text).not.toHaveCSS('color', green);
    expect(probe.pageErrors).toEqual([]);
  });

  test('H-19 P26b :host-context() applies inside a matching ancestor', async ({ page }) => {
    const probe = await mountProbe(page, 'p26b');
    const text = page.locator('.p26b-a');
    const red = 'rgb(255, 0, 0)';

    await expect(text).not.toHaveCSS('color', red);
    await page.evaluate(() => document.body.classList.add('p26b-dark'));
    await expect(text).toHaveCSS('color', red);
    await page.evaluate(() => document.body.classList.remove('p26b-dark'));
    await expect(text).not.toHaveCSS('color', red);
    expect(probe.pageErrors).toEqual([]);
  });

  test('H-19 P26c a quote in a CSS comment leaves the following rules scoped (dev build)', async ({ page }) => {
    const probe = await mountProbe(page, 'p26c');
    await expect(page.locator('#app .p26c-a')).toHaveCSS('color', 'rgb(0, 0, 255)');
    await expect(page.locator('#app .p26c-leak')).toHaveCSS('color', 'rgb(1, 2, 3)');
    await expect(page.getByTestId('p26c-outside')).not.toHaveCSS('color', 'rgb(1, 2, 3)');
    expect(probe.pageErrors).toEqual([]);
  });

  test("H-28 L1 destroying a component releases its rows' subscriptions and destroys row children", async ({
    page,
  }) => {
    const probe = await openProbe(page, 'l1', { manual: true });
    const before = await liveSubscribers(page, 'l1Tick');
    expect(await page.evaluate(() => (window as any).__mountProbe())).toBe(true);
    expect(await probe.mountErrors()).toEqual([]);
    await expect(page.locator('.l1-row .kid')).toHaveText(['a', 'b']);
    expect(await liveSubscribers(page, 'l1Tick')).toBeGreaterThan(before);

    await page.evaluate(() => (window as any).__probe.store.l1Tick(1));
    await expect(page.locator('.l1-m')).toHaveText(['a-1', 'b-1']);

    await page.evaluate(() => (window as any).__handle.destroy());
    await expect(page.locator('.l1-row')).toHaveCount(0);
    expect(await liveSubscribers(page, 'l1Tick')).toBe(before);
    expect(await kidDestroyCounts(page)).toEqual({ a: 1, b: 1 });
    expect(probe.pageErrors).toEqual([]);
  });

  test("H-28 L2 hiding a when() releases its rows' subscriptions and showing it again adds no second set", async ({
    page,
  }) => {
    const probe = await openProbe(page, 'l2', { manual: true });
    const before = await liveSubscribers(page, 'l2Tick');
    expect(await page.evaluate(() => (window as any).__mountProbe())).toBe(true);
    expect(await probe.mountErrors()).toEqual([]);
    await expect(page.locator('.l2-m')).toHaveText(['a-0', 'b-0']);
    await expect(page.locator('.l2-row .kid')).toHaveText(['a', 'b']);
    const mounted = await liveSubscribers(page, 'l2Tick');
    expect(mounted).toBeGreaterThan(before);

    for (let round = 1; round <= 3; round++) {
      await page.evaluate(() => (window as any).__probe.l2.show(false));
      await expect(page.locator('.l2-row')).toHaveCount(0);
      expect(await liveSubscribers(page, 'l2Tick')).toBe(before);
      // each hide destroys each row's child once (H-40 mounts them in the rows, H-28 cleans the rows up)
      expect(await kidDestroyCounts(page)).toEqual({ a: round, b: round });

      await page.evaluate(() => (window as any).__probe.l2.show(true));
      expect(await liveSubscribers(page, 'l2Tick')).toBe(mounted);
      await expect(page.locator('.l2-row .kid')).toHaveText(['a', 'b']);
      await page.evaluate((tick) => (window as any).__probe.store.l2Tick(tick), round);
      await expect(page.locator('.l2-m')).toHaveText([`a-${round}`, `b-${round}`]);
    }
    expect(probe.pageErrors).toEqual([]);
  });

  test('H-29 I1 a child component in a row may use a named index in its props', async ({ page }) => {
    const probe = await mountProbe(page, 'i1');
    await expect(page.locator('.i1-row .kid')).toHaveText(['x0', 'y1']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('A1-3 M1 multi-root and text-only whenElse() branches show and hide completely', async ({ page }) => {
    const probe = await mountProbe(page, 'm1');
    const two = page.locator('section.m1-two');
    const text = page.locator('section.m1-text');
    const set = (key: 'two' | 'text' | 'n', value: boolean | number) =>
      page.evaluate((arg) => (window as any).__probe.m1[arg.key](arg.value), { key, value });

    await expect(two.locator('.m1-a')).toHaveText('A');
    await expect(two.locator('.m1-b')).toHaveText('1');
    await expect(two.locator('.m1-e')).toHaveCount(0);
    await expect(text).toHaveText('text-1');
    await expect(text.locator('.m1-text-else')).toHaveCount(0);

    for (let n = 2; n <= 4; n++) {
      await set('two', false);
      await set('text', false);
      await expect(two.locator('.m1-a')).toHaveCount(0);
      await expect(two.locator('.m1-b')).toHaveCount(0);
      await expect(two).toHaveText('E');
      await expect(text).toHaveText('else');

      await set('two', true);
      await set('text', true);
      await set('n', n);
      await expect(two.locator('.m1-a')).toHaveCount(1);
      await expect(two.locator('.m1-b')).toHaveText(String(n));
      await expect(two.locator('.m1-e')).toHaveCount(0);
      await expect(two).toHaveText(`A${n}`);
      await expect(text).toHaveText(`text-${n}`);
      await expect(text.locator('.m1-text-else')).toHaveCount(0);
    }
    expect(probe.pageErrors).toEqual([]);
  });

  test("A1-2 / RW-2 X1 attribute bindings in a row's when() land on that row's elements", async ({ page }) => {
    // Did not reproduce on e4a17f1 (kept as a regression test for A1-2 and RW-2). Four shapes: the
    // attribute on the when() element (A), on an element inside its content (B), bound to a component
    // signal (C), and inside a whenElse() branch (D). Row 2 starts hidden.
    const probe = await mountProbe(page, 'x1');
    const toggle = (id: number) => page.evaluate((rowId) => (window as any).__probe.x1.toggle(rowId), id);
    const titles = (shape: 'a' | 'b' | 'd') =>
      page
        .locator(`.x1${shape}-row`)
        .evaluateAll(
          (rows, cls) => rows.map((row) => row.querySelector(`.${cls}`)?.getAttribute('title') ?? null),
          `x1${shape}`,
        );
    const tags = () =>
      page
        .locator('.x1c-row')
        .evaluateAll((rows) => rows.map((row) => row.querySelector('.x1c')?.getAttribute('data-tag') ?? null));

    for (const shape of ['a', 'b', 'd'] as const) expect(await titles(shape)).toEqual(['one', null, 'three']);
    expect(await tags()).toEqual(['t0', null, 't0']);

    await toggle(2);
    for (const shape of ['a', 'b', 'd'] as const) expect(await titles(shape)).toEqual(['one', 'two', 'three']);
    await page.evaluate(() => (window as any).__probe.x1.tag('t1'));
    expect(await tags()).toEqual(['t1', 't1', 't1']);

    await toggle(2);
    await toggle(2);
    await page.evaluate(() => {
      const x1 = (window as any).__probe.x1;
      x1.rows(x1.rows().map((r: { label: string }) => ({ ...r, label: r.label.toUpperCase() })));
      x1.tag('t2');
    });
    for (const shape of ['a', 'b', 'd'] as const) expect(await titles(shape)).toEqual(['ONE', 'TWO', 'THREE']);
    expect(await tags()).toEqual(['t2', 't2', 't2']);

    await toggle(1);
    for (const shape of ['a', 'b', 'd'] as const) expect(await titles(shape)).toEqual([null, 'TWO', 'THREE']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('H-40 N1 child components in the rows of a repeat() inside a when() mount', async ({ page }) => {
    const probe = await mountProbe(page, 'n1');
    await expect(page.locator('.n1-row .kid')).toHaveText(['a', 'b']);

    await page.evaluate(() => (window as any).__probe.n1.show(false));
    await expect(page.locator('.n1-row')).toHaveCount(0);
    await page.evaluate(() => (window as any).__probe.n1.show(true));
    await expect(page.locator('.n1-row .kid')).toHaveText(['a', 'b']);
    expect(probe.pageErrors).toEqual([]);
  });

  test("H-41 (A1-2) N2 bindings in a row's when() on a component signal apply while it is first shown", async ({
    page,
  }) => {
    const probe = await mountProbe(page, 'n2');
    const titles = () => page.locator('.n2-b').evaluateAll((els) => els.map((el) => el.getAttribute('title')));
    expect(await titles()).toEqual(['one', 'two', 'three']);

    await page.evaluate(() => {
      const n2 = (window as any).__probe.n2;
      n2.rows(n2.rows().map((r: { label: string }) => ({ ...r, label: r.label.toUpperCase() })));
    });
    expect(await titles()).toEqual(['ONE', 'TWO', 'THREE']);

    await page.evaluate(() => (window as any).__probe.n2.show(false));
    await expect(page.locator('.n2-b')).toHaveCount(0);
    await page.evaluate(() => (window as any).__probe.n2.show(true));
    expect(await titles()).toEqual(['ONE', 'TWO', 'THREE']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('H-44 K13 a row that is a component call may hold a template literal in its props', async ({ page }) => {
    const probe = await mountProbe(page, 'k13');
    await expect(page.locator('.k13 .card')).toHaveText(['x-a', 'x-b']);

    await page.evaluate(() =>
      (window as any).__probe.k13.rows([
        { id: 1, label: 'a' },
        { id: 2, label: 'b' },
        { id: 3, label: 'c' },
      ]),
    );
    await expect(page.locator('.k13 .card')).toHaveText(['x-a', 'x-b', 'x-c']);
    expect(probe.pageErrors).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// A1-1: characterisation of element lookups and directive branches, before A1 replaces the id
// lookups with paths and the <template> placeholders with comment anchors (simplification.md,
// workstream A1). Every test passes on the wave base, except the `test.fixme` ones, which name the
// A1 task that fixes their defect and switches them on.
// ═══════════════════════════════════════════════════════════════════════

/** A probe's exposed signal setter: `window.__probe[id][key](value)`. */
const setProbe = (page: Page, id: string, key: string, value: unknown) =>
  page.evaluate((arg) => (window as any).__probe[arg.id][arg.key](arg.value), { id, key, value });

const a1Counts = (page: Page): Promise<{ mount: Record<string, number>; destroy: Record<string, number> }> =>
  page.evaluate(() => ({
    mount: { ...((window as any).__counts?.a1Mount ?? {}) },
    destroy: { ...((window as any).__counts?.a1Destroy ?? {}) },
  }));

test.describe('A1-1 lookups and branches', () => {
  test('developer ids: two instances of one component and a second component each bind their own elements', async ({
    page,
  }) => {
    const probe = await mountProbe(page, 'a1ids');
    const one = page.locator('.a1ids-one');
    const two = page.locator('.a1ids-two');
    const three = page.locator('.a1ids-three');

    for (const [scope, t] of [
      [one, 'a1'],
      [two, 'a2'],
    ] as const) {
      await expect(scope.locator('p#a1-attr')).toHaveAttribute('title', t);
      await expect(scope.locator('div#a1-when > b')).toHaveAttribute('title', t);
      await expect(scope.locator('i#a1-then')).toHaveAttribute('title', t);
      await expect(scope.locator('i#a1-else')).toHaveCount(0);
      await expect(scope.locator('ul#a1-list > li')).toHaveText(['x', 'y']);
      await expect(scope.locator('span#a1-inner')).toHaveCount(0);
      await expect(scope.locator('button#a1-btn')).toHaveText('0');
    }
    await expect(three.locator('p#a1-attr')).toHaveAttribute('title', 'b');
    await expect(three.locator('span#a1-inner')).toHaveAttribute('title', 'b');

    // Each instance's signals reach only its own elements
    await setProbe(page, 'a1ids2', 't', 'a2b');
    await expect(two.locator('p#a1-attr')).toHaveAttribute('title', 'a2b');
    await expect(two.locator('div#a1-when > b')).toHaveAttribute('title', 'a2b');
    await expect(two.locator('i#a1-then')).toHaveAttribute('title', 'a2b');
    await expect(one.locator('p#a1-attr')).toHaveAttribute('title', 'a1');
    await expect(three.locator('p#a1-attr')).toHaveAttribute('title', 'b');

    await two.locator('button#a1-btn').click();
    await two.locator('button#a1-btn').click();
    await expect(two.locator('button#a1-btn')).toHaveText('2');
    await expect(one.locator('button#a1-btn')).toHaveText('0');

    await setProbe(page, 'a1ids1', 'items', ['z']);
    await expect(one.locator('ul#a1-list > li')).toHaveText(['z']);
    await expect(two.locator('ul#a1-list > li')).toHaveText(['x', 'y']);

    // Directive roots keep their ids through hide and show
    for (let round = 1; round <= 3; round++) {
      await setProbe(page, 'a1ids1', 'show', false);
      await expect(one.locator('div#a1-when')).toHaveCount(0);
      await expect(one.locator('i#a1-then')).toHaveCount(0);
      await expect(one.locator('i#a1-else')).toHaveAttribute('title', round === 1 ? 'a1' : `a1-${round - 1}`);
      await setProbe(page, 'a1ids1', 't', `a1-${round}`);
      await expect(one.locator('i#a1-else')).toHaveAttribute('title', `a1-${round}`);
      await setProbe(page, 'a1ids1', 'show', true);
      await expect(one.locator('div#a1-when > b')).toHaveAttribute('title', `a1-${round}`);
      await expect(one.locator('i#a1-then')).toHaveAttribute('title', `a1-${round}`);
      await expect(one.locator('i#a1-else')).toHaveCount(0);
    }
    await expect(two.locator('i#a1-then')).toHaveAttribute('title', 'a2b');

    // An element with a developer id inside a branch that starts hidden
    await setProbe(page, 'a1ids2', 'hidden', true);
    await expect(two.locator('span#a1-inner')).toHaveAttribute('title', 'a2b');
    await setProbe(page, 'a1ids2', 't', 'a2c');
    await expect(two.locator('span#a1-inner')).toHaveAttribute('title', 'a2c');
    await expect(three.locator('span#a1-inner')).toHaveAttribute('title', 'b');
    await expect(one.locator('span#a1-inner')).toHaveCount(0);
    expect(probe.pageErrors).toEqual([]);
  });

  test("A1-2 a when() that shows later binds its own element, not a child component's element with the same id", async ({
    page,
  }) => {
    const probe = await mountProbe(page, 'a1idsnested');
    await setProbe(page, 'a1idsNested', 'show', true);
    await expect(page.locator('.a1ids-own-p')).toHaveAttribute('title', 'own');
    await expect(page.locator('.a1ids-child-p')).toHaveAttribute('title', 'child');
    await setProbe(page, 'a1idsNested', 't', 'own2');
    await expect(page.locator('.a1ids-own-p')).toHaveAttribute('title', 'own2');
    await expect(page.locator('.a1ids-child-p')).toHaveAttribute('title', 'child');
    expect(probe.pageErrors).toEqual([]);
  });

  test('text bindings at the start, middle and end of text, next to comments, in <pre> and at the top level', async ({
    page,
  }) => {
    const probe = await mountProbe(page, 'a1text');
    const check = async (a: string, b: string) => {
      await expect(page.locator('.a1t-start')).toHaveText(`${a} tail`);
      await expect(page.locator('.a1t-mid')).toHaveText(`head ${a} tail`);
      await expect(page.locator('.a1t-end')).toHaveText(`head ${a}`);
      await expect(page.locator('.a1t-two')).toHaveText(`${a}${b}`);
      await expect(page.locator('.a1t-expr')).toHaveText(`${a}-${b}!`);
      await expect(page.locator('.a1t-cmt')).toHaveText(`${a} x ${b}`);
      expect(await page.locator('.a1t-pre').textContent()).toBe(`line1\n  ${a} line2\n${b}`);
      await expect(page.locator('.a1t-sole')).toHaveText(b);
      const text = (await page.locator('#app').textContent())!.replace(/\s+/g, ' ').trim();
      const squash = (value: string) => value.replace(/\s+/g, ' ');
      expect(text.startsWith(squash(`top ${a} level `))).toBe(true);
      expect(text.endsWith(squash(` ${b} end`))).toBe(true);
    };
    await check('A', 'B');
    await setProbe(page, 'a1text', 'a', 'A2');
    await setProbe(page, 'a1text', 'b', 'B2');
    await check('A2', 'B2');
    await setProbe(page, 'a1text', 'a', '');
    await check('', 'B2');
    await setProbe(page, 'a1text', 'a', 'A3');
    await check('A3', 'B2');
    expect(probe.pageErrors).toEqual([]);
  });

  test('markup the parser rebuilds: a table without <tbody>, a <p> before a block, unclosed <li>, a <select> list', async ({
    page,
  }) => {
    const probe = await mountProbe(page, 'a1norm');
    const check = async (t: string, x: string) => {
      await expect(page.locator('table.a1n-table > tbody > tr.a1n-tr')).toHaveAttribute('title', t);
      await expect(page.locator('tr.a1n-tr > td.a1n-td')).toHaveText(x);
      await expect(page.locator('tr.a1n-tr > td.a1n-td2')).toHaveAttribute('title', t);
      await expect(page.locator('.a1n-pwrap > p')).toHaveCount(2);
      await expect(page.locator('.a1n-pwrap > p.a1n-p')).toHaveText('intro');
      await expect(page.locator('.a1n-pwrap > div.a1n-div')).toHaveAttribute('title', t);
      await expect(page.locator('.a1n-pwrap > div.a1n-div')).toHaveText(x);
      await expect(page.locator('.a1n-pwrap > span.a1n-after')).toHaveAttribute('title', t);
      await expect(page.locator('.a1n-pwrap > span.a1n-after')).toHaveText(x);
      await expect(page.locator('ul.a1n-list > li')).toHaveCount(2);
      await expect(page.locator('ul.a1n-list > li.a1n-li')).toHaveAttribute('title', t);
      await expect(page.locator('ul.a1n-list > li.a1n-li2')).toHaveAttribute('title', t);
      await expect(page.locator('ul.a1n-list > li.a1n-li2')).toHaveText(x);
    };
    await check('t1', 'x1');
    await setProbe(page, 'a1norm', 't', 't2');
    await setProbe(page, 'a1norm', 'x', 'x2');
    await check('t2', 'x2');

    await page.locator('td.a1n-td2').click();
    await expect(page.locator('.a1n-picks')).toHaveText('1');

    const options = page.locator('select.a1n-select > option');
    await expect(options).toHaveText(['Choose', 'o1', 'o2']);
    await setProbe(page, 'a1norm', 'opts', ['o3']);
    await expect(options).toHaveText(['Choose', 'o3']);
    await setProbe(page, 'a1norm', 'opts', []);
    await expect(options).toHaveText(['Choose']);
    await setProbe(page, 'a1norm', 'opts', ['o4', 'o5']);
    await expect(options).toHaveText(['Choose', 'o4', 'o5']);
    await expect(page.locator('select.a1n-select > option.a1n-opt').first()).toHaveAttribute('value', 'o4');
    expect(probe.pageErrors).toEqual([]);
  });

  test('a repeat() whose container is the component root', async ({ page }) => {
    const probe = await mountProbe(page, 'a1rootlist');
    const rows = page.locator('#app > p.a1r-row');
    await expect(rows).toHaveText(['r1', 'r2']);
    await setProbe(page, 'a1rootlist', 'items', ['r3']);
    await expect(rows).toHaveText(['r3']);
    await setProbe(page, 'a1rootlist', 'items', []);
    await expect(rows).toHaveCount(0);
    await setProbe(page, 'a1rootlist', 'items', ['r4', 'r5', 'r6']);
    await expect(rows).toHaveText(['r4', 'r5', 'r6']);
    await setProbe(page, 'a1rootlist', 'items', ['r6', 'r4']);
    await expect(rows).toHaveText(['r6', 'r4']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('when() / whenElse() alone in an element, next to text and three deep, toggled five times', async ({ page }) => {
    const probe = await mountProbe(page, 'a1dirs');
    const set = (key: string, value: unknown) => setProbe(page, 'a1dirs', key, value);
    const clicks = page.locator('.a1d-clicks');
    let clickCount = 0;
    const click = async (selector: string) => {
      await page.locator(selector).click();
      await expect(clicks).toHaveText(String(++clickCount));
    };

    await expect(page.locator('.a1d-only-w')).toHaveAttribute('title', 't0');
    await expect(page.locator('.a1d-only-w')).toHaveText('t0+only');
    await expect(page.locator('.a1d-text')).toHaveText('before t0+then after');
    await expect(page.locator('.a1d-l3')).toHaveText('L3:t0+l3');
    expect(await a1Counts(page)).toEqual({ mount: { only: 1, then: 1, l3: 1 }, destroy: {} });
    await click('.a1d-only-btn');
    await click('.a1d-then-btn');
    await click('.a1d-l3-btn');

    for (let round = 1; round <= 5; round++) {
      // when() as the only child of its element
      await set('only', false);
      await expect(page.locator('.a1d-only')).toHaveText('');
      await set('t', `o${round}`);
      await set('only', true);
      await expect(page.locator('.a1d-only-w')).toHaveAttribute('title', `o${round}`);
      await expect(page.locator('.a1d-only-w')).toHaveText(`o${round}+only`);
      await click('.a1d-only-btn');

      // whenElse() between text
      await set('text', false);
      await expect(page.locator('.a1d-text')).toHaveText(`before o${round} after`);
      await expect(page.locator('.a1d-else')).toHaveAttribute('title', `o${round}`);
      await set('t', `x${round}`);
      await expect(page.locator('.a1d-else')).toHaveText(`x${round}`);
      await set('text', true);
      await expect(page.locator('.a1d-text')).toHaveText(`before x${round}+then after`);
      await expect(page.locator('.a1d-then')).toHaveAttribute('title', `x${round}`);
      await click('.a1d-then-btn');

      // three deep: hide the innermost, the middle, then the outer level, and show them back
      await set('l3', false);
      await expect(page.locator('.a1d-l3')).toHaveCount(0);
      await set('l2', false);
      await expect(page.locator('.a1d-l2')).toHaveCount(0);
      await expect(page.locator('.a1d-l2-else')).toHaveText('no');
      await set('l1', false);
      await expect(page.locator('.a1d-l1')).toHaveCount(0);
      await set('t', `d${round}`);
      await set('l1', true);
      await expect(page.locator('.a1d-l1')).toHaveAttribute('title', `d${round}`);
      await expect(page.locator('.a1d-l2-else')).toHaveText('no');
      await set('l2', true);
      await expect(page.locator('.a1d-l2')).toHaveAttribute('title', `d${round}`);
      await set('l3', true);
      await expect(page.locator('.a1d-l3')).toHaveAttribute('title', `d${round}`);
      await expect(page.locator('.a1d-l3')).toHaveText(`L3:d${round}+l3`);
      await expect(page.locator('.a1d-l1')).toContainText(`L1:d${round}`);
      await click('.a1d-l3-btn');

      // l3's child also mounts and is destroyed again each time an outer level shows: l1's and l2's
      // templates carry l3's content pre-rendered (its compile-time value is true), and a pre-rendered
      // branch whose condition is false when it binds is initialised, then hidden
      expect(await a1Counts(page)).toEqual({
        mount: { only: round + 1, then: round + 1, l3: 3 * round + 1 },
        destroy: { only: round, then: round, l3: 3 * round },
      });
    }

    // Hiding an outer level destroys the children of every level inside it once
    await set('l1', false);
    expect((await a1Counts(page)).destroy.l3).toBe(16);
    await set('l1', true);
    expect((await a1Counts(page)).mount.l3).toBe(17);
    await expect(page.locator('.a1d-l3')).toHaveText('L3:d5+l3');
    expect(probe.pageErrors).toEqual([]);
  });

  test('when() and whenElse() at the top level of the template, between static nodes', async ({ page }) => {
    const probe = await mountProbe(page, 'a1top');
    const set = (key: string, value: unknown) => setProbe(page, 'a1top', key, value);
    const children = () =>
      page
        .locator('#app')
        .evaluate((app) =>
          [...app.children]
            .filter((el) => el.tagName !== 'TEMPLATE')
            .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
        );

    expect(await children()).toEqual(['b.a1top-w', 'u.a1top-else', 'span.a1top-static']);
    for (let round = 1; round <= 5; round++) {
      await set('a', false);
      await set('b', true);
      expect(await children()).toEqual(['i.a1top-then', 'span.a1top-static']);
      await set('t', `t${round}`);
      await expect(page.locator('.a1top-then')).toHaveAttribute('title', `t${round}`);
      await expect(page.locator('.a1top-then')).toHaveText(`t${round}`);
      await set('a', true);
      await set('b', false);
      expect(await children()).toEqual(['b.a1top-w', 'u.a1top-else', 'span.a1top-static']);
      await expect(page.locator('.a1top-w')).toHaveAttribute('title', `t${round}`);
      await expect(page.locator('.a1top-else')).toHaveText(`t${round}`);
    }
    expect(probe.pageErrors).toEqual([]);
  });

  test('a component mounted into document.body after the nodes the page already holds', async ({ page }) => {
    const probe = await openProbe(page, 'a1body', { target: 'body' });
    expect(await probe.mountErrors()).toEqual([]);
    const bodyChildren = () =>
      page.evaluate(() =>
        [...document.body.children]
          .filter((el) => el.tagName !== 'SCRIPT')
          .map((el) => el.className || el.id || el.tagName),
      );
    expect(await bodyChildren()).toEqual(['H1', 'app', 'p26c-leak', 'a1body']);
    await expect(page.getByTestId('hardening-title')).toHaveText('Thane Hardening App');
    await expect(page.locator('#app')).toBeEmpty();

    await expect(page.locator('body > .a1body')).toHaveAttribute('title', 't0');
    await expect(page.locator('.a1body-row')).toHaveText(['a', 'b']);
    await setProbe(page, 'a1body', 't', 't1');
    await setProbe(page, 'a1body', 'items', ['c', 'a', 'b']);
    await expect(page.locator('body > .a1body')).toHaveAttribute('title', 't1');
    await expect(page.locator('.a1body-row')).toHaveText(['c', 'a', 'b']);
    await page.locator('.a1body-btn').click();
    await expect(page.locator('.a1body-btn')).toHaveText('1');
    const bodyText = await page.evaluate(() => document.body.textContent!.replace(/\s+/g, ' '));
    // The component's text follows the page's own content (a production build drops the whitespace)
    expect(bodyText).toMatch(/outside every component ?body t1/);
    expect(await bodyChildren()).toEqual(['H1', 'app', 'p26c-leak', 'a1body']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('A1-3 M1 a text-only whenElse() branch that starts hidden shows its text and toggles', async ({ page }) => {
    const probe = await mountProbe(page, 'a1texthidden');
    const section = page.locator('section.a1th');
    await expect(section).toHaveText('else');
    for (let n = 1; n <= 5; n++) {
      await setProbe(page, 'a1texthidden', 'on', true);
      await expect(section).toHaveText(`text-${n}`);
      await setProbe(page, 'a1texthidden', 'n', n + 1);
      await expect(section).toHaveText(`text-${n + 1}`);
      await setProbe(page, 'a1texthidden', 'on', false);
      await expect(section).toHaveText('else');
      await expect(section.locator('.a1th-else')).toHaveCount(1);
    }
    expect(probe.pageErrors).toEqual([]);
  });

  test('A1-4 K12 a child component after a row when() of unknown initial value mounts in its own place', async ({
    page,
  }) => {
    const probe = await mountProbe(page, 'a1k12');
    const shape = (rowClass: string) =>
      page
        .locator(rowClass)
        .evaluateAll((rows) =>
          rows.map((row) => [...row.children].map((el) => `${el.tagName.toLowerCase()}:${el.textContent}`)),
        );
    const card = 'hardening-probe-card';
    expect(await shape('.a1k12-row')).toEqual([[`${card}:g1`], [`${card}:g2`]]);
    await setProbe(page, 'a1k12', 'on', true);
    expect(await shape('.a1k12-row')).toEqual([
      ['b:L', `${card}:g1`],
      ['b:L', `${card}:g2`],
    ]);
    await setProbe(page, 'a1k12', 'on', false);
    expect(await shape('.a1k12-row')).toEqual([[`${card}:g1`], [`${card}:g2`]]);
    // A nested list before the child: its rows go before its own anchor, the child stays after them
    expect(await shape('.a1k12n-row')).toEqual([
      ['i:t1', 'i:t2', `${card}:g1`],
      ['i:t3', `${card}:g2`],
    ]);
    await setProbe(page, 'a1k12', 'rows', [
      { id: 1, g: 'g1', tags: ['t4'] },
      { id: 2, g: 'g2', tags: ['t5', 't6'] },
    ]);
    expect(await shape('.a1k12n-row')).toEqual([
      ['i:t4', `${card}:g1`],
      ['i:t5', 'i:t6', `${card}:g2`],
    ]);
    // No placeholder element is left anywhere (A1-4)
    await expect(page.locator('.a1k12 template, .a1k12n template')).toHaveCount(0);
    expect(probe.pageErrors).toEqual([]);
  });

  test('A1-4 H-05 a list anchor is a comment: static siblings and the list survive clearing', async ({ page }) => {
    // The anchor is the container's last node, a comment; no placeholder element is left
    const lastNode = (container: string) =>
      page.locator(container).evaluate((el) => ({
        type: el.lastChild?.nodeType,
        templates: el.querySelectorAll('template').length,
      }));
    const probe = await mountProbe(page, 'p18');
    expect(await lastNode('ul.p18')).toEqual({ type: 8, templates: 0 });
    await setProbe(page, 'p18', 'items', []);
    await expect(page.locator('ul.p18 > li')).toHaveText(['H']);
    expect(await lastNode('ul.p18')).toEqual({ type: 8, templates: 0 });
    await setProbe(page, 'p18', 'items', ['c', 'd']);
    await expect(page.locator('ul.p18 > li')).toHaveText(['H', 'c', 'd']);
    expect(probe.pageErrors).toEqual([]);

    // A list alone in its container (the component root holds only the rows and the anchor), which
    // clearing empties at once and gives the anchor back
    const root = await mountProbe(page, 'a1rootlist');
    await setProbe(page, 'a1rootlist', 'items', []);
    await expect(page.locator('#app > p.a1r-row')).toHaveCount(0);
    expect(await page.locator('#app').evaluate((el) => [...el.childNodes].map((n) => n.nodeType))).toEqual([8]);
    await setProbe(page, 'a1rootlist', 'items', ['r7', 'r8']);
    await expect(page.locator('#app > p.a1r-row')).toHaveText(['r7', 'r8']);
    expect(await lastNode('#app')).toEqual({ type: 8, templates: 0 });
    expect(root.pageErrors).toEqual([]);
  });

  test('A1-4 child hosts: in the template where the parser keeps them, replacing a comment where it would not', async ({
    page,
  }) => {
    const probe = await mountProbe(page, 'a1hosts');
    const card = 'hardening-probe-card';
    // One host per child, in its place, with the child mounted into it
    const children = (selector: string) =>
      page
        .locator(selector)
        .evaluateAll((els) =>
          els.map((el) => [...el.children].map((c) => `${c.tagName.toLowerCase()}:${c.textContent}`)),
        );
    expect(await children('.a1h-p')).toEqual([[`${card}:p`]]);
    // a table row: the host replaces a comment anchor, inside the row
    expect(await children('.a1h-tbody > tr')).toEqual([
      ['td:g1', `${card}:tr-g1`],
      ['td:g2', `${card}:tr-g2`],
    ]);
    // a row that is only the child: the host is the row
    expect(await children('.a1h-list')).toEqual([[`${card}:row-g1`, `${card}:row-g2`]]);
    // svg: the host is an HTML element, as createElement makes it
    const svgHost = await page
      .locator('.a1h-svg')
      .evaluate((svg) => [...svg.children].map((c) => [c.localName, c.namespaceURI, c.textContent]));
    expect(svgHost).toEqual([[card, 'http://www.w3.org/1999/xhtml', 'svg']]);
    // rows that move and go keep their children
    await setProbe(page, 'a1hosts', 'rows', [
      { id: 2, g: 'g2' },
      { id: 3, g: 'g3' },
    ]);
    expect(await children('.a1h-tbody > tr')).toEqual([
      ['td:g2', `${card}:tr-g2`],
      ['td:g3', `${card}:tr-g3`],
    ]);
    expect(await children('.a1h-list')).toEqual([[`${card}:row-g2`, `${card}:row-g3`]]);
    await setProbe(page, 'a1hosts', 'rows', []);
    expect(await children('.a1h-list')).toEqual([[]]);
    await expect(page.locator('.a1h-tbody > tr')).toHaveCount(0);
    expect(probe.pageErrors).toEqual([]);
  });

  test('A1-4 no generated id reaches the DOM', async ({ page }) => {
    for (const id of [
      'a1ids',
      'a1idsnested',
      'a1text',
      'a1norm',
      'a1rootlist',
      'a1dirs',
      'a1top',
      'a1k12',
      'a1hosts',
      'p18',
    ]) {
      const probe = await mountProbe(page, id);
      const markup = await page.locator('#app').evaluate((el) => el.innerHTML);
      expect(markup.match(/\bid="[bi]\d+"|<template|<!--[bi]\d|data-thane-ref/g) ?? [], id).toEqual([]);
      expect(probe.pageErrors, id).toEqual([]);
    }
  });

  test('H-45 (A1-2) K14 an event on an element with an empty id attribute is bound', async ({ page }) => {
    const probe = await mountProbe(page, 'a1k14');
    await page.locator('.a1k14-btn').click();
    await expect(page.locator('.a1k14-btn')).toHaveText('1');
    expect(probe.pageErrors).toEqual([]);
  });
});
