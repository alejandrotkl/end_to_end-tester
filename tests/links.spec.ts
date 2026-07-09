import { test, expect, type Page } from '@playwright/test';
import { DEFAULT_LINK_TIMEOUT_MS, loadLinks } from '../src/loadLinks.js';
import { logLinkResult, type LinkResult } from '../src/linkReport.js';
import {
  credentialsFilePathFromEnv,
  getDomainCredential,
  saveDomainCredential,
  type DomainCredential,
} from '../src/credentialStore.js';
import { promptForCredential } from '../src/credentialPrompt.js';

const linksFile = process.env.LINKS_FILE;

if (!linksFile) {
  throw new Error(
    'Переменная LINKS_FILE не задана. Запускайте тесты так: npm test -- --file путь/к/links.txt',
  );
}

const links = loadLinks(linksFile);
const checkConsoleErrors = process.env.CHECK_CONSOLE_ERRORS === 'true';

// Интерактивный запрос данных для входа доступен только там, где к процессу
// подключён настоящий терминал (консольный режим, src/run.ts). На сервере
// (src/server/jobRunner.ts) стандартный ввод не подключён, там используются
// только заранее сохранённые данные (см. credentialStore.ts).
const interactiveLogin = process.env.INTERACTIVE_LOGIN === 'true';

const DEFAULT_USERNAME_SELECTOR =
  'input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="login" i], input[id*="user" i], input[id*="login" i], input[type="text"]';
const DEFAULT_PASSWORD_SELECTOR = 'input[type="password"]';
const DEFAULT_SUBMIT_SELECTOR =
  'button[type="submit"], input[type="submit"], button:has-text("Войти"), button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Login")';

interface LoginAttemptInfo {
  urlAfterSubmit: string;
  /**
   * Эвристика: если после отправки формы адрес страницы не поменялся
   * (остались на той же странице входа), вход, скорее всего, не выполнен —
   * неверные логин/пароль, капча/антибот-защита или форма отправляется
   * через AJAX без перехода (тогда простое сравнение URL ничего не скажет,
   * но других общих признаков успеха без знания конкретного сайта нет).
   */
  likelyFailed: boolean;
}

/**
 * Заполняет и отправляет форму входа на странице cred.loginUrl. Селекторы
 * полей можно переопределить в самих учётных данных (usernameSelector и
 * т.д.) — по умолчанию используется эвристика, покрывающая большинство
 * типовых форм логина.
 */
async function attemptLogin(page: Page, cred: DomainCredential): Promise<LoginAttemptInfo> {
  await page.goto(cred.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const urlBeforeSubmit = page.url();

  await page
    .locator(cred.usernameSelector || DEFAULT_USERNAME_SELECTOR)
    .first()
    .fill(cred.username, { timeout: 10_000 });

  await page
    .locator(cred.passwordSelector || DEFAULT_PASSWORD_SELECTOR)
    .first()
    .fill(cred.password, { timeout: 10_000 });

  await page
    .locator(cred.submitSelector || DEFAULT_SUBMIT_SELECTOR)
    .first()
    .click({ timeout: 10_000 });

  // После отправки формы происходит переход/перерисовка страницы — ждём
  // загрузки, но не считаем ошибкой, если она не укладывается в таймаут
  // (некоторые сайты обновляют содержимое без полноценной навигации).
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);

  const urlAfterSubmit = page.url();

  return { urlAfterSubmit, likelyFailed: urlAfterSubmit === urlBeforeSubmit };
}

