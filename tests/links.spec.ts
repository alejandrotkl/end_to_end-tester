import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { DEFAULT_LINK_TIMEOUT_MS, loadLinks } from '../src/loadLinks.js';
import { logLinkResult, simplifyErrorMessage, type LinkResult } from '../src/linkReport.js';
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

/** Куки/storage после успешного входа — следующие ссылки того же домена без повторного логина. */
const SESSION_DIR = process.env.SESSION_DIR || join(dirname(credentialsFilePathFromEnv()), 'sessions');
const loggedInDomains = new Set<string>();

const DEFAULT_USERNAME_SELECTOR =
  'input#login, input[name="login"], input[placeholder*="Логин" i], input[placeholder*="Login" i], input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="login" i], input[id*="user" i], input[id*="login" i], input[type="text"]';
const DEFAULT_PASSWORD_SELECTOR = 'input#password, input[name="password"], input[type="password"]';
const DEFAULT_SUBMIT_SELECTOR =
  'button#bind, button.bc-form-btn, button[type="submit"], input[type="submit"], button:has-text("Войти"), button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Login")';

// Адреса и заголовки, похожие на страницу входа.
// «Войти» ≠ «вход» — на ФГИС КИ title именно «Войти».
const LOGIN_URL_HINT = /log[-_]?in|sign[-_]?in|auth|sso|account|вход|войти|\/lk\b|\/blitz\b/i;
const LOGIN_TITLE_HINT = /вход|войти|login|sign\s*in|авториза/i;
const LOGIN_BODY_HINT = /вход\s+в|войти|log\s*in|sign\s*in|авториза/i;

async function frameHasPassword(frame: import('@playwright/test').Frame): Promise<boolean> {
  return (await frame.locator('input[type="password"]').count()) > 0;
}

async function hasPasswordField(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    if (await frameHasPassword(frame)) {
      return true;
    }
  }
  return false;
}

async function hasVisiblePassword(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const field = frame.locator('input[type="password"]').first();
    if ((await field.count()) > 0 && (await field.isVisible().catch(() => false))) {
      return true;
    }
  }
  return false;
}

async function hasLoginPageSignals(page: Page, opts?: { allowHiddenPassword?: boolean }): Promise<boolean> {
  // На ФГИС КИ (Blitz IdP) поле пароля сначала в DOM с размером 0×0,
  // и только через ~1–2 с становится видимым. Если URL/title уже
  // говорят «это логин» — достаточно самого наличия input[type=password].
  if (opts?.allowHiddenPassword ? await hasPasswordField(page) : await hasVisiblePassword(page)) {
    return true;
  }

  const title = await page.title();
  if (LOGIN_TITLE_HINT.test(title)) {
    return true;
  }

  const bodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
  if (LOGIN_BODY_HINT.test(bodyText) && /(логин|пароль|password|госуслуг)/.test(bodyText)) {
    return true;
  }
  // Даже без слова «пароль»: заголовок «Вход в …» + кнопка входа / Госуслуги.
  if (/вход\s+в/.test(bodyText) && /(войти|госуслуг|log\s*in)/.test(bodyText)) {
    return true;
  }

  const submit = page.locator(DEFAULT_SUBMIT_SELECTOR).first();
  if ((await submit.count()) > 0 && (await submit.isVisible().catch(() => false))) {
    const userField = page.locator(DEFAULT_USERNAME_SELECTOR).first();
    if ((await userField.count()) > 0) {
      return true;
    }
  }

  return false;
}

function urlsMatch(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const norm = (u: URL) => `${u.origin}${u.pathname.replace(/\/$/, '')}${u.search}`;
    return norm(ua) === norm(ub);
  } catch {
    return a === b;
  }
}

/**
 * Эвристика «страница на самом деле требует вход».
 * Быстрый путь: редирект на login/sso — сразу true, без длинного опроса.
 * Иначе короткий poll (до ~1.5–2.5 с) с ранним выходом при появлении формы.
 */
async function detectLoginPage(page: Page, requestedUrl: string): Promise<boolean> {
  const currentUrl = page.url();
  const redirected = !urlsMatch(currentUrl, requestedUrl);
  const urlSuggestsLogin = LOGIN_URL_HINT.test(currentUrl);
  const crossHostRedirect =
    redirected && new URL(currentUrl).hostname !== new URL(requestedUrl).hostname;

  // Редирект на IdP — почти всегда страница входа, не ждём отрисовку полей.
  if (crossHostRedirect && (urlSuggestsLogin || LOGIN_TITLE_HINT.test(await page.title().catch(() => '')))) {
    return true;
  }

  if (await hasLoginPageSignals(page, { allowHiddenPassword: urlSuggestsLogin || crossHostRedirect })) {
    return true;
  }

  const pollMs = redirected || urlSuggestsLogin ? 2500 : 1500;
  const deadline = Date.now() + pollMs;

  while (Date.now() < deadline) {
    await page.waitForTimeout(200);
    const nowUrl = page.url();
    if (
      new URL(nowUrl).hostname !== new URL(requestedUrl).hostname &&
      LOGIN_URL_HINT.test(nowUrl)
    ) {
      return true;
    }
    if (
      await hasLoginPageSignals(page, {
        allowHiddenPassword: urlSuggestsLogin || crossHostRedirect || LOGIN_URL_HINT.test(nowUrl),
      })
    ) {
      return true;
    }
  }

  return false;
}

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

