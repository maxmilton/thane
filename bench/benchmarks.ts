/**
 * The benchmark definitions: the same operations, warm-up sequences, CPU throttling
 * factors and iteration counts as `webdriver-ts/src/benchmarksPlaywright.ts` and
 * `benchmarksCommon.ts` in krausest/js-framework-benchmark, so a number produced here
 * means the same thing as the matching number on the public results page.
 */

import type { Page } from '@playwright/test';

export interface CpuBenchmark {
  type: 'cpu';
  id: string;
  label: string;
  /** CPU slowdown applied while the measured operation runs, as in the official runner. */
  throttle: number | undefined;
  /** Iterations added on top of the configured count (the official runner does this for select row). */
  extraIterations: number;
  init(page: Page): Promise<void>;
  run(page: Page): Promise<void>;
}

export interface MemBenchmark {
  type: 'memory';
  id: string;
  label: string;
  init(page: Page): Promise<void>;
  run(page: Page): Promise<void>;
}

export type Benchmark = CpuBenchmark | MemBenchmark;

// ---------------------------------------------------------------------------
// Page helpers (port of playwrightAccess.ts). They poll briefly instead of
// waiting on locators so the interaction pattern matches the official runner.
// ---------------------------------------------------------------------------

const backoff = (page: Page, attempt: number) => page.waitForTimeout(attempt < 3 ? 10 : 1000);

async function checkElementExists(page: Page, selector: string): Promise<void> {
  for (let k = 0; k < 10; k++) {
    const el = await page.$(selector);
    if (el) {
      await el.dispose();
      return;
    }
    await backoff(page, k);
  }
  throw new Error(`checkElementExists failed for ${selector}`);
}

async function checkElementNotExists(page: Page, selector: string): Promise<void> {
  for (let k = 0; k < 10; k++) {
    const el = await page.$(selector);
    if (!el) return;
    await el.dispose();
    await backoff(page, k);
  }
  throw new Error(`checkElementNotExists failed for ${selector}`);
}

async function clickElement(page: Page, selector: string): Promise<void> {
  const el = await page.$(selector);
  if (!el) throw new Error(`clickElement ${selector} failed: element not found`);
  await el.click();
  await el.dispose();
}

async function checkElementContainsText(page: Page, selector: string, expected: string): Promise<void> {
  let text: string | undefined;
  for (let k = 0; k < 10; k++) {
    const el = await page.$(selector);
    if (el) {
      text = await el.innerText();
      await el.dispose();
      if (text.includes(expected)) return;
    }
    await backoff(page, k);
  }
  throw new Error(`checkElementContainsText ${selector} failed: expected "${expected}", found "${text}"`);
}

async function checkElementHasClass(page: Page, selector: string, className: string): Promise<void> {
  for (let k = 0; k < 10; k++) {
    const el = await page.$(selector);
    if (el) {
      const has = await el.evaluate((e, cls) => e.classList.contains(cls), className);
      await el.dispose();
      if (has) return;
    }
    await backoff(page, k);
  }
  throw new Error(`checkElementHasClass ${selector} failed: expected class "${className}"`);
}

async function checkCountForSelector(page: Page, selector: string, expected: number): Promise<void> {
  const count = (await page.$$(selector)).length;
  if (count !== expected)
    throw new Error(`checkCountForSelector ${selector} failed: expected ${expected}, found ${count}`);
}

// ---------------------------------------------------------------------------
// Shared sequences
// ---------------------------------------------------------------------------

const ROW = (n: number) => `tbody>tr:nth-of-type(${n})`;
const ID_CELL = (n: number) => `${ROW(n)}>td:nth-of-type(1)`;
const LABEL_LINK = (n: number) => `${ROW(n)}>td:nth-of-type(2)>a`;
const REMOVE_ICON = (n: number) => `${ROW(n)}>td:nth-of-type(3)>a>span:nth-of-type(1)`;

