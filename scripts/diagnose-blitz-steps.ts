/**
 * Диагностика пошагового входа Blitz: что происходит после ввода логина.
 * GIS_USER / GIS_PASS — из окружения (не хардкодим пароль в репозиторий).
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TARGET =
  process.env.GIS_URL ||
  'https://gis.gov.ru/efo/editor/703671ca-c393-4d6d-48c9-c2546f5ddaa5';
const USER = process.env.GIS_USER || '';
const PASS = process.env.GIS_PASS || '';
const OUT = join(process.cwd(), '.tmp-blitz-step');
mkdirSync(OUT, { recursive: true });

if (!USER || !PASS) {
  console.error('Задайте GIS_USER и GIS_PASS в окружении.');
  process.exit(1);
}

async function snap(page: import('playwright').Page, label: string) {
  const data = await page.evaluate(() => {
    const pwd = document.querySelector('#password, input[type="password"]') as HTMLInputElement | null;
    const login = document.querySelector('#login, input[name="login"]') as HTMLInputElement | null;
    const bind = document.querySelector('#bind') as HTMLButtonElement | null;
    const r = pwd?.getBoundingClientRect();
    return {
      url: location.href,
      title: document.title,
      loginValue: login?.value ?? null,
      loginVisible: !!(login && login.getBoundingClientRect().width > 0),
      passwordExists: !!pwd,
      passwordValueLen: pwd?.value?.length ?? 0,
      passwordVisible: !!(r && r.width > 0 && r.height > 0),
      bindText: bind?.textContent?.trim() ?? null,
      bindDisabled: bind?.disabled ?? null,
      bodyText: (document.body?.innerText || '').slice(0, 800),
      alerts: Array.from(document.querySelectorAll('.alert, .error, .text-danger, [class*="error"], [class*="msg"]'))
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 10),
    };
  });
  writeFileSync(join(OUT, `${label}.json`), JSON.stringify(data, null, 2), 'utf-8');
  await page.screenshot({ path: join(OUT, `${label}.png`), fullPage: true }).catch(() => undefined);
  console.log(label, JSON.stringify(data));
  return data;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) {
    console.log('[nav]', frame.url());
  }
});

console.log('goto target');
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(3000);
await snap(page, '01-login-page');

const login = page.locator('#login, input[name="login"]').first();
const password = page.locator('#password, input[type="password"]').first();
const bind = page.locator('#bind, button:has-text("Войти")').first();

console.log('fill login only, wait');
await login.waitFor({ state: 'visible', timeout: 15_000 });
await login.fill(USER);
await snap(page, '02-after-login-fill');
await page.waitForTimeout(2000);
await snap(page, '03-2s-after-login-fill');

// blur / tab — часто триггерит проверку «пользователь существует»
await login.blur();
await page.waitForTimeout(2000);
await snap(page, '04-after-login-blur');

console.log('fill password');
await password.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
await password.fill(PASS);
await snap(page, '05-after-password-fill');
await page.waitForTimeout(1000);
await snap(page, '06-1s-after-password');

console.log('click Войти');
await bind.click();
await page.waitForTimeout(5000);
await snap(page, '07-after-submit');
await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
await page.waitForTimeout(3000);
await snap(page, '08-settled');

console.log('reopen target');
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(4000);
await snap(page, '09-reopen');

await browser.close();
console.log('DONE', OUT);