function isEphemeralLoginUrl(loginUrl: string | undefined): boolean {
  if (!loginUrl) return false;
  try {
    const u = new URL(loginUrl);
    // OAuth/Blitz: state и bo — одноразовые параметры, повторный переход ломает вход.
    return (
      u.searchParams.has('state') ||
      u.searchParams.has('bo') ||
      u.searchParams.has('code_challenge') ||
      /\/blitz\//i.test(u.pathname) ||
      /openid-connect\/auth/i.test(u.pathname) ||
      /\/realms\//i.test(u.pathname)
    );
  } catch {
    return false;
  }
}

function stillOnLoginPage(pageUrl: string, title: string): boolean {
  return LOGIN_URL_HINT.test(pageUrl) || LOGIN_TITLE_HINT.test(title) || /\/blitz\/login/i.test(pageUrl);
}

/**
 * Blitz (ФГИС КИ) и похожие IdP после ввода логина делают lookup
 * «пользователь зарегистрирован?» и перерисовывают форму — пароль,
 * введённый сразу, пропадает. Ждём события (сеть/DOM), а не длинные sleep.
 */
async function waitForStableLoginForm(page: Page, cred: DomainCredential): Promise<void> {
  const password = page.locator(cred.passwordSelector || DEFAULT_PASSWORD_SELECTOR).first();
  const username = page.locator(cred.usernameSelector || DEFAULT_USERNAME_SELECTOR).first();

  await username.waitFor({ state: 'attached', timeout: 15_000 });
  await password.waitFor({ state: 'attached', timeout: 15_000 });
  await Promise.race([
    username.waitFor({ state: 'visible', timeout: 8_000 }),
    password.waitFor({ state: 'visible', timeout: 8_000 }),
  ]).catch(() => undefined);
}

async function setInputValue(locator: import('@playwright/test').Locator, value: string): Promise<void> {
  await locator.waitFor({ state: 'attached', timeout: 10_000 });
  await locator.click({ timeout: 8_000 }).catch(() => undefined);
  await locator.fill(value, { timeout: 8_000 });
  await locator.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
  }, value);
}

async function fillUsernameAndSettle(page: Page, cred: DomainCredential): Promise<void> {
  const username = page.locator(cred.usernameSelector || DEFAULT_USERNAME_SELECTOR).first();
  await setInputValue(username, cred.username);

  await username.evaluate((el) => (el as HTMLInputElement).blur()).catch(() => undefined);
  await page.keyboard.press('Tab').catch(() => undefined);

  // Lookup IdP обычно < 1–2 с; ждём затишье сети коротко, без лишней секунды sleep.
  await page.waitForLoadState('networkidle', { timeout: 2_500 }).catch(() => undefined);
  await waitForStableLoginForm(page, cred);

  const currentLogin = await page
    .locator(cred.usernameSelector || DEFAULT_USERNAME_SELECTOR)
    .first()
    .inputValue()
    .catch(() => '');
  if (currentLogin.trim() !== cred.username) {
    await setInputValue(page.locator(cred.usernameSelector || DEFAULT_USERNAME_SELECTOR).first(), cred.username);
  }
}

async function fillPasswordVerified(page: Page, cred: DomainCredential): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const username = page.locator(cred.usernameSelector || DEFAULT_USERNAME_SELECTOR).first();
    const password = page.locator(cred.passwordSelector || DEFAULT_PASSWORD_SELECTOR).first();

    await password.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
    await setInputValue(password, cred.password);

    // Короткая проверка: если IdP перерисует форму — значения пропадут.
    await page.waitForTimeout(150);

    const loginValue = await username.inputValue().catch(() => '');
    const passwordValue = await password.inputValue().catch(() => '');

    if (loginValue.trim() === cred.username && passwordValue === cred.password) {
      return;
    }

    await fillUsernameAndSettle(page, cred);
  }

  throw new Error(
    'Поля логина/пароля сбрасываются после проверки пользователя на странице входа (IdP перерисовывает форму). Попробуйте ещё раз или задайте точные CSS-селекторы.',
  );
}

