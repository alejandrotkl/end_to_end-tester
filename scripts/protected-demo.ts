/**
 * Локальный демо-сайт для проверки сценария «требуется вход».
 *
 * Запуск: npm run demo:protected
 * Открыть: http://localhost:4000/secret
 *
 * Логин: demo
 * Пароль: demo123
 *
 * Без куки сессии /secret показывает форму входа (HTTP 200) —
 * как реальные порталы, которые не отдают 403, а рисуют логин.
 * После входа редирект обратно на /secret с защищённым содержимым.
 */

import express, { type Request, type Response, type NextFunction } from 'express';

const PORT = Number(process.env.DEMO_PORT) || 4000;
const USERNAME = process.env.DEMO_USER || 'demo';
const PASSWORD = process.env.DEMO_PASSWORD || 'demo123';
const COOKIE = 'demo_session';

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false }));

function isLoggedIn(req: Request): boolean {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((part) => part.trim() === `${COOKIE}=ok`);
}

function loginPage(returnTo: string, error = ''): string {
  const err = error ? `<p style="color:#b91c1c">${error}</p>` : '';
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <title>Вход — демо protected</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 420px; margin: 48px auto; padding: 0 16px; }
    label { display: block; margin: 12px 0 4px; color: #555; }
    input { width: 100%; padding: 8px 10px; box-sizing: border-box; }
    button { margin-top: 16px; padding: 8px 16px; background: #2563eb; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
    .hint { color: #6b7280; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Вход в демо-кабинет</h1>
  <p class="hint">Тестовый сайт для проверки логина в Playwright Link Tester.</p>
  ${err}
  <form method="POST" action="/login">
    <input type="hidden" name="returnTo" value="${returnTo}" />
    <label for="username">Логин</label>
    <input id="username" name="username" type="text" autocomplete="username" />
    <label for="password">Пароль</label>
    <input id="password" name="password" type="password" autocomplete="current-password" />
    <button type="submit">Войти</button>
  </form>
  <p class="hint">Логин: <code>${USERNAME}</code> · Пароль: <code>${PASSWORD}</code></p>
</body>
</html>`;
}

function secretPage(): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <title>Секретная страница</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 560px; margin: 48px auto; padding: 0 16px; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <h1>Секретная страница</h1>
  <p>Вы вошли. Это защищённое содержимое — проверка ссылки должна пройти успешно.</p>
  <p><a href="/logout">Выйти</a></p>
</body>
</html>`;
}

app.get('/', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8" /><title>Демо protected</title></head>
<body style="font-family:system-ui;max-width:560px;margin:48px auto;padding:0 16px">
  <h1>Демо protected</h1>
  <p>Откройте <a href="/secret">/secret</a> — без входа там форма логина.</p>
  <p>Логин: <code>${USERNAME}</code>, пароль: <code>${PASSWORD}</code></p>
</body></html>`);
});

app.get('/secret', (req, res) => {
  if (!isLoggedIn(req)) {
    // Как ФГИС КИ: HTTP 200 + форма входа вместо содержимого.
    res.status(200).type('html').send(loginPage('/secret'));
    return;
  }

  res.type('html').send(secretPage());
});

app.get('/login', (req, res) => {
  const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/secret';
  res.type('html').send(loginPage(returnTo));
});

app.post('/login', (req, res) => {
  const body = req.body as { username?: string; password?: string; returnTo?: string };
  const returnTo = body.returnTo && body.returnTo.startsWith('/') ? body.returnTo : '/secret';

  if (body.username === USERNAME && body.password === PASSWORD) {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=ok; Path=/; HttpOnly; SameSite=Lax`,
    );
    res.redirect(returnTo);
    return;
  }

  res.status(200).type('html').send(loginPage(returnTo, 'Неверный логин или пароль.'));
});

app.get('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
  res.redirect('/');
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).type('text').send(message);
});

app.listen(PORT, () => {
  console.log(`Демо protected: http://localhost:${PORT}`);
  console.log(`Защищённая страница: http://localhost:${PORT}/secret`);
  console.log(`Логин: ${USERNAME}  Пароль: ${PASSWORD}`);
});
