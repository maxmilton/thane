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
// writing these probes; they are not in §1.8 and have no owner yet (see the F0-3 hand-off note).
// ═══════════════════════════════════════════════════════════════════════

type Probe = {
  /** Uncaught page errors since the page was opened. */
  pageErrors: string[];
  /** Errors thrown by mounting the probe (main.ts records them instead of letting them escape). */
  mountErrors: () => Promise<string[]>;
};

const openProbe = async (page: Page, id: string, options: { manual?: boolean } = {}): Promise<Probe> => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`/?probe=${id}${options.manual ? '&manual=1' : ''}`);
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
  test.fixme('H-01 P1 a method call on the row item renders in row text', async ({ page }) => {
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

  test.fixme('H-17 P5 a child component in a whenElse() nested in a when() is mounted', async ({ page }) => {
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

  test.fixme('H-03 P12 whitespace inside <pre> is kept', async ({ page }) => {
    const probe = await mountProbe(page, 'p12');
    expect(await page.locator('.p12-pre').textContent()).toBe('line1\n    line2');
    expect(probe.pageErrors).toEqual([]);
  });

  test.fixme('H-02 P13 a backslash and an escaped interpolation in template text render literally', async ({
    page,
  }) => {
    const probe = await mountProbe(page, 'p13');
    expect(await page.locator('.p13-bs').textContent()).toBe('C:\\dir');
    expect(await page.locator('.p13-dollar').textContent()).toBe('${notExpr}');
    expect(probe.pageErrors).toEqual([]);
  });

  test.fixme('H-04 P14 hyphenated tags keep their name as a whenElse() root and with when()', async ({ page }) => {
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

  test.fixme('H-06 P15 a nested list in the row root does not reorder the outer rows', async ({ page }) => {
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

  test.fixme('H-05 P18 static siblings survive clearing a list', async ({ page }) => {
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

  test.fixme('H-19 P26a :host() with a compound argument applies only while the host matches it', async ({ page }) => {
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

  test.fixme('H-19 P26b :host-context() applies inside a matching ancestor', async ({ page }) => {
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

  test.fixme('H-19 P26c a quote in a CSS comment leaves the following rules scoped (dev build)', async ({ page }) => {
    const probe = await mountProbe(page, 'p26c');
    await expect(page.locator('#app .p26c-a')).toHaveCSS('color', 'rgb(0, 0, 255)');
    await expect(page.locator('#app .p26c-leak')).toHaveCSS('color', 'rgb(1, 2, 3)');
    await expect(page.getByTestId('p26c-outside')).not.toHaveCSS('color', 'rgb(1, 2, 3)');
    expect(probe.pageErrors).toEqual([]);
  });

  test.fixme("H-28 L1 destroying a component releases its rows' subscriptions and destroys row children", async ({
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

  test.fixme("H-28 L2 hiding a when() releases its rows' subscriptions and showing it again adds no second set", async ({
    page,
  }) => {
    const probe = await openProbe(page, 'l2', { manual: true });
    const before = await liveSubscribers(page, 'l2Tick');
    expect(await page.evaluate(() => (window as any).__mountProbe())).toBe(true);
    expect(await probe.mountErrors()).toEqual([]);
    await expect(page.locator('.l2-m')).toHaveText(['a-0', 'b-0']);
    const mounted = await liveSubscribers(page, 'l2Tick');
    expect(mounted).toBeGreaterThan(before);

    for (let round = 1; round <= 3; round++) {
      await page.evaluate(() => (window as any).__probe.l2.show(false));
      await expect(page.locator('.l2-row')).toHaveCount(0);
      expect(await liveSubscribers(page, 'l2Tick')).toBe(before);

      await page.evaluate(() => (window as any).__probe.l2.show(true));
      expect(await liveSubscribers(page, 'l2Tick')).toBe(mounted);
      await page.evaluate((tick) => (window as any).__probe.store.l2Tick(tick), round);
      await expect(page.locator('.l2-m')).toHaveText([`a-${round}`, `b-${round}`]);
    }
    expect(probe.pageErrors).toEqual([]);
  });

  test.fixme('H-29 I1 a child component in a row may use a named index in its props', async ({ page }) => {
    const probe = await mountProbe(page, 'i1');
    await expect(page.locator('.i1-row .kid')).toHaveText(['x0', 'y1']);
    expect(probe.pageErrors).toEqual([]);
  });

  test.fixme('A1-3 M1 multi-root and text-only whenElse() branches show and hide completely', async ({ page }) => {
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

  test.fixme('NEW N1 (no owner yet) child components in the rows of a repeat() inside a when() mount', async ({
    page,
  }) => {
    const probe = await mountProbe(page, 'n1');
    await expect(page.locator('.n1-row .kid')).toHaveText(['a', 'b']);

    await page.evaluate(() => (window as any).__probe.n1.show(false));
    await expect(page.locator('.n1-row')).toHaveCount(0);
    await page.evaluate(() => (window as any).__probe.n1.show(true));
    await expect(page.locator('.n1-row .kid')).toHaveText(['a', 'b']);
    expect(probe.pageErrors).toEqual([]);
  });

  test.fixme("NEW N2 (no owner yet) bindings in a row's when() on a component signal apply while it is first shown", async ({
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
});
