/**
 * Диагностика страницы ГИС: что видит Playwright без входа и после.
 * Запуск: npx tsx scripts/diagnose-gis.ts
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const TARGET =
  process.env.GIS_URL ||
  'https://gis.gov.ru/efo/editor/703671ca-c393-4d6d-48c9-c2546f5ddaa5';
const USER = process.env.GIS_USER || '';
const PASS = process.env.GIS_PASS || '';
const OUT = join(process.cwd(), '.tmp-gis-diag');

mkdirSync(OUT, { recursive: true });

function dump(name: string, data: unknown) {
  writeFileSync(join(OUT, name), JSON.stringify(data, null, 2), 'utf-8');
  console.log(`wrote ${name}`);
}

async function snapshot(page: import('playwright').Page, label: string) {
  const frames = [];
  for (const frame of page.frames()) {
    const info = await frame
      .evaluate(() => {
        const passwords = Array.from(document.querySelectorAll('input[type="password"]')).map(
          (el) => {
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return {
              name: el.getAttribute('name'),
              id: el.id,
              visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
              rect: { w: r.width, h: r.height, t: r.top, l: r.left },
            };
          },
        );
        const texts = Array.from(document.querySelectorAll('input[type="text"], input[type="email"], input:not([type])')).map(
          (el) => ({
            name: el.getAttribute('name'),
            id: el.id,
            type: el.getAttribute('type'),
            placeholder: el.getAttribute('placeholder'),
            autocomplete: el.getAttribute('autocomplete'),
          }),
        );
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a')).slice(0, 40).map(
          (el) => ({
            tag: el.tagName,
            type: el.getAttribute('type'),
            text: (el.textContent || '').trim().slice(0, 80),
            href: el.getAttribute('href'),
            id: el.id,
            className: el.className?.toString?.().slice(0, 120),
          }),
        );
        return {
          url: location.href,
          title: document.title,
          passwordCount: passwords.length,
          passwords,
          textInputs: texts,
          buttons,
          bodyText: (document.body?.innerText || '').slice(0, 1500),
          iframeCount: document.querySelectorAll('iframe').length,
          htmlSnippet: document.documentElement.outerHTML.slice(0, 4000),
        };
      })
      .catch((e) => ({ error: String(e), url: frame.url() }));

    frames.push({
      name: frame.name(),
      url: frame.url(),
      isMain: frame === page.mainFrame(),
      ...info,
    });
  }

  const data = {
    label,
    pageUrl: page.url(),
    pageTitle: await page.title().catch(() => ''),
    frames,
  };
  dump(`${label}.json`, data);
  await page.screenshot({ path: join(OUT, `${label}.png`), fullPage: true }).catch(() => undefined);
  return data;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'ru-RU',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
});
const page = await context.newPage();

console.log('=== 1) goto target (domcontentloaded) ===');
const resp = await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60_000 });
console.log('status', resp?.status(), 'url', page.url());
await snapshot(page, '01-domcontentloaded');

console.log('=== 2) wait load + 4s poll like our detector ===');
await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => undefined);
await page.waitForTimeout(4000);
await snapshot(page, '02-after-wait');

console.log('=== 3) wait networkidle / extra 5s ===');
await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
await page.waitForTimeout(5000);
await snapshot(page, '03-after-networkidle');

// Try to find login form and fill
console.log('=== 4) attempt login if password field exists ===');
let loginFrame = page.mainFrame();
for (const frame of page.frames()) {
  const n = await frame.locator('input[type="password"]').count();
  if (n > 0) {
    loginFrame = frame;
    break;
  }
}

const pwdCount = await loginFrame.locator('input[type="password"]').count();
console.log('password fields in chosen frame:', pwdCount, 'frame url:', loginFrame.url());

if (pwdCount > 0) {
  const userSel =
    'input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="login" i], input[id*="user" i], input[id*="login" i], input[type="text"]';
  const passSel = 'input[type="password"]';
  const submitSel =
    'button[type="submit"], input[type="submit"], button:has-text("Войти"), button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Login")';

  await loginFrame.locator(userSel).first().fill(USER, { timeout: 10_000 });
  await loginFrame.locator(passSel).first().fill(PASS, { timeout: 10_000 });
  await loginFrame.locator(submitSel).first().click({ timeout: 10_000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(5000);
  await snapshot(page, '04-after-login-submit');

  console.log('=== 5) reopen target after login ===');
  const resp2 = await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  console.log('status', resp2?.status(), 'url', page.url());
  await page.waitForTimeout(5000);
  await snapshot(page, '05-reopen-target');
} else {
  console.log('NO password field found — dumping cookies and response headers');
  dump('cookies.json', await context.cookies());
}

await browser.close();
console.log('DONE', OUT);
