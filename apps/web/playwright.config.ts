/**
 * E2E against an already running server (standalone build on :3100 in CI and locally):
 *   E2E_BASE_URL=http://127.0.0.1:3100 pnpm --filter @detaly/web e2e
 * Chromium only (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers here, `playwright install` in CI).
 * The server should run with TRUSTED_IP_HEADER=x-real-ip: every run then uses its own random
 * client ip, so repeated runs do not exhaust the daily search limit of one bucket
 * (checkout.spec.ts goes further: a fresh ip per test for the hourly checkout/cancel limits).
 * Phase 1A specs also need the server env of docs/phase-1a-implementation.md section 15:
 * APP_BASE_URL equal to E2E_BASE_URL (Origin check), RKN_NOTICE_NUMBER, LEGAL_*_VERSION with
 * published documents, PICKUP_* and ROSSKO_MODE=fixtures. Optional runner env:
 * E2E_EXPECT_INN, PICKUP_ADDRESS (exact address on the order page), E2E_WEB_LOG (server log
 * checked for the phones and names typed by checkout.spec.ts).
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
