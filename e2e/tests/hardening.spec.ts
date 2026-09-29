import { expect, test, type Page } from '@playwright/test';

// ═══════════════════════════════════════════════════════════════════════
// Hardening probes: one test per defect found by probing e4a17f1, run against e2e/hardening-app.
//
// Each defect is fixed, and its test asserts the correct behaviour. Every page mounts one probe
// (`/?probe=<id>`), so a test sees only its own component, styles and errors.
//
// X1 did not reproduce on e4a17f1 and is kept as a regression test. N1 and N2 are defects found while
// writing these probes.
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

test.describe('hardening probes', () => {
  test('a method call on the row item renders in row text', async ({ page }) => {
    const probe = await mountProbe(page, 'p1');
    await expect(page.locator('.p1-row')).toHaveText(['ALPHA', 'BETA']);

    await page.evaluate(() => (window as any).__probe.p1.items([{ id: 3, name: 'gamma' }]));
    await expect(page.locator('.p1-row')).toHaveText(['GAMMA']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('click handlers in nested repeat() rows fire', async ({ page }) => {
    const probe = await mountProbe(page, 'p2');
    await expect(page.locator('.p2-picked')).toHaveText('none');

    await page.locator('.p2-inner', { hasText: 'b' }).click();
    await expect(page.locator('.p2-picked')).toHaveText('b');
    await page.locator('.p2-inner', { hasText: 'a' }).click();
    await expect(page.locator('.p2-picked')).toHaveText('a');
    expect(probe.pageErrors).toEqual([]);
  });

  test('a when() in a nested repeat() row renders the inner item', async ({ page }) => {
    const probe = await mountProbe(page, 'p3');
    await expect(page.locator('.p3-w')).toHaveText(['a-shown']);

    await page.evaluate(() => (window as any).__probe.p3.show(false));
    await expect(page.locator('.p3-w')).toHaveCount(0);
    await page.evaluate(() => (window as any).__probe.p3.show(true));
    await expect(page.locator('.p3-w')).toHaveText(['a-shown']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('click handlers in a whenElse() branch inside a row fire', async ({ page }) => {
    const probe = await mountProbe(page, 'p4');
    await expect(page.locator('.p4-clicks')).toHaveText('0');

    await page.locator('.p4-then').click();
    await expect(page.locator('.p4-clicks')).toHaveText('1');
    await page.locator('.p4-then').click();
    await expect(page.locator('.p4-clicks')).toHaveText('2');
    expect(probe.pageErrors).toEqual([]);
  });

  test('a child component in a whenElse() nested in a when() is mounted', async ({ page }) => {
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

  test('child-component rows inside a when() mount when it shows', async ({ page }) => {
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

  test('a child component in a when() inside a row is mounted', async ({ page }) => {
    const probe = await mountProbe(page, 'p7');
    await expect(page.locator('.p7-row .card')).toHaveText(['p7-card']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('onMount runs when the setup declares a helper that returns an object', async ({ page }) => {
    const probe = await mountProbe(page, 'p8');
    await expect(page.locator('.p8')).toHaveText('p8');
    await expect(page.locator('#app')).toHaveAttribute('data-mounted', 'yes');
    expect(probe.pageErrors).toEqual([]);
  });

  test('whitespace inside <pre> is kept', async ({ page }) => {
    const probe = await mountProbe(page, 'p12');
    expect(await page.locator('.p12-pre').textContent()).toBe('line1\n    line2');
    expect(probe.pageErrors).toEqual([]);
  });

  test('a backslash and an escaped interpolation in template text render literally', async ({ page }) => {
    const probe = await mountProbe(page, 'p13');
    expect(await page.locator('.p13-bs').textContent()).toBe('C:\\dir');
    expect(await page.locator('.p13-dollar').textContent()).toBe('${notExpr}');
    expect(probe.pageErrors).toEqual([]);
  });

  test('hyphenated tags keep their name as a whenElse() root and with when()', async ({ page }) => {
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

  test('a nested list in the row root does not reorder the outer rows', async ({ page }) => {
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

  test('static siblings survive clearing a list', async ({ page }) => {
    const probe = await mountProbe(page, 'p18');
    await expect(page.locator('ul.p18 > li')).toHaveText(['H', 'a', 'b']);

    await page.evaluate(() => (window as any).__probe.p18.items([]));
    await expect(page.locator('ul.p18 > li')).toHaveText(['H']);
    await page.evaluate(() => (window as any).__probe.p18.items(['c']));
    await expect(page.locator('ul.p18 > li')).toHaveText(['H', 'c']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('a repeat() inside a when() inside a row renders', async ({ page }) => {
    const probe = await mountProbe(page, 'p20');
    await expect(page.locator('.p20-tag')).toHaveText(['t1', 't2']);

    await page.evaluate(() => (window as any).__probe.p20.show(false));
    await expect(page.locator('.p20-wrap')).toHaveCount(0);
    await page.evaluate(() => (window as any).__probe.p20.show(true));
    await expect(page.locator('.p20-tag')).toHaveText(['t1', 't2']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('host() with a compound argument applies only while the host matches it', async ({ page }) => {
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

  test('host-context() applies inside a matching ancestor', async ({ page }) => {
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

  test('a quote in a CSS comment leaves the following rules scoped (dev build)', async ({ page }) => {
    const probe = await mountProbe(page, 'p26c');
    await expect(page.locator('#app .p26c-a')).toHaveCSS('color', 'rgb(0, 0, 255)');
    await expect(page.locator('#app .p26c-leak')).toHaveCSS('color', 'rgb(1, 2, 3)');
    await expect(page.getByTestId('p26c-outside')).not.toHaveCSS('color', 'rgb(1, 2, 3)');
    expect(probe.pageErrors).toEqual([]);
  });

  test("L1 destroying a component releases its rows' subscriptions and destroys row children", async ({ page }) => {
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

  test("L2 hiding a when() releases its rows' subscriptions and showing it again adds no second set", async ({
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
      // each hide destroys each row's child once (the rows mount them, and clean them up)
      expect(await kidDestroyCounts(page)).toEqual({ a: round, b: round });

      await page.evaluate(() => (window as any).__probe.l2.show(true));
      expect(await liveSubscribers(page, 'l2Tick')).toBe(mounted);
      await expect(page.locator('.l2-row .kid')).toHaveText(['a', 'b']);
      await page.evaluate((tick) => (window as any).__probe.store.l2Tick(tick), round);
      await expect(page.locator('.l2-m')).toHaveText([`a-${round}`, `b-${round}`]);
    }
    expect(probe.pageErrors).toEqual([]);
  });

  test('I1 a child component in a row may use a named index in its props', async ({ page }) => {
    const probe = await mountProbe(page, 'i1');
    await expect(page.locator('.i1-row .kid')).toHaveText(['x0', 'y1']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('M1 multi-root and text-only whenElse() branches show and hide completely', async ({ page }) => {
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

  test("X1 attribute bindings in a row's when() land on that row's elements", async ({ page }) => {
    // Did not reproduce on e4a17f1 (kept as a regression test). Four shapes: the
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

  test('N1 child components in the rows of a repeat() inside a when() mount', async ({ page }) => {
    const probe = await mountProbe(page, 'n1');
    await expect(page.locator('.n1-row .kid')).toHaveText(['a', 'b']);

    await page.evaluate(() => (window as any).__probe.n1.show(false));
    await expect(page.locator('.n1-row')).toHaveCount(0);
    await page.evaluate(() => (window as any).__probe.n1.show(true));
    await expect(page.locator('.n1-row .kid')).toHaveText(['a', 'b']);
    expect(probe.pageErrors).toEqual([]);
  });

  test("N2 bindings in a row's when() on a component signal apply while it is first shown", async ({ page }) => {
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

  test('a row that is a component call may hold a template literal in its props', async ({ page }) => {
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
// Element lookups and directive branches: developer ids, text positions, browser-normalised markup,
// branches at every position and depth, and two instances of one component. They pinned the
// behaviour that path-based lookup and comment-anchored branches had to keep.
// ═══════════════════════════════════════════════════════════════════════

/** A probe's exposed signal setter: `window.__probe[id][key](value)`. */
const setProbe = (page: Page, id: string, key: string, value: unknown) =>
  page.evaluate((arg) => (window as any).__probe[arg.id][arg.key](arg.value), { id, key, value });

const a1Counts = (page: Page): Promise<{ mount: Record<string, number>; destroy: Record<string, number> }> =>
  page.evaluate(() => ({
    mount: { ...((window as any).__counts?.a1Mount ?? {}) },
    destroy: { ...((window as any).__counts?.a1Destroy ?? {}) },
  }));

test.describe('lookups and branches', () => {
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

  test("a when() that shows later binds its own element, not a child component's element with the same id", async ({
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

  test('M1 a text-only whenElse() branch that starts hidden shows its text and toggles', async ({ page }) => {
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

  test('a child component after a row when() of unknown initial value mounts in its own place', async ({ page }) => {
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
    // No placeholder element is left anywhere
    await expect(page.locator('.a1k12 template, .a1k12n template')).toHaveCount(0);
    expect(probe.pageErrors).toEqual([]);
  });

  test('a list anchor is a comment: static siblings and the list survive clearing', async ({ page }) => {
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

  test('child hosts: in the template where the parser keeps them, replacing a comment where it would not', async ({
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

  test('no generated id reaches the DOM', async ({ page }) => {
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

  test('an event on an element with an empty id attribute is bound', async ({ page }) => {
    const probe = await mountProbe(page, 'a1k14');
    await page.locator('.a1k14-btn').click();
    await expect(page.locator('.a1k14-btn')).toHaveText('1');
    expect(probe.pageErrors).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The text between row text bindings, rendered. Text is compared exactly (textContent), not
// whitespace-normalised.
// ═══════════════════════════════════════════════════════════════════════

type H52Row = { id: number; first: string; mid: string; last: string };

const H52_ROWS: H52Row[] = [{ id: 1, first: 'John', mid: 'Q', last: 'Doe' }];
const H52_UPDATED: H52Row[] = [
  { id: 2, first: 'Jane', mid: 'R', last: 'Roe' },
  { id: 1, first: 'Max', mid: 'S', last: 'Mu' },
];

/** The exact text of every row of the probe's list `.h52-<shape>`. */
const h52Texts = (page: Page, shape: string): Promise<string[]> => page.locator(`.h52-${shape} li`).allTextContents();

test.describe('row text bindings', () => {
  test('row text bindings separated by whitespace show one space, and update', async ({ page }) => {
    const probe = await mountProbe(page, 'h52');
    const check = async (rows: H52Row[], label: string) => {
      for (const shape of ['space', 'two', 'newline', 'padded']) {
        await expect.poll(() => h52Texts(page, shape), shape).toEqual(rows.map((r) => `${r.first} ${r.last}`));
      }
      await expect.poll(() => h52Texts(page, 'three')).toEqual(rows.map((r) => `${r.first} ${r.mid} ${r.last}`));
      await expect.poll(() => h52Texts(page, 'signal')).toEqual(rows.map((r) => `${r.first} ${label}`));
    };
    await check(H52_ROWS, 'L');
    await setProbe(page, 'h52', 'items', H52_UPDATED);
    await setProbe(page, 'h52', 'label', 'M');
    await check(H52_UPDATED, 'M');
    expect(probe.pageErrors).toEqual([]);
  });

  test('row shapes that already show their text as written: -, adjacent, around, in a when(), and component level', async ({
    page,
  }) => {
    const probe = await mountProbe(page, 'h52');
    const check = async (rows: H52Row[], a: string, b: string) => {
      await expect.poll(() => h52Texts(page, 'dash')).toEqual(rows.map((r) => `${r.first}-${r.last}`));
      await expect.poll(() => h52Texts(page, 'adjacent')).toEqual(rows.map((r) => `${r.first}${r.last}`));
      await expect.poll(() => h52Texts(page, 'around')).toEqual(rows.map((r) => `x ${r.first} y`));
      await expect.poll(() => h52Texts(page, 'when')).toEqual(rows.map((r) => `${r.first} ${r.last}`));
      await expect.poll(() => page.locator('.h52-component').textContent()).toBe(`${a} ${b}`);
    };
    await check(H52_ROWS, 'A', 'B');
    await setProbe(page, 'h52', 'items', H52_UPDATED);
    await setProbe(page, 'h52', 'a', 'A2');
    await check(H52_UPDATED, 'A2', 'B');
    expect(probe.pageErrors).toEqual([]);
  });

  test('the space between a text binding and an element shows, in rows and at component level', async ({ page }) => {
    const probe = await mountProbe(page, 'h52');
    await expect.poll(() => h52Texts(page, 'before')).toEqual(['John b']);
    await expect.poll(() => h52Texts(page, 'after')).toEqual(['b John']);
    await expect.poll(() => page.locator('.h52-cbefore').textContent()).toBe('A b');
    await expect.poll(() => page.locator('.h52-cafter').textContent()).toBe('b A');
    expect(probe.pageErrors).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The whitespace between a text binding and an element or
// directive next to it, rendered. Text is compared exactly (textContent): a hidden when() leaves the
// space on each side of its anchors, as static text around a removed element would.
// ═══════════════════════════════════════════════════════════════════════

/** The exact text of every row of the probe's list `.h53-<shape>`. */
const h53Rows = (page: Page, shape: string): Promise<string[]> => page.locator(`.h53-${shape} li`).allTextContents();
const h53Text = (page: Page, shape: string): Promise<string | null> => page.locator(`.h53-${shape}`).textContent();

test.describe('text bindings next to elements and directives', () => {
  test('whitespace between a text binding and an element or directive shows as one space', async ({ page }) => {
    const probe = await mountProbe(page, 'h53');
    await expect.poll(() => h53Rows(page, 'label')).toEqual(['Name: John']);
    await expect.poll(() => h53Rows(page, 'check')).toEqual([' John']);
    await expect.poll(() => h53Rows(page, 'before')).toEqual(['John x']);
    await expect.poll(() => h53Rows(page, 'when')).toEqual(['John w Doe']);
    await expect.poll(() => h53Rows(page, 'whenelse')).toEqual(['John y Doe']);
    await expect.poll(() => h53Text(page, 'cbefore')).toBe('A x');
    await expect.poll(() => h53Text(page, 'cwhen')).toBe('A w B');
    await expect.poll(() => h53Text(page, 'cwhenelse')).toBe('A y B');
    await expect.poll(() => h53Text(page, 'branch')).toBe('A x');

    await setProbe(page, 'h53', 'items', [
      { id: 2, first: 'Jane', last: 'Roe', on: false },
      { id: 1, first: 'Max', last: 'Mu', on: true },
    ]);
    await setProbe(page, 'h53', 'a', 'A2');
    await expect.poll(() => h53Rows(page, 'label')).toEqual(['Name: Jane', 'Name: Max']);
    await expect.poll(() => h53Rows(page, 'before')).toEqual(['Jane x', 'Max x']);
    await expect.poll(() => h53Rows(page, 'when')).toEqual(['Jane  Roe', 'Max w Mu']);
    await expect.poll(() => h53Rows(page, 'whenelse')).toEqual(['Jane n Roe', 'Max y Mu']);
    await expect.poll(() => h53Text(page, 'cbefore')).toBe('A2 x');
    await expect.poll(() => h53Text(page, 'branch')).toBe('A2 x');

    await setProbe(page, 'h53', 'on', false);
    await expect.poll(() => h53Text(page, 'cwhen')).toBe('A2  B');
    await expect.poll(() => h53Text(page, 'cwhenelse')).toBe('A2 n B');
    await expect.poll(() => h53Text(page, 'branch')).toBe('none');
    await setProbe(page, 'h53', 'on', true);
    await expect.poll(() => h53Text(page, 'cwhen')).toBe('A2 w B');
    await expect.poll(() => h53Text(page, 'branch')).toBe('A2 x');
    expect(probe.pageErrors).toEqual([]);
  });

  test('a space between two elements on one line stays; with a line break it goes', async ({ page }) => {
    const probe = await mountProbe(page, 'h53');
    await expect.poll(() => h53Text(page, 'elements')).toBe('x y');
    await expect.poll(() => h53Text(page, 'lines')).toBe('xy');
    expect(probe.pageErrors).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Nested directives inside repeat() rows: everything a component-level list or branch can contain
// also works inside a row, at any depth.
// ═══════════════════════════════════════════════════════════════════════

type RW2Row = { id: number; first: string; last: string; on: boolean; tags: string[] };

const texts = (page: Page, selector: string): Promise<string[]> => page.locator(selector).allTextContents();
const rwLog = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as any).__probe.rw2.log()]);

test.describe('RW nested directives in rows', () => {
  test('a when() pre-rendered in a row binds its content: two bindings with a space, an attribute', async ({
    page,
  }) => {
    const probe = await mountProbe(page, 'rw2');
    await expect.poll(() => texts(page, '.rw2-pre-w')).toEqual(['John Doe', 'Jane Roe']);
    await expect(page.locator('.rw2-pre-w').first()).toHaveAttribute('title', 'John');

    const rows: RW2Row[] = [
      { id: 2, first: 'Max', last: 'Mu', on: true, tags: [] },
      { id: 1, first: 'Ann', last: 'Lee', on: false, tags: ['z'] },
    ];
    await setProbe(page, 'rw2', 'rows', rows);
    await expect.poll(() => texts(page, '.rw2-pre-w')).toEqual(['Max Mu', 'Ann Lee']);
    await setProbe(page, 'rw2', 'show', false);
    await expect(page.locator('.rw2-pre-w')).toHaveCount(0);
    await setProbe(page, 'rw2', 'show', true);
    await expect.poll(() => texts(page, '.rw2-pre-w')).toEqual(['Max Mu', 'Ann Lee']);
    await expect(page.locator('.rw2-pre-w').first()).toHaveAttribute('title', 'Max');
    expect(probe.pageErrors).toEqual([]);
  });

  test('handlers in both whenElse() branches of a row fire; .stop keeps a click from the row handler', async ({
    page,
  }) => {
    const probe = await mountProbe(page, 'rw2');
    await page.locator('.rw2-then').click();
    await page.locator('.rw2-else').click();
    await expect.poll(() => rwLog(page)).toEqual(['then1', 'row1', 'else2']);

    // Swap the branches: each row's other branch is bound when it shows
    await setProbe(page, 'rw2', 'rows', [
      { id: 1, first: 'John', last: 'Doe', on: false, tags: [] },
      { id: 2, first: 'Jane', last: 'Roe', on: true, tags: [] },
    ]);
    await page.locator('.rw2-then').click();
    await page.locator('.rw2-else').click();
    await expect.poll(() => rwLog(page)).toEqual(['then1', 'row1', 'else2', 'then2', 'row2', 'else1']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('child components in a row when() and whenElse() mount, and go and come back with their branch', async ({
    page,
  }) => {
    const probe = await mountProbe(page, 'rw2');
    await expect.poll(() => texts(page, '.rw2-kw .ckid')).toEqual(['w1', 'w2']);
    await expect.poll(() => texts(page, '.rw2-kr .ckid')).toEqual(['r1']);
    await expect.poll(() => texts(page, '.rw2-kt .ckid')).toEqual(['t1']);
    await expect.poll(() => texts(page, '.rw2-ke .ckid')).toEqual(['e2']);
    expect((await a1Counts(page)).mount).toEqual({ w1: 1, w2: 1, r1: 1, t1: 1, e2: 1 });

    // Swap the rows' conditions: each child goes with its branch, the other branch's child comes
    await setProbe(page, 'rw2', 'rows', [
      { id: 1, first: 'John', last: 'Doe', on: false, tags: [] },
      { id: 2, first: 'Jane', last: 'Roe', on: true, tags: [] },
    ]);
    await expect.poll(() => texts(page, '.rw2-kr .ckid')).toEqual(['r2']);
    await expect.poll(() => texts(page, '.rw2-kt .ckid')).toEqual(['t2']);
    await expect.poll(() => texts(page, '.rw2-ke .ckid')).toEqual(['e1']);
    expect(await a1Counts(page)).toEqual({
      mount: { w1: 1, w2: 1, r1: 1, t1: 1, e2: 1, r2: 1, t2: 1, e1: 1 },
      destroy: { r1: 1, t1: 1, e2: 1 },
    });

    await setProbe(page, 'rw2', 'show', false);
    await expect(page.locator('.rw2-kw')).toHaveCount(0);
    await setProbe(page, 'rw2', 'show', true);
    await expect.poll(() => texts(page, '.rw2-kw .ckid')).toEqual(['w1', 'w2']);
    expect((await a1Counts(page)).destroy).toEqual({ r1: 1, t1: 1, e2: 1, w1: 1, w2: 1 });

    await setProbe(page, 'rw2', 'rows', []);
    await expect(page.locator('.ckid')).toHaveCount(0);
    expect((await a1Counts(page)).destroy).toEqual({ r1: 1, t1: 1, e2: 1, w1: 2, w2: 2, r2: 1, t2: 1, e1: 1 });
    expect(probe.pageErrors).toEqual([]);
  });

  test('a whenElse() and a list inside a row when(), and a list inside a row whenElse() branch', async ({ page }) => {
    const probe = await mountProbe(page, 'rw2');
    await expect.poll(() => texts(page, '.rw2-in-then')).toEqual(['John']);
    await expect.poll(() => texts(page, '.rw2-in-else')).toEqual(['off']);
    await expect.poll(() => texts(page, '.rw2-in-tag')).toEqual(['a', 'b', 'c']);
    await expect.poll(() => texts(page, '.rw2-we-tag')).toEqual(['John:a', 'John:b']);
    await expect.poll(() => texts(page, '.rw2-we-none')).toEqual(['none']);

    await setProbe(page, 'rw2', 'rows', [
      { id: 1, first: 'Jo', last: 'Doe', on: true, tags: ['a', 'x', 'b'] },
      { id: 2, first: 'Ja', last: 'Roe', on: true, tags: ['c'] },
    ]);
    await expect.poll(() => texts(page, '.rw2-in-then')).toEqual(['Jo', 'Ja']);
    await expect.poll(() => texts(page, '.rw2-in-tag')).toEqual(['a', 'x', 'b', 'c']);
    await expect.poll(() => texts(page, '.rw2-we-tag')).toEqual(['Jo:a', 'Jo:x', 'Jo:b', 'Ja:c']);
    await expect(page.locator('.rw2-we-none')).toHaveCount(0);

    await setProbe(page, 'rw2', 'show', false);
    await expect(page.locator('.rw2-in')).toHaveCount(0);
    await setProbe(page, 'rw2', 'show', true);
    await expect.poll(() => texts(page, '.rw2-in-tag')).toEqual(['a', 'x', 'b', 'c']);
    await expect.poll(() => texts(page, '.rw2-in-then')).toEqual(['Jo', 'Ja']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('rows whose items are signals: a when() on the item signal and a binding in it', async ({ page }) => {
    const probe = await mountProbe(page, 'rw2sig');
    await expect.poll(() => texts(page, '.rw2-sig-row')).toEqual(['s1', '']);
    await page.evaluate(() => (window as any).__probe.rw2sig.set(1, { on: true }));
    await expect.poll(() => texts(page, '.rw2-sig-row')).toEqual(['s1', 's2']);
    await page.evaluate(() => (window as any).__probe.rw2sig.set(0, { name: 's1b' }));
    await expect.poll(() => texts(page, '.rw2-sig-row')).toEqual(['s1b', 's2']);
    await page.evaluate(() => (window as any).__probe.rw2sig.set(0, { on: false }));
    await expect.poll(() => texts(page, '.rw2-sig-row')).toEqual(['', 's2']);
    expect(probe.pageErrors).toEqual([]);
  });
});

type RW3Mid = { id: number; name: string; on: boolean; leaves: { id: number; n: string }[] };
type RW3Top = { id: number; title: string; mids: RW3Mid[] };

/** The rw3 probe's starting data (e2e/hardening-app/probes/rw3-nested-lists.ts), changed by `edit`. */
const rw3Tops = (edit: (tops: RW3Top[]) => void = () => {}): RW3Top[] => {
  const tops: RW3Top[] = [
    {
      id: 1,
      title: 'A',
      mids: [
        {
          id: 11,
          name: 'a1',
          on: true,
          leaves: [
            { id: 111, n: 'x' },
            { id: 112, n: 'y' },
          ],
        },
        { id: 12, name: 'a2', on: false, leaves: [] },
      ],
    },
    { id: 2, title: 'B', mids: [{ id: 21, name: 'b1', on: true, leaves: [{ id: 211, n: 'z' }] }] },
    { id: 3, title: 'C', mids: [] },
  ];
  edit(tops);
  return tops;
};
const rw3Log = (page: Page): Promise<string[]> => page.evaluate(() => [...(window as any).__probe.rw3.log()]);

test.describe('RW nested lists in rows', () => {
  test('three levels of lists: each row reads the rows above it and follows their updates', async ({ page }) => {
    const probe = await mountProbe(page, 'rw3');
    await expect.poll(() => texts(page, '.rw3-top-title')).toEqual(['A', 'B', 'C']);
    await expect.poll(() => texts(page, '.rw3-mid-name')).toEqual(['A/a1', 'A/a2', 'B/b1']);
    await expect.poll(() => texts(page, '.rw3-leaf-btn')).toEqual(['A/a1/x', 'A/a1/y', 'B/b1/z']);

    await setProbe(
      page,
      'rw3',
      'tops',
      rw3Tops((t) => {
        t[0]!.title = 'A2';
        t[0]!.mids[0]!.leaves.pop();
        t[0]!.mids[1]!.leaves.push({ id: 121, n: 'w' });
      }),
    );
    await expect.poll(() => texts(page, '.rw3-mid-name')).toEqual(['A2/a1', 'A2/a2', 'B/b1']);
    await expect.poll(() => texts(page, '.rw3-leaf-btn')).toEqual(['A2/a1/x', 'A2/a2/w', 'B/b1/z']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('handlers on every level of nested lists fire in bubbling order; .stop keeps a click in its row', async ({
    page,
  }) => {
    const probe = await mountProbe(page, 'rw3');
    await page.locator('.rw3-leaf-btn', { hasText: 'A/a1/y' }).click();
    await expect.poll(() => rw3Log(page)).toEqual(['leaf112', 'mid11', 'top1']);
    await page.locator('.rw3-leaf-stop').last().click();
    await expect.poll(() => rw3Log(page)).toEqual(['leaf112', 'mid11', 'top1', 'stop211']);
    await page.locator('.rw3-mid-name', { hasText: 'B/b1' }).click();
    await expect.poll(() => rw3Log(page)).toEqual(['leaf112', 'mid11', 'top1', 'stop211', 'mid21', 'top2']);

    // Rows created by an update are bound like the first ones
    await setProbe(
      page,
      'rw3',
      'tops',
      rw3Tops((t) => t[2]!.mids.push({ id: 31, name: 'c1', on: true, leaves: [{ id: 311, n: 'v' }] })),
    );
    await page.locator('.rw3-leaf-btn', { hasText: 'C/c1/v' }).click();
    await expect
      .poll(() => rw3Log(page))
      .toEqual(['leaf112', 'mid11', 'top1', 'stop211', 'mid21', 'top2', 'leaf311', 'mid31', 'top3']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('index bindings in inner rows follow a reorder and an insert', async ({ page }) => {
    const probe = await mountProbe(page, 'rw3');
    await expect.poll(() => texts(page, '.rw3-idx-row')).toEqual(['0:a1', '1:a2', '0:b1']);
    await setProbe(
      page,
      'rw3',
      'tops',
      rw3Tops((t) => t[0]!.mids.reverse()),
    );
    await expect.poll(() => texts(page, '.rw3-idx-row')).toEqual(['0:a2', '1:a1', '0:b1']);
    await setProbe(
      page,
      'rw3',
      'tops',
      rw3Tops((t) => t[0]!.mids.reverse().unshift({ id: 10, name: 'a0', on: true, leaves: [] })),
    );
    await expect.poll(() => texts(page, '.rw3-idx-row')).toEqual(['0:a0', '1:a2', '2:a1', '0:b1']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('child components in inner rows mount with the outer row in their props, and go with their row', async ({
    page,
  }) => {
    const probe = await mountProbe(page, 'rw3');
    await expect.poll(() => texts(page, '.rw3-kid-row .ckid')).toEqual(['A/a1', 'A/a2', 'B/b1']);
    expect((await a1Counts(page)).mount).toEqual({ 'A/a1': 1, 'A/a2': 1, 'B/b1': 1 });

    await setProbe(
      page,
      'rw3',
      'tops',
      rw3Tops((t) => {
        t[0]!.mids.pop();
        t.splice(1, 1);
      }),
    );
    await expect.poll(() => texts(page, '.rw3-kid-row .ckid')).toEqual(['A/a1']);
    expect((await a1Counts(page)).destroy).toEqual({ 'A/a2': 1, 'B/b1': 1 });

    await setProbe(page, 'rw3', 'tops', []);
    await expect(page.locator('.ckid')).toHaveCount(0);
    expect(await a1Counts(page)).toEqual({
      mount: { 'A/a1': 1, 'A/a2': 1, 'B/b1': 1 },
      destroy: { 'A/a1': 1, 'A/a2': 1, 'B/b1': 1 },
    });
    expect(probe.pageErrors).toEqual([]);
  });

  test("an inner list's empty template shows while it is empty", async ({ page }) => {
    const probe = await mountProbe(page, 'rw3');
    await expect.poll(() => texts(page, '.rw3-e-row')).toEqual(['a1', 'a2', 'b1']);
    await expect.poll(() => texts(page, '.rw3-e-none')).toEqual(['none']);
    await setProbe(
      page,
      'rw3',
      'tops',
      rw3Tops((t) => {
        t[1]!.mids = [];
        t[2]!.mids.push({ id: 31, name: 'c1', on: true, leaves: [] });
      }),
    );
    await expect.poll(() => texts(page, '.rw3-e-row')).toEqual(['a1', 'a2', 'c1']);
    await expect.poll(() => texts(page, '.rw3-e-none')).toEqual(['none']);
    await expect(page.locator('.rw3-empty > li').nth(1).locator('.rw3-e-none')).toHaveCount(1);
    expect(probe.pageErrors).toEqual([]);
  });

  test('a when() and a whenElse() in inner rows', async ({ page }) => {
    const probe = await mountProbe(page, 'rw3');
    await expect.poll(() => texts(page, '.rw3-rrw-on')).toEqual(['a1', 'b1']);
    await expect.poll(() => texts(page, '.rw3-rrw-t')).toEqual(['A', 'B']);
    await expect.poll(() => texts(page, '.rw3-rrw-f')).toEqual(['off']);
    await setProbe(
      page,
      'rw3',
      'tops',
      rw3Tops((t) => {
        t[0]!.title = 'A2';
        t[0]!.mids[1]!.on = true;
      }),
    );
    await expect.poll(() => texts(page, '.rw3-rrw-on')).toEqual(['a1', 'a2', 'b1']);
    await expect.poll(() => texts(page, '.rw3-rrw-t')).toEqual(['A2', 'A2', 'B']);
    await expect(page.locator('.rw3-rrw-f')).toHaveCount(0);
    expect(probe.pageErrors).toEqual([]);
  });

  test('repeat › whenElse › repeat › when() and whenElse()', async ({ page }) => {
    const probe = await mountProbe(page, 'rw3');
    await expect.poll(() => texts(page, '.rw3-mx-row')).toEqual(['A:a1on', 'off', 'B:b1on']);
    await setProbe(page, 'rw3', 'show', false);
    await expect.poll(() => texts(page, '.rw3-mx-hidden')).toEqual(['hidden', 'hidden', 'hidden']);
    await setProbe(
      page,
      'rw3',
      'tops',
      rw3Tops((t) => (t[0]!.mids[1]!.on = true)),
    );
    await setProbe(page, 'rw3', 'show', true);
    await expect.poll(() => texts(page, '.rw3-mx-row')).toEqual(['A:a1on', 'A:a2on', 'B:b1on']);
    expect(probe.pageErrors).toEqual([]);
  });

  test("an inner list whose item has the outer item's name reads its own item", async ({ page }) => {
    const probe = await mountProbe(page, 'rw3');
    await expect.poll(() => texts(page, '.rw3-sh-row')).toEqual(['a1', 'a2', 'b1']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('a handler of the outer row on an element after an inner list, in its container', async ({ page }) => {
    const probe = await mountProbe(page, 'rw3');
    await expect.poll(() => texts(page, '.rw3-af-row')).toEqual(['a1', 'a2', 'b1']);
    await page.locator('.rw3-af-btn').first().click();
    await page.locator('.rw3-af-btn').last().click();
    await expect.poll(() => rw3Log(page)).toEqual(['after1', 'after3']);
    expect(probe.pageErrors).toEqual([]);
  });
});

test.describe('nested lists in rows: an outer item named item', () => {
  test("a child in an inner row reads an outer row's item named `item`", async ({ page }) => {
    const probe = await mountProbe(page, 'rw3');
    await expect.poll(() => texts(page, '.rw3-oi-row .card')).toEqual(['A:a1', 'A:a2', 'B:b1']);
    await setProbe(
      page,
      'rw3',
      'tops',
      rw3Tops((t) => t[2]!.mids.push({ id: 31, name: 'c1', on: true, leaves: [] })),
    );
    await expect.poll(() => texts(page, '.rw3-oi-row .card')).toEqual(['A:a1', 'A:a2', 'B:b1', 'C:c1']);
    expect(probe.pageErrors).toEqual([]);
  });

  test('rows whose items are signals and are named `item`: inner rows read item() and follow it', async ({ page }) => {
    // Row factories used to call every row's item `item`, so an inner row's own item hid the outer one
    // and item() threw. They keep the source's names now, and scoping works as in the source.
    const probe = await mountProbe(page, 'rw3');
    await expect.poll(() => texts(page, '.rw3-si-row')).toEqual(['A/x', 'A/y', 'B/z']);
    await page.evaluate(() => (window as any).__probe.rw3.sigRows()[0]({ id: 1, name: 'C', tags: ['x', 'y'] }));
    await expect.poll(() => texts(page, '.rw3-si-row')).toEqual(['C/x', 'C/y', 'B/z']);
    expect(probe.pageErrors).toEqual([]);
  });
});

test.describe('double quotes inside attribute expressions', () => {
  test('row and component attributes whose expression holds double quotes render and update', async ({ page }) => {
    const probe = await mountProbe(page, 'quotes');
    const rows = page.locator('.hardening-quotes li');
    await expect(page.locator('.quotes-top')).toHaveAttribute('title', 'one');
    await expect(rows.nth(0)).toHaveAttribute('class', 'on');
    await expect(rows.nth(0)).toHaveAttribute('title', 'yes');
    await expect(rows.nth(0)).toHaveAttribute('data-x', 'A!');
    await expect(rows.nth(1)).toHaveAttribute('title', 'no');

    await page.evaluate(() => {
      const q = (window as any).__probe.quotes;
      q.sel(2);
      q.flag(false);
      q.items([
        { id: 1, on: false, label: 'A' },
        { id: 2, on: true, label: 'C' },
      ]);
    });
    await expect(page.locator('.quotes-top')).toHaveAttribute('title', 'two');
    await expect(rows.nth(1)).toHaveAttribute('class', 'on');
    await expect(rows.nth(0)).toHaveAttribute('title', 'no');
    await expect(rows.nth(1)).toHaveAttribute('data-x', 'C!');
    expect(probe.pageErrors).toEqual([]);
  });
});

test.describe('@namespace in a component stylesheet', () => {
  test('the namespace applies, and the rule after the statement stays scoped to the component', async ({ page }) => {
    const probe = await mountProbe(page, 'cssnamespace');
    await page.evaluate(() => {
      const outside = document.createElement('p');
      outside.className = 'ns-leak';
      outside.dataset.testid = 'ns-outside';
      outside.textContent = 'outside';
      document.body.appendChild(outside);
    });
    await expect(page.locator('#app .ns-rect')).toHaveCSS('fill', 'rgb(255, 0, 0)');
    await expect(page.locator('#app .ns-leak')).toHaveCSS('color', 'rgb(1, 2, 3)');
    await expect(page.getByTestId('ns-outside')).not.toHaveCSS('color', 'rgb(1, 2, 3)');
    expect(probe.pageErrors).toEqual([]);
  });
});

test.describe('calls to the component’s own functions in a template', () => {
  test('T1 a function follows the signals it reads, a plain one renders once, a helper follows its body', async ({
    page,
  }) => {
    const probe = await mountProbe(page, 't1');
    await expect(page.locator('.t1-label')).toHaveText('Total');
    await expect(page.locator('.t1-total')).toHaveText('6');
    await expect(page.locator('.t1-formatted')).toHaveText('2 EUR');
    await setProbe(page, 't1', 'qty', 4);
    await expect(page.locator('.t1-total')).toHaveText('8');
    await expect(page.locator('.t1-total')).toHaveAttribute('title', '8');
    await setProbe(page, 't1', 'price', 5);
    await expect(page.locator('.t1-total')).toHaveText('20');
    await expect(page.locator('.t1-formatted')).toHaveText('5 EUR');
    await setProbe(page, 't1', 'currency', 'USD');
    await expect(page.locator('.t1-formatted')).toHaveText('5 USD');
    expect(probe.pageErrors).toEqual([]);
  });
});

test.describe('several components in one file', () => {
  test("C1 the file's components mount one another, each with its own signals and styles", async ({ page }) => {
    const probe = await mountProbe(page, 'c1');
    const green = 'rgb(0, 128, 0)';
    await expect(page.locator('.c1-own')).toHaveText('1');
    await expect(page.locator('.c1-count-value')).toHaveText('3');
    await expect(page.locator('.c1-pill-text')).toHaveText(['top 2', 'a 2', 'b 2']);
    await expect(page.locator('.c1-pill-text').first()).toHaveCSS('color', green);
    await expect(page.locator('.c1-plain')).not.toHaveCSS('color', green);

    await setProbe(page, 'c1', 'items', [
      { id: 2, label: 'b' },
      { id: 3, label: 'c' },
    ]);
    await expect(page.locator('.c1-rows .c1-pill-text')).toHaveText(['b 2', 'c 2']);
    await setProbe(page, 'c1count', 'count', 4);
    await expect(page.locator('.c1-count-value')).toHaveText('4');
    await setProbe(page, 'c1', 'count', 5);
    await expect(page.locator('.c1-own')).toHaveText('5');
    await expect(page.locator('.c1-count-value')).toHaveText('4');
    expect(probe.pageErrors).toEqual([]);
  });
});

test.describe('a keyed list reordered while a row goes', () => {
  test('R1 the rows stay before the list anchor, so a later append goes last', async ({ page }) => {
    const probe = await mountProbe(page, 'r1');
    const rows = page.locator('ul.r1 > li');
    await expect(rows).toHaveText(['A', 'B', 'C', 'T']);
    await setProbe(page, 'r1', 'items', [{ id: 'C' }, { id: 'A' }]);
    await expect(rows).toHaveText(['C', 'A', 'T']);
    await setProbe(page, 'r1', 'items', [{ id: 'C' }, { id: 'A' }, { id: 'D' }]);
    await expect(rows).toHaveText(['C', 'A', 'D', 'T']);
    expect(probe.pageErrors).toEqual([]);
  });
});