/**
 * Заполняет и отправляет форму входа. Селекторы полей можно переопределить
 * в учётных данных. Важно для OAuth/Blitz (ФГИС КИ):
 *  - не уходить на сохранённый loginUrl с протухшим state;
 *  - пошагово: логин → короткий settle → пароль → Войти;
 *  - после клика ждём ухода с login-URL, без длинного networkidle.
 */
async function attemptLogin(page: Page, cred: DomainCredential): Promise<LoginAttemptInfo> {
  const alreadyOnLoginForm =
    (await hasPasswordField(page)) || LOGIN_URL_HINT.test(page.url()) || LOGIN_TITLE_HINT.test(await page.title());

  const shouldGotoLoginUrl =
    Boolean(cred.loginUrl) && !alreadyOnLoginForm && !isEphemeralLoginUrl(cred.loginUrl);

  if (shouldGotoLoginUrl && cred.loginUrl) {
    await page.goto(cred.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  await waitForStableLoginForm(page, cred);

  const urlBeforeSubmit = page.url();

  await fillUsernameAndSettle(page, cred);
  await fillPasswordVerified(page, cred);

  const submit = page.locator(cred.submitSelector || DEFAULT_SUBMIT_SELECTOR).first();
  await Promise.all([
    page
      .waitForURL((url) => !LOGIN_URL_HINT.test(url.toString()) && !/\/blitz\/login/i.test(url.toString()), {
        timeout: 30_000,
      })
      .catch(() => undefined),
    submit.click({ timeout: 8_000 }),
  ]);

  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);

  const urlAfterSubmit = page.url();
  const titleAfter = await page.title().catch(() => '');
  const likelyFailed =
    urlAfterSubmit === urlBeforeSubmit || stillOnLoginPage(urlAfterSubmit, titleAfter);

  return { urlAfterSubmit, likelyFailed };
}

function sessionFileFor(domain: string): string {
  const safe = domain.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(SESSION_DIR, `${safe}.json`);
}

async function applyDomainSession(page: Page, domain: string): Promise<boolean> {
  const file = sessionFileFor(domain);
  if (!existsSync(file)) {
    return loggedInDomains.has(domain);
  }

  try {
    const state = JSON.parse(readFileSync(file, 'utf-8')) as {
      cookies?: Array<{
        name: string;
        value: string;
        domain?: string;
        path?: string;
        expires?: number;
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: 'Strict' | 'Lax' | 'None';
      }>;
    };
    if (state.cookies?.length) {
      await page.context().addCookies(state.cookies);
      loggedInDomains.add(domain);
      return true;
    }
  } catch {
    // Повреждённый файл сессии — просто войдём заново.
  }
  return false;
}

async function saveDomainSession(page: Page, domain: string): Promise<void> {
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
    await page.context().storageState({ path: sessionFileFor(domain) });
    loggedInDomains.add(domain);
  } catch {
    // Кеш сессии — ускорение, сбой записи не должен ронять проверку.
  }
}

function credentialDomainsFor(url: string): string[] {
  const host = new URL(url).hostname.toLowerCase();
  const domains = [host];

  // login.gis.gov.ru / sso.example.com → также ищем данные для gis.gov.ru / example.com
  const parts = host.split('.');
  if (parts.length > 2 && /^(login|sso|auth|id|idp|accounts)$/i.test(parts[0])) {
    domains.push(parts.slice(1).join('.'));
  }

  return [...new Set(domains)];
}

function findCredentialForUrl(credentialsPath: string, url: string): DomainCredential | undefined {
  for (const domain of credentialDomainsFor(url)) {
    const cred = getDomainCredential(credentialsPath, domain);
    if (cred) {
      return cred;
    }
  }
  return undefined;
}

