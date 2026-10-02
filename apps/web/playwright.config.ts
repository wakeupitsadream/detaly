/**
 * E2E against an already running server (standalone build on :3100 in CI and locally):
 *   E2E_BASE_URL=http://127.0.0.1:3100 pnpm --filter @detaly/web e2e
 * Chromium only (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers here, `playwright install` in CI).
 * The server should run with TRUSTED_IP_HEADER=x-real-ip: every run then uses its own random
 * client ip, so repeated runs do not exhaust the daily search limit of one bucket.
 */
import { randomInt } from 'node:crypto';
import { defineConfig } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100';

/** Documentation range 198.18.0.0/15 (benchmarking): never a real client. */
const runIp = `198.18.${randomInt(0, 256)}.${randomInt(1, 255)}`;

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/artifacts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: {
    baseURL,
    extraHTTPHeaders: { 'X-Real-IP': runIp },
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'mobile',
      use: {
        browserName: 'chromium',
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
    {
      name: 'desktop',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});