for (const linkInput of links) {
  const { url, priority, timeoutMs } = linkInput;

  test(`проверка ссылки: ${url}`, async ({ page }, testInfo) => {
    // Общий таймаут теста должен покрывать не только загрузку страницы
    // (timeoutMs), но и попытку входа при 403 и повторную проверку —
    // поэтому увеличиваем его только когда ссылке задан таймаут больше
    // стандартного (иначе используется общий timeout из playwright.config.ts).
    if (timeoutMs > DEFAULT_LINK_TIMEOUT_MS) {
      testInfo.setTimeout(timeoutMs * 2 + 30_000);
    }

    const totalStart = performance.now();
    let loadMs = 0;
    let status: number | null = null;
    let passed = true;
    let errorMessage: string | undefined;
    let usedLogin = false;
    let needsLogin = false;
    const consoleErrors: string[] = [];

    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    try {
      const loadStart = performance.now();
      let response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
      loadMs = Math.round(performance.now() - loadStart);
      status = response?.status() ?? null;

      let loginFailure: string | undefined;
      let loginDiagnostics: string | undefined;

      if (status === 403) {
        const domain = new URL(url).hostname;
        const credentialsPath = credentialsFilePathFromEnv();
        let cred = getDomainCredential(credentialsPath, domain);

        if (!cred && interactiveLogin) {
          cred = await promptForCredential(domain);

          if (cred) {
            saveDomainCredential(credentialsPath, cred);
          }
        }

        if (cred) {
          usedLogin = true;

          try {
            const loginInfo = await attemptLogin(page, cred);
            console.log(
              `[вход] ${domain}: страница после отправки формы — ${loginInfo.urlAfterSubmit}` +
                (loginInfo.likelyFailed ? ' (адрес не изменился, вход мог не выполниться)' : ''),
            );

            const retryStart = performance.now();
            response = await page.goto(url, {
              waitUntil: 'domcontentloaded',
              timeout: timeoutMs,
            });
            loadMs = Math.round(performance.now() - retryStart);
            status = response?.status() ?? null;

            if (status === 403) {
              loginDiagnostics = loginInfo.likelyFailed
                ? `после отправки формы адрес страницы не изменился (${loginInfo.urlAfterSubmit}) — вход, скорее всего, не выполнен: проверьте логин/пароль и селекторы полей (usernameSelector/passwordSelector/submitSelector), либо сайт защищён капчей/антибот-системой от автоматизации`
                : `форма была отправлена, адрес изменился на ${loginInfo.urlAfterSubmit}, но сайт всё равно вернул 403 — возможно, куки страницы входа не распространяются на домен проверяемой ссылки, или нужна дополнительная авторизация (например, роль/подписка)`;
            }
          } catch (loginError: unknown) {
            loginFailure =
              loginError instanceof Error ? loginError.message : String(loginError);
          }
        } else {
          needsLogin = true;
        }
      }

      expect(response, `Не получен ответ от ${url}`).not.toBeNull();

      const statusMessage = needsLogin
        ? `Страница ${url} требует вход (HTTP ${status}), но данные для домена ${new URL(url).hostname} не настроены. ` +
          'Настройте их через веб-интерфейс/API (PUT /api/v1/credentials/<домен>) или запустите проверку в консоли (npm test) для интерактивного ввода.'
        : loginFailure
          ? `Не удалось выполнить вход для ${url}: ${loginFailure}`
          : loginDiagnostics
            ? `После попытки входа ссылка ${url} всё равно вернула HTTP ${status}: ${loginDiagnostics}. Также проверьте скриншот в артефактах задачи — он сделан на странице после попытки входа.`
            : `Ожидался HTTP статус < 400 для ${url}, получено ${status}`;

      expect(status, statusMessage).toBeLessThan(400);

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
      const result: LinkResult = {
        url,
        status,
        loadMs,
        totalMs: Math.round(performance.now() - totalStart),
        passed,
        error: errorMessage,
        usedLogin,
        needsLogin,
        priority,
        timeoutMs,
      };

      logLinkResult(result);

      // Передаём результат репортеру через attachment, а не через
      // переменную в памяти теста: репортер живёт в отдельном, всегда едином
      // процессе на весь прогон, в отличие от воркера этого теста.
      await testInfo.attach('link-result', {
        body: JSON.stringify(result),
        contentType: 'application/json',
      });
    }
  });
}
