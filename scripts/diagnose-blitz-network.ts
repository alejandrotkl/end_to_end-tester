/**
 * Ловим сетевые запросы Blitz при вводе логина (проверка «пользователь есть?»).
 */
import { chromium } from 'playwright';

const TARGET =
  process.env.GIS_URL ||
  'https://gis.gov.ru/efo/editor/703671ca-c393-4d6d-48c9-c2546f5ddaa5';
const USER = process.env.GIS_USER || '';
const PASS = process.env.GIS_PASS || '';

if (!USER || !PASS) {
  console.error('Задайте GIS_USER и GIS_PASS в окружении.');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

const apiHits: Array<{ method: string; url: string; status?: number; body?: string }> = [];

page.on('request', (req) => {
  const u = req.url();
  if (/blitz|login\.gis|oauth|auth|subject|user|account|check|lookup|exist/i.test(u)) {
    apiHits.push({ method: req.method(), url: u });
  }
});

page.on('response', async (res) => {
  const u = res.url();
  if (/blitz|login\.gis/i.test(u) && res.request().method() !== 'GET') {
    let body = '';
    try {
      body = (await res.text()).slice(0, 500);
    } catch {
      body = '';
    }
    apiHits.push({ method: res.request().method(), url: u, status: res.status(), body });
  }
});

await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(2500);

const login = page.locator('#login').first();
await login.waitFor({ state: 'visible', timeout: 15_000 });

// Имитация «как человек»: посимвольно + пауза (часто триггерит lookup)
await login.click();
await login.fill('');
await login.pressSequentially(USER, { delay: 40 });
await page.waitForTimeout(1500);
await login.press('Tab');
await page.waitForTimeout(2500);

console.log('AFTER LOGIN LOOKUP');
console.log(
  JSON.stringify(
    await page.evaluate(() => ({
      url: location.href,
      login: (document.querySelector('#login') as HTMLInputElement)?.value,
      pwdLen: (document.querySelector('#password') as HTMLInputElement)?.value?.length,
      body: (document.body?.innerText || '').slice(0, 600),
    })),
    null,
    2,
  ),
);

const password = page.locator('#password').first();
await password.fill(PASS);
await page.locator('#bind').click();
await page.waitForTimeout(5000);

console.log('AFTER SUBMIT', page.url());
console.log('API HITS:');
for (const h of apiHits) {
  console.log(JSON.stringify(h));
}

await browser.close();
