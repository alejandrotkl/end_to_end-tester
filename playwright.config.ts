import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

// Скриншоты падений тоже кладём в LOG_DIR, если он задан (API-сервер
// выставляет его для изоляции каждой задачи): иначе при нескольких
// одновременных задачах их артефакты собирались бы в общей test-results/
// и могли бы перезаписывать друг друга.
const outputDir = process.env.LOG_DIR ? join(process.env.LOG_DIR, 'artifacts') : 'test-results';

export default defineConfig({
  testDir: './tests',
  outputDir,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['./src/russianReporter.ts']],
  globalSetup: './src/globalSetup.ts',
  use: {
    headless: true,
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  timeout: 60_000,
});