/** Creates and clears 1,000 rows `count` times so the JIT is warm and ids advance predictably. */
async function warmupCreateClear(page: Page, count: number): Promise<void> {
  await checkElementExists(page, '#run');
  for (let i = 0; i < count; i++) {
    await clickElement(page, '#run');
    await checkElementContainsText(page, ID_CELL(1), String(i * 1000 + 1));
    await clickElement(page, '#clear');
    await checkElementNotExists(page, ID_CELL(1000));
  }
}

const WARMUP = 5;

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

export const benchmarks: Benchmark[] = [
  {
    type: 'cpu',
    id: '01_run1k',
    label: 'create rows',
    throttle: undefined,
    extraIterations: 0,
    async init(page) {
      await warmupCreateClear(page, WARMUP);
    },
    async run(page) {
      await clickElement(page, '#run');
      await checkElementContainsText(page, ID_CELL(1000), String((WARMUP + 1) * 1000));
    },
  },
  {
    type: 'cpu',
    id: '02_replace1k',
    label: 'replace all rows',
    throttle: undefined,
    extraIterations: 0,
    async init(page) {
      await checkElementExists(page, '#run');
      for (let i = 0; i < WARMUP; i++) {
        await clickElement(page, '#run');
        await checkElementContainsText(page, ID_CELL(1), String(i * 1000 + 1));
      }
    },
    async run(page) {
      await clickElement(page, '#run');
      await checkElementContainsText(page, ID_CELL(1), String(WARMUP * 1000 + 1));
    },
  },
  {
    type: 'cpu',
    id: '03_update10th1k_x16',
    label: 'partial update',
    throttle: 4,
    extraIterations: 0,
    async init(page) {
      await checkElementExists(page, '#run');
      await clickElement(page, '#run');
      await checkElementExists(page, ID_CELL(1000));
      for (let i = 0; i < 3; i++) {
        await clickElement(page, '#update');
        await checkElementContainsText(page, LABEL_LINK(991), ' !!!'.repeat(i + 1));
      }
    },
    async run(page) {
      await clickElement(page, '#update');
      await checkElementContainsText(page, LABEL_LINK(991), ' !!!'.repeat(4));
    },
  },
  {
    type: 'cpu',
    id: '04_select1k',
    label: 'select row',
    throttle: 4,
    extraIterations: 10,
    async init(page) {
      await checkElementExists(page, '#run');
      await clickElement(page, '#run');
      await checkElementContainsText(page, ID_CELL(1000), '1000');
      await clickElement(page, LABEL_LINK(5));
      await checkElementHasClass(page, ROW(5), 'danger');
      await checkCountForSelector(page, 'tbody>tr.danger', 1);
    },
    async run(page) {
      await clickElement(page, LABEL_LINK(2));
      await checkElementHasClass(page, ROW(2), 'danger');
    },
  },
  {
    type: 'cpu',
    id: '05_swap1k',
    label: 'swap rows',
    throttle: 4,
    extraIterations: 0,
    async init(page) {
      await checkElementExists(page, '#run');
      await clickElement(page, '#run');
      await checkElementExists(page, ID_CELL(1000));
      for (let i = 0; i <= WARMUP; i++) {
        await clickElement(page, '#swaprows');
        await checkElementContainsText(page, ID_CELL(999), i % 2 === 0 ? '2' : '999');
      }
    },
    async run(page) {
      await clickElement(page, '#swaprows');
      await checkElementContainsText(page, ID_CELL(999), WARMUP % 2 === 0 ? '999' : '2');
      await checkElementContainsText(page, ID_CELL(2), WARMUP % 2 === 0 ? '2' : '999');
    },
  },
  {
    type: 'cpu',
    id: '06_remove-one-1k',
    label: 'remove row',
    throttle: 2,
    extraIterations: 0,
    async init(page) {
      const skip = 4;
      await checkElementExists(page, '#run');
      await clickElement(page, '#run');
      await checkElementExists(page, ID_CELL(1000));
      for (let i = 0; i < WARMUP; i++) {
        const row = WARMUP - i + skip;
        await checkElementContainsText(page, ID_CELL(row), String(row));
        await clickElement(page, REMOVE_ICON(row));
        await checkElementContainsText(page, ID_CELL(row), String(skip + WARMUP + 1));
      }
      await checkElementContainsText(page, ID_CELL(skip + 1), String(skip + WARMUP + 1));
      await checkElementContainsText(page, ID_CELL(skip), String(skip));
      // Remove a row a second time so the remove path is warm on its own
      await checkElementContainsText(page, ID_CELL(skip + 2), String(skip + WARMUP + 2));
      await clickElement(page, REMOVE_ICON(skip + 2));
      await checkElementContainsText(page, ID_CELL(skip + 2), String(skip + WARMUP + 3));
    },
    async run(page) {
      const skip = 4;
      await clickElement(page, REMOVE_ICON(skip));
      await checkElementContainsText(page, ID_CELL(skip), String(skip + WARMUP + 1));
    },
  },
  {
    type: 'cpu',
    id: '07_create10k',
    label: 'create many rows',
    throttle: undefined,
    extraIterations: 0,
    async init(page) {
      await warmupCreateClear(page, WARMUP);
    },
    async run(page) {
      await clickElement(page, '#runlots');
      await checkElementExists(page, LABEL_LINK(10000));
    },
  },
  {
    type: 'cpu',
    id: '08_create1k-after1k_x2',
    label: 'append rows to large table',
    throttle: undefined,
    extraIterations: 0,
    async init(page) {
      await warmupCreateClear(page, WARMUP);
      await clickElement(page, '#run');
      await checkElementExists(page, ID_CELL(1000));
    },
    async run(page) {
      await clickElement(page, '#add');
      await checkElementExists(page, ID_CELL(2000));
    },
  },
  {
    type: 'cpu',
    id: '09_clear1k_x8',
    label: 'clear rows',
    throttle: 4,
    extraIterations: 0,
    async init(page) {
      await warmupCreateClear(page, WARMUP);
      await clickElement(page, '#run');
      await checkElementContainsText(page, ID_CELL(1), String(WARMUP * 1000 + 1));
    },
    async run(page) {
      await clickElement(page, '#clear');
      await checkElementNotExists(page, ID_CELL(1000));
    },
  },
  {
    type: 'memory',
    id: '21_ready-memory',
    label: 'ready memory',
    async init(page) {
      await checkElementExists(page, '#run');
    },
    async run() {},
  },
  {
    type: 'memory',
    id: '22_run-memory',
    label: 'run memory',
    async init(page) {
      await checkElementExists(page, '#run');
    },
    async run(page) {
      await clickElement(page, '#run');
      await checkElementExists(page, LABEL_LINK(1));
    },
  },
  {
    type: 'memory',
    id: '25_run-clear-memory',
    label: 'creating/clearing 1k rows (5 cycles)',
    async init(page) {
      await checkElementExists(page, '#run');
    },
    async run(page) {
      for (let i = 0; i < 5; i++) {
        await clickElement(page, '#run');
        await checkElementContainsText(page, ID_CELL(1000), String(1000 * (i + 1)));
        await clickElement(page, '#clear');
        await checkElementNotExists(page, ID_CELL(1000));
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Nested app (bench/app-nested, `--app nested`): rows with a `when()` and an inner
// `repeat()` of 3 items. Not part of the official benchmark; warm-ups and throttling
// follow the closest standard operation.
// ---------------------------------------------------------------------------

const WHEN_TEXT = (n: number) => `${ROW(n)}>td:nth-of-type(2)>span`;
const INNER_ITEM = (n: number, k: number) => `${ROW(n)}>td:nth-of-type(3)>div>span:nth-of-type(${k})`;
/** Text of the first inner item after `g` "replace inner lists" clicks (see bench/app-nested/nested.ts). */
const GENERATION = (g: number) => `[g${g}] c0`;

export const nestedBenchmarks: Benchmark[] = [
  {
    type: 'cpu',
    id: 'N1_create1k_nested',
    label: 'create rows with nested directives',
    throttle: undefined,
    extraIterations: 0,
    async init(page) {
      await warmupCreateClear(page, WARMUP);
    },
    async run(page) {
      await clickElement(page, '#run');
      await checkElementContainsText(page, ID_CELL(1000), String((WARMUP + 1) * 1000));
    },
  },
  {
    type: 'cpu',
    id: 'N2_toggle10th_nested',
    label: "flip every 10th row's when()",
    throttle: 4,
    extraIterations: 0,
    async init(page) {
      await checkElementExists(page, '#run');
      await clickElement(page, '#run');
      await checkElementExists(page, ID_CELL(1000));
      for (let i = 0; i < 3; i++) {
        await clickElement(page, '#toggle');
        if (i % 2 === 0) await checkElementNotExists(page, WHEN_TEXT(991));
        else await checkElementExists(page, WHEN_TEXT(991));
      }
    },
    async run(page) {
      // Three flips in init leave every 10th row hidden; this one shows them again
      await clickElement(page, '#toggle');
      await checkElementExists(page, WHEN_TEXT(991));
    },
  },
  {
    type: 'cpu',
    id: 'N3_inner10th_nested',
    label: 'replace the inner list of every 10th row',
    throttle: 4,
    extraIterations: 0,
    async init(page) {
      await checkElementExists(page, '#run');
      await clickElement(page, '#run');
      await checkElementExists(page, ID_CELL(1000));
      for (let i = 0; i < 3; i++) {
        await clickElement(page, '#inner');
        await checkElementContainsText(page, INNER_ITEM(991, 1), GENERATION(i + 1));
      }
    },
    async run(page) {
      await clickElement(page, '#inner');
      await checkElementContainsText(page, INNER_ITEM(991, 1), GENERATION(4));
    },
  },
  {
    type: 'cpu',
    id: 'N4_swap_nested',
    label: 'swap rows 2 and 999',
    throttle: 4,
    extraIterations: 0,
    async init(page) {
      await checkElementExists(page, '#run');
      await clickElement(page, '#run');
      await checkElementExists(page, ID_CELL(1000));
      for (let i = 0; i <= WARMUP; i++) {
        await clickElement(page, '#swaprows');
        await checkElementContainsText(page, ID_CELL(999), i % 2 === 0 ? '2' : '999');
      }
    },
    async run(page) {
      await clickElement(page, '#swaprows');
      await checkElementContainsText(page, ID_CELL(999), WARMUP % 2 === 0 ? '999' : '2');
      await checkElementContainsText(page, ID_CELL(2), WARMUP % 2 === 0 ? '2' : '999');
    },
  },
  {
    type: 'cpu',
    id: 'N5_clear_nested',
    label: 'clear rows with nested directives',
    throttle: 4,
    extraIterations: 0,
    async init(page) {
      await warmupCreateClear(page, WARMUP);
      await clickElement(page, '#run');
      await checkElementContainsText(page, ID_CELL(1), String(WARMUP * 1000 + 1));
    },
    async run(page) {
      await clickElement(page, '#clear');
      await checkElementNotExists(page, ID_CELL(1000));
    },
  },
  {
    type: 'memory',
    id: 'N6_run-memory_nested',
    label: 'memory after creating rows with nested directives',
    async init(page) {
      await checkElementExists(page, '#run');
    },
    async run(page) {
      await clickElement(page, '#run');
      await checkElementExists(page, INNER_ITEM(1, 1));
    },
  },
];

export const benchmarkById = new Map([...benchmarks, ...nestedBenchmarks].map((b) => [b.id, b]));