for (const linkInput of links) {
  const { url, priority, timeoutMs } = linkInput;

  test(`проверка ссылки: ${url}`, async ({ page }, testInfo) => {
    testInfo.setTimeout(Math.max(timeoutMs * 2 + 60_000, DEFAULT_LINK_TIMEOUT_MS + 60_000));

    const totalStart = performance.now();
    let loadMs = 0;
    let status: number | null = null;
    let passed = true;
    let errorMessage: string | undefined;
    let usedLogin = false;
    let needsLogin = false;
    let loginDomain: string | undefined;
    let loginPageUrl: string | undefined;
    const consoleErrors: string[] = [];
    const domain = new URL(url).hostname;

    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    try {
      // Если для домена уже был успешный вход в этом/прошлом прогоне —
      // подставляем куки до открытия страницы (без повторного логина).
      await applyDomainSession(page, domain);

      const loadStart = performance.now();
      let response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
      loadMs = Math.round(performance.now() - loadStart);
      status = response?.status() ?? null;

      // Короткая догрузка только если ещё не ушли на login-хост и форма
      // не видна — иначе зря ждём до 10 с на каждой обычной странице.
      if (
        status !== null &&
        status < 400 &&
        !LOGIN_URL_HINT.test(page.url()) &&
        !(await hasPasswordField(page))
      ) {
        await page.waitForLoadState('load', { timeout: Math.min(timeoutMs, 3_000) }).catch(() => undefined);
      }

      let loginFailure: string | undefined;
      let loginDiagnostics: string | undefined;
      let loginFormStillShown = false;
      let requiresLogin = false;

      if (status === 403) {
        requiresLogin = true;
      } else if (status !== null && status < 400 && (await detectLoginPage(page, url))) {
        requiresLogin = true;
        loginPageUrl = page.url();
      }

      if (requiresLogin) {
        loginDomain = domain;
        const credentialsPath = credentialsFilePathFromEnv();
        let cred = findCredentialForUrl(credentialsPath, url);
        if (!cred) {
          cred = findCredentialForUrl(credentialsPath, page.url());
        }

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

            // Если после входа уже на целевой странице — повторный goto не нужен.
            const alreadyOnTarget =
              urlsMatch(page.url(), url) && !stillOnLoginPage(page.url(), await page.title().catch(() => ''));

            if (!alreadyOnTarget) {
              const retryStart = performance.now();
              response = await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: timeoutMs,
              });
              loadMs = Math.round(performance.now() - retryStart);
              status = response?.status() ?? null;
            } else {
              status = response?.status() ?? status ?? 200;
            }

            if (status === 403) {
              loginDiagnostics = loginInfo.likelyFailed
                ? `после отправки формы адрес страницы не изменился (${loginInfo.urlAfterSubmit}) — вход, скорее всего, не выполнен: проверьте логин/пароль и селекторы полей (usernameSelector/passwordSelector/submitSelector), либо сайт защищён капчей/антибот-системой от автоматизации`
                : `форма была отправлена, адрес изменился на ${loginInfo.urlAfterSubmit}, но сайт всё равно вернул 403 — возможно, куки страницы входа не распространяются на домен проверяемой ссылки, или нужна дополнительная авторизация (например, роль/подписка)`;
            } else if (status !== null && status < 400 && (await detectLoginPage(page, url))) {
              loginFormStillShown = true;
              loginPageUrl = page.url();
              loginDiagnostics = loginInfo.likelyFailed
                ? `после отправки формы адрес не изменился (${loginInfo.urlAfterSubmit}), и при повторном открытии ссылки снова показана форма входа — проверьте логин/пароль и селекторы полей (usernameSelector/passwordSelector/submitSelector)`
                : `вход был отправлен (страница после формы: ${loginInfo.urlAfterSubmit}), но при повторном открытии ссылки сайт снова показал форму входа — возможно, логин/пароль неверны или сессия не сохранилась`;
            } else if (!loginInfo.likelyFailed && !loginFormStillShown) {
              await saveDomainSession(page, domain);
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

      const needsLoginMessage =
        `Страница ${url} требует вход (HTTP ${status}${status !== 403 ? ', показана форма логина' : ''}), ` +
        `но данные для домена ${loginDomain} не настроены. ` +
        'Введите логин и пароль во всплывающем окне веб-интерфейса (или через PUT /api/v1/credentials/<домен>) и повторите проверку.';

      const statusMessage = needsLogin
        ? needsLoginMessage
        : loginFailure
          ? `Не удалось выполнить вход для ${url}: ${loginFailure}`
          : loginDiagnostics
            ? `После попытки входа ссылка ${url} всё равно вернула HTTP ${status}: ${loginDiagnostics}. Также проверьте скриншот в артефактах задачи — он сделан на странице после попытки входа.`
            : `Ожидался HTTP статус < 400 для ${url}, получено ${status}`;

      expect(status, statusMessage).toBeLessThan(400);

      expect(needsLogin, needsLoginMessage).toBe(false);
      expect(
        loginFormStillShown,
        `Ссылка ${url} после попытки входа всё равно показывает форму логина: ${loginDiagnostics ?? ''}`,
      ).toBe(false);
      expect(loginFailure, `Не удалось выполнить вход для ${url}: ${loginFailure}`).toBeUndefined();

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
      errorMessage = simplifyErrorMessage(error instanceof Error ? error.message : String(error));
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
        loginDomain,
        loginPageUrl,
        priority,
        timeoutMs,
      };

      logLinkResult(result);

      await testInfo.attach('link-result', {
        body: JSON.stringify(result),
        contentType: 'application/json',
      });
    }
  });
}
