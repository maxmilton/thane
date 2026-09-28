/// <reference types="node" />

import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const traceMode = process.env.PW_E2E_TRACE === '1' ? 'on' : 'retain-on-failure';
const headedMode = process.env.PW_E2E_HEADED === '1';
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

// Every e2e port derives from E2E_PORT_BASE (default 4173), so that several runs can share a machine:
// contract base+0, router base+1, cart base+2, hardening base+3, browser-error dev server base+145
// (server.ts and browser-error.spec.ts read the same variable).
const portBase = process.env.E2E_PORT_BASE ? Number(process.env.E2E_PORT_BASE) : 4173;
if (!Number.isInteger(portBase) || portBase < 1024 || portBase + 145 > 65535) {
  throw new Error(`E2E_PORT_BASE must be an integer from 1024 to 65390, got "${process.env.E2E_PORT_BASE}"`);
}
const appUrl = (offset: number) => `http://127.0.0.1:${portBase + offset}`;

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
      'bun ./dist/compiler/cli/thane.js build --entry ./e2e/contract-app/main.ts --out ./e2e/.build/contract --html ./e2e/contract-app/index.html --assets ./e2e/contract-app/assets',
      'bun ./dist/compiler/cli/thane.js build --entry ./e2e/router-app/main.ts --out ./e2e/.build/router --html ./e2e/router-app/index.html',
      'bun ./dist/compiler/cli/thane.js build --entry ./e2e/cart-app/main.ts --out ./e2e/.build/cart --html ./e2e/cart-app/index.html',
      'bun ./dist/compiler/cli/thane.js build --entry ./e2e/hardening-app/main.ts --out ./e2e/.build/hardening --html ./e2e/hardening-app/index.html',
      'bun ./e2e/server.ts',
    ].join(' && '),
    env: { E2E_PORT_BASE: String(portBase) },
    url: appUrl(0),
    reuseExistingServer: false,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'contract-chromium',
      testIgnore: ['router.spec.ts', 'cart.spec.ts', 'browser-error.spec.ts', 'hardening.spec.ts'],
      use: { ...devices['Desktop Chrome'], baseURL: appUrl(0) },
    },
    {
      name: 'contract-firefox',
      testIgnore: ['router.spec.ts', 'cart.spec.ts', 'browser-error.spec.ts', 'hardening.spec.ts'],
      use: { ...devices['Desktop Firefox'], baseURL: appUrl(0) },
    },
    {
      name: 'contract-webkit',
      testIgnore: ['router.spec.ts', 'cart.spec.ts', 'browser-error.spec.ts', 'hardening.spec.ts'],
      use: { ...devices['Desktop Safari'], baseURL: appUrl(0) },
    },
    {
      name: 'router-chromium',
      testMatch: 'router.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: appUrl(1) },
    },
    {
      name: 'cart-chromium',
      testMatch: 'cart.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: appUrl(2) },
    },
    {
      name: 'hardening-chromium',
      testMatch: 'hardening.spec.ts',
      use: { ...devices['Desktop Chrome'], baseURL: appUrl(3) },
    },
    {
      name: 'browser-error-chromium',
      testMatch: 'browser-error.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
