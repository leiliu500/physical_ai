import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1080 } } },
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: [
    {
      command: 'node build/tests/support/browser-server.js',
      url: 'http://127.0.0.1:4173/health/live',
      reuseExistingServer: false,
      timeout: 15000,
    },
    {
      command: 'node build/scripts/preview-simulation.js',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: false,
      timeout: 15000,
    },
  ],
});
