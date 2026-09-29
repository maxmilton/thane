/// <reference types="node" />

import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const traceMode = process.env.PW_E2E_TRACE === '1' ? 'on' : 'retain-on-failure';
const headedMode = process.env.PW_E2E_HEADED === '1';
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

// Every e2e port derives from E2E_PORT_BASE (default 4173), so that several runs can share a machine:
// contract base+0, router base+1, cart base+2, hardening base+3, meta base+4, their production builds
// base+10 to base+14, and the browser-error and hot-update dev servers base+145 and base+146 (server.ts and the
// two specs read the same variable).
const portBase = process.env.E2E_PORT_BASE ? Number(process.env.E2E_PORT_BASE) : 4173;
if (!Number.isInteger(portBase) || portBase < 1024 || portBase + 145 > 65535) {
  throw new Error(`E2E_PORT_BASE must be an integer from 1024 to 65390, got "${process.env.E2E_PORT_BASE}"`);
}
const appUrl = (offset: number) => `http://127.0.0.1:${portBase + offset}`;

// The apps under test, each built twice: for development into e2e/.build, and with --prod into
// e2e/.build-prod, served PROD_OFFSET ports higher (server.ts).
const PROD_OFFSET = 10;
const apps = [
  {
    name: 'contract',
    args: '--entry ./e2e/contract-app/main.ts --html ./e2e/contract-app/index.html --assets ./e2e/contract-app/assets',
  },
  { name: 'router', args: '--entry ./e2e/router-app/main.ts --html ./e2e/router-app/index.html' },
  { name: 'cart', args: '--entry ./e2e/cart-app/main.ts --html ./e2e/cart-app/index.html' },
  { name: 'hardening', args: '--entry ./e2e/hardening-app/main.ts --html ./e2e/hardening-app/index.html' },
  { name: 'meta', args: '--entry ./e2e/meta-app/main.ts --html ./e2e/meta-app/index.html' },
];
const browsers = [
  ['chromium', 'Desktop Chrome'],
  ['firefox', 'Desktop Firefox'],
  ['webkit', 'Desktop Safari'],
] as const;

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  reporter: [['list']],
  use: {
    trace: traceMode,
    screenshot: 'only-on-failure',
    headless: !headedMode,
  },
  webServer: {
    cwd: repoRoot,
    command: [
      'bun run build',
      ...apps.flatMap((app) => [
        `bun ./dist/compiler/cli/thane.js build ${app.args} --out ./e2e/.build/${app.name}`,
        `bun ./dist/compiler/cli/thane.js build --prod ${app.args} --out ./e2e/.build-prod/${app.name}`,
      ]),
      'bun ./e2e/server.ts',
    ].join(' && '),
    env: { E2E_PORT_BASE: String(portBase) },
    url: appUrl(0),
    reuseExistingServer: false,
    timeout: 90_000,
  },
  projects: [
    ...browsers.map(([browser, device]) => ({
      name: `contract-${browser}`,
      testIgnore: [
        'router.spec.ts',
        'cart.spec.ts',
        'browser-error.spec.ts',
        'hot-update.spec.ts',
        'hardening.spec.ts',
        'meta.spec.ts',
      ],
      use: { ...devices[device], baseURL: appUrl(0) },
    })),
    ...(['router', 'cart', 'hardening', 'meta'] as const).flatMap((suite, i) =>
      browsers.map(([browser, device]) => ({
        name: `${suite}-${browser}`,
        testMatch: `${suite}.spec.ts`,
        use: { ...devices[device], baseURL: appUrl(i + 1) },
      })),
    ),
    {
      name: 'browser-error-chromium',
      testMatch: 'browser-error.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    // `thane dev` swaps a changed component in the open page: it starts its own dev server
    {
      name: 'hot-chromium',
      testMatch: 'hot-update.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    // The same apps built with --prod (minified templates, selectors and JavaScript), in Chromium.
    {
      name: 'contract-prod-chromium',
      testIgnore: [
        'router.spec.ts',
        'cart.spec.ts',
        'browser-error.spec.ts',
        'hot-update.spec.ts',
        'hardening.spec.ts',
        'meta.spec.ts',
      ],
      use: { ...devices['Desktop Chrome'], baseURL: appUrl(PROD_OFFSET) },
    },
    ...(['router', 'cart', 'hardening', 'meta'] as const).map((suite, i) => ({
      name: `${suite}-prod-chromium`,
      testMatch: `${suite}.spec.ts`,
      use: { ...devices['Desktop Chrome'], baseURL: appUrl(PROD_OFFSET + i + 1) },
    })),
  ],
});
