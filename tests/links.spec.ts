import { test, expect } from '@playwright/test';
import { loadLinks } from '../src/loadLinks.js';
import {
  initLinkLog,
  logLinkResult,
  printLinkSummary,
} from '../src/linkReport.js';

const linksFile = process.env.LINKS_FILE;

if (!linksFile) {
  throw new Error(
    'Переменная LINKS_FILE не задана. Запускайте тесты так: npm test -- --file путь/к/links.txt',
  );
}

const links = loadLinks(linksFile);
const checkConsoleErrors = process.env.CHECK_CONSOLE_ERRORS === 'true';

test.beforeAll(() => {
  initLinkLog();
});

test.afterAll(() => {
  printLinkSummary();
});

for (const url of links) {
  test(`страница успешно загружается: ${url}`, async ({ page }) => {
    const totalStart = performance.now();
    let loadMs = 0;
    let status: number | null = null;
    let passed = true;
    let errorMessage: string | undefined;
    const consoleErrors: string[] = [];

    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    try {
      const loadStart = performance.now();
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      loadMs = Math.round(performance.now() - loadStart);
      status = response?.status() ?? null;

      expect(response, `Не получен ответ от ${url}`).not.toBeNull();

      expect(
        status,
        `Ожидался HTTP статус < 400 для ${url}, получено ${status}`,
      ).toBeLessThan(400);

      await expect(page.locator('body')).toBeVisible();

      const title = await page.title();
      expect(
        title.trim().length,
        `Пустой заголовок страницы (title) для ${url}`,
      ).toBeGreaterThan(0);

      if (checkConsoleErrors) {
        expect(
          consoleErrors,
          `Ошибки в консоли браузера на ${url}:\n${consoleErrors.join('\n')}`,
        ).toEqual([]);
      } else if (consoleErrors.length > 0) {
        console.warn(
          `Ошибки в консоли браузера на ${url}:\n${consoleErrors.join('\n')}`,
        );
      }
    } catch (error: unknown) {
      passed = false;
      errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      logLinkResult({
        url,
        status,
        loadMs,
        totalMs: Math.round(performance.now() - totalStart),
        passed,
        error: errorMessage,
      });
    }
  });
}
