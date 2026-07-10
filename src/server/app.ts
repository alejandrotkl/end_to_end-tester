import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { loadLinks, parseRequireConditions } from '../loadLinks.js';
import { deleteDomainCredential, listDomainCredentials, saveDomainCredential } from '../credentialStore.js';
import {
  deleteNotificationSettings,
  getNotificationSettings,
  maskToken,
  saveNotificationSettings,
  sendTelegramMessage,
} from '../notifier.js';
import { findApiKeyOwner, loadApiKeys } from './apiKeys.js';
import { credentialsFileFor } from './credentialStore.js';
import { notificationsFileFor } from './notificationStore.js';
import {
  createJob,
  deleteFinishedJobs,
  deleteJob,
  getJob,
  jobDirFor,
  listJobs,
  progressFileFor,
  resultsFileFor,
} from './jobStore.js';
import { enqueueJob, enqueueRecheck } from './jobRunner.js';
import { getLinksDraft, saveLinksDraft, type DraftLink } from './linksDraftStore.js';
import { configureSchedule, DEFAULT_SCHEDULE_INTERVAL_MS, stopSchedule, triggerScheduleNow } from './scheduler.js';
import { getSchedule, scheduleDirFor } from './scheduleStore.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKeyName?: string;
    }
  }
}

const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 2 * 1024 * 1024;
const MAX_LINKS_PER_JOB = Number(process.env.MAX_LINKS_PER_JOB) || 500;
const MIN_SCHEDULE_INTERVAL_MS = 60 * 1000;

// src/server/app.ts -> ../../public — простая статическая страница
// (public/index.html + app.js), чтобы пользоваться API без консоли.
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../public');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// В Express 5 значения req.params типизированы как string | string[] —
// это нужно только для wildcard-маршрутов (например, "/files/*"), которых
// у нас нет. Для обычного ":id"/":domain" это всегда строка, но TypeScript
// об этом не знает, поэтому явно приводим тип.
function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] : value;
}

function idParam(req: Request): string {
  return routeParam(req, 'id');
}

/** Позволяет вставить в поле домена целый URL (https://example.com/login) — берём только hostname. */
function normalizeDomain(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return raw.trim();
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header?.toLowerCase().startsWith('bearer ')) {
    return undefined;
  }

  return header.slice(7).trim();
}

function authenticate(req: Request, res: Response, next: NextFunction): void {
  const key = req.header('x-api-key') ?? bearerToken(req.header('authorization'));

  if (!key) {
    res.status(401).json({
      error: 'Не передан API-ключ. Укажите его в заголовке X-API-Key или Authorization: Bearer <ключ>.',
    });
    return;
  }

  const ownerName = findApiKeyOwner(key);

  if (!ownerName) {
    res.status(403).json({ error: 'Неверный API-ключ.' });
    return;
  }

  req.apiKeyName = ownerName;
  next();
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: MAX_UPLOAD_BYTES }));
  app.use(express.static(PUBLIC_DIR));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const api = express.Router();
  api.use(authenticate);

  api.post('/jobs', upload.single('file'), (req: Request, res: Response) => {
    const id = randomUUID();
    const dir = jobDirFor(id);
    mkdirSync(dir, { recursive: true });

    // Подготовка входного файла и его валидация изолированы в try/catch,
    // который только читает/пишет файлы задачи и ничего не запускает.
    // Как только задача успешно поставлена в очередь (enqueueJob), откат
    // (удаление папки) больше не делаем — иначе при сбое отправки ответа
    // клиенту мы могли бы удалить данные уже стартовавшей задачи.
    let linksFilePath: string;
    let linksCount: number;

    try {
      if (req.file) {
        const ext = extname(req.file.originalname).toLowerCase();

        if (ext !== '.txt' && ext !== '.json') {
          throw new Error('Поддерживаются только файлы .txt и .json.');
        }

        linksFilePath = join(dir, `input${ext}`);
        writeFileSync(linksFilePath, req.file.buffer);
      } else if (Array.isArray((req.body as { links?: unknown })?.links)) {
        linksFilePath = join(dir, 'input.json');
        writeFileSync(
          linksFilePath,
          JSON.stringify({ links: (req.body as { links: unknown[] }).links }, null, 2),
          'utf-8',
        );
      } else {
        throw new Error(
          'Нужно передать либо файл (поле file, multipart/form-data), либо JSON-тело вида { "links": ["https://..."] }.',
        );
      }

      const links = loadLinks(linksFilePath);

      if (links.length > MAX_LINKS_PER_JOB) {
        throw new Error(
          `Слишком много ссылок в одной задаче: ${links.length}. Максимум: ${MAX_LINKS_PER_JOB} (настраивается через MAX_LINKS_PER_JOB).`,
        );
      }

      linksCount = links.length;
    } catch (error: unknown) {
      rmSync(dir, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
      return;
    }

    const job = createJob(id, req.apiKeyName!, linksCount);
    enqueueJob(job, linksFilePath);
    res.status(202).location(`/api/v1/jobs/${id}`).json(job);
  });

  api.get('/jobs', (req: Request, res: Response) => {
    res.json(listJobs(req.apiKeyName!));
  });

  api.get('/jobs/:id', (req: Request, res: Response) => {
    const job = getJob(idParam(req));

    if (!job || job.apiKeyName !== req.apiKeyName) {
      res.status(404).json({ error: 'Задача не найдена.' });
      return;
    }

    res.json(job);
  });

  // Прогресс задачи в реальном времени: какая ссылка проверяется прямо
  // сейчас и результаты уже готовых, не дожидаясь завершения всей задачи —
  // используется веб-интерфейсом для панели «Сейчас выполняется». В отличие
  // от /results работает на любом статусе задачи, не только completed.
  api.get('/jobs/:id/progress', (req: Request, res: Response) => {
    const job = getJob(idParam(req));

    if (!job || job.apiKeyName !== req.apiKeyName) {
      res.status(404).json({ error: 'Задача не найдена.' });
      return;
    }

    const progressPath = progressFileFor(job.id);
    let progress: { total: number; completed: number; current: string | null; results: unknown[] } = {
      total: job.totalLinks,
      completed: 0,
      current: null,
      results: [],
    };

    if (existsSync(progressPath)) {
      try {
        progress = JSON.parse(readFileSync(progressPath, 'utf-8'));
      } catch {
        // Файл ещё не дописан (гонка с записью) — отдаём значения по умолчанию.
      }
    }

    res.json({
      ...progress,
      status: job.status,
      jobId: job.id,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    });
  });

  api.get('/jobs/:id/results', (req: Request, res: Response) => {
    const job = getJob(idParam(req));

    if (!job || job.apiKeyName !== req.apiKeyName) {
      res.status(404).json({ error: 'Задача не найдена.' });
      return;
    }

    if (job.status !== 'completed') {
      res.status(409).json({
        error: `Задача ещё не завершена (текущий статус: ${job.status}).`,
        status: job.status,
      });
      return;
    }

    const resultsPath = resultsFileFor(job.id);

    if (!existsSync(resultsPath)) {
      res.status(500).json({ error: 'Файл с результатами не найден.' });
      return;
    }

    res.type('application/json').send(readFileSync(resultsPath, 'utf-8'));
  });

  // Ручная очистка всех завершённых логов текущего API-ключа — независимо
  // от автоматической очистки по LOG_RETENTION_DAYS (см. cleanup.ts).
  // Выполняющиеся задачи не удаляются. Маршрут объявлен ДО /jobs/:id,
  // чтобы Express не принял пустой :id.
  api.delete('/jobs', (req: Request, res: Response) => {
    const removed = deleteFinishedJobs(req.apiKeyName!);
    res.json({ removed });
  });

  api.delete('/jobs/:id', (req: Request, res: Response) => {
    const job = getJob(idParam(req));

    if (!job || job.apiKeyName !== req.apiKeyName) {
      res.status(404).json({ error: 'Задача не найдена.' });
      return;
    }

    if (job.status === 'pending' || job.status === 'running') {
      res.status(409).json({ error: 'Нельзя удалить задачу, которая ещё выполняется.' });
      return;
    }

    deleteJob(job.id);
    res.status(204).send();
  });

  // Повторная проверка части ссылок внутри уже существующей задачи —
  // после сохранения логина/пароля. Новая задача не создаётся: результаты
  // подменяются по URL в progress/results исходной задачи.
  api.post('/jobs/:id/recheck', (req: Request, res: Response) => {
    const job = getJob(idParam(req));

    if (!job || job.apiKeyName !== req.apiKeyName) {
      res.status(404).json({ error: 'Задача не найдена.' });
      return;
    }

    if (job.status === 'pending' || job.status === 'running') {
      res.status(409).json({ error: 'Задача ещё выполняется — дождитесь завершения перед повторной проверкой.' });
      return;
    }

    const rawLinks = (req.body as { links?: unknown })?.links;
    if (!Array.isArray(rawLinks) || rawLinks.length === 0) {
      res.status(400).json({ error: 'Нужно передать непустой массив links.' });
      return;
    }

    const links = rawLinks
      .map((item) => {
        if (typeof item === 'string') {
          return { url: item };
        }
        if (item && typeof item === 'object' && typeof (item as { url?: unknown }).url === 'string') {
          const row = item as { url: string; timeoutMs?: number; require?: unknown };
          const require = parseRequireConditions(row.require);
          return {
            url: row.url,
            timeoutMs: typeof row.timeoutMs === 'number' ? row.timeoutMs : undefined,
            ...(require ? { require } : {}),
          };
        }
        return null;
      })
      .filter((item): item is { url: string; timeoutMs?: number; require?: ReturnType<typeof parseRequireConditions> } =>
        item !== null,
      );

    if (links.length === 0) {
      res.status(400).json({ error: 'В links нет корректных ссылок.' });
      return;
    }

    if (links.length > MAX_LINKS_PER_JOB) {
      res.status(400).json({
        error: `Слишком много ссылок: ${links.length}. Максимум: ${MAX_LINKS_PER_JOB}.`,
      });
      return;
    }

    enqueueRecheck(job, links);
    const updated = getJob(job.id);
    res.status(202).json(updated);
  });

  // Плановые проверки: у каждого API-ключа может быть настроено одно
  // расписание (список ссылок + интервал повтора). PUT создаёт/обновляет
  // его и сразу выполняет первую проверку; дальше сервер сам повторяет
  // проверку через заданный интервал после КАЖДОГО прогона — планового
  // или запущенного вручную через /schedule/run.
  api.put('/schedule', upload.single('file'), (req: Request, res: Response) => {
    const apiKeyName = req.apiKeyName!;
    const dir = scheduleDirFor(apiKeyName);
    mkdirSync(dir, { recursive: true });

    let linksFileName: string;
    let linksCount: number;

    try {
      if (req.file) {
        const ext = extname(req.file.originalname).toLowerCase();

        if (ext !== '.txt' && ext !== '.json') {
          throw new Error('Поддерживаются только файлы .txt и .json.');
        }

        linksFileName = `input${ext}`;
        writeFileSync(join(dir, linksFileName), req.file.buffer);
      } else if (Array.isArray((req.body as { links?: unknown })?.links)) {
        linksFileName = 'input.json';
        writeFileSync(
          join(dir, linksFileName),
          JSON.stringify({ links: (req.body as { links: unknown[] }).links }, null, 2),
          'utf-8',
        );
      } else {
        throw new Error(
          'Нужно передать либо файл (поле file, multipart/form-data), либо JSON-тело вида { "links": ["https://..."] }.',
        );
      }

      // Удаляем файл с другим расширением от предыдущей настройки этого
      // расписания, если он остался, — иначе в папке будут копиться
      // устаревшие input.txt / input.json.
      for (const ext of ['.txt', '.json']) {
        const candidate = join(dir, `input${ext}`);
        if (`input${ext}` !== linksFileName && existsSync(candidate)) {
          rmSync(candidate, { force: true });
        }
      }

      const links = loadLinks(join(dir, linksFileName));

      if (links.length > MAX_LINKS_PER_JOB) {
        throw new Error(
          `Слишком много ссылок в расписании: ${links.length}. Максимум: ${MAX_LINKS_PER_JOB} (настраивается через MAX_LINKS_PER_JOB).`,
        );
      }

      linksCount = links.length;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: message });
      return;
    }

    const intervalMinutesRaw = (req.body as { intervalMinutes?: unknown })?.intervalMinutes;
    let intervalMs = DEFAULT_SCHEDULE_INTERVAL_MS;

    if (intervalMinutesRaw !== undefined) {
      const intervalMinutes = Number(intervalMinutesRaw);

      if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
        res.status(400).json({ error: 'intervalMinutes должен быть положительным числом.' });
        return;
      }

      intervalMs = Math.round(intervalMinutes * 60 * 1000);

      if (intervalMs < MIN_SCHEDULE_INTERVAL_MS) {
        res.status(400).json({
          error: `Слишком маленький интервал: минимум ${MIN_SCHEDULE_INTERVAL_MS / 60000} мин.`,
        });
        return;
      }
    }

    const schedule = configureSchedule(apiKeyName, linksFileName, linksCount, intervalMs);
    res.status(200).json(schedule);
  });

  api.get('/schedule', (req: Request, res: Response) => {
    const schedule = getSchedule(req.apiKeyName!);

    if (!schedule) {
      res.status(404).json({ error: 'Расписание не настроено. Настройте его через PUT /api/v1/schedule.' });
      return;
    }

    res.json(schedule);
  });

  api.post('/schedule/run', (req: Request, res: Response) => {
    try {
      const schedule = triggerScheduleNow(req.apiKeyName!);
      res.status(202).json(schedule);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(409).json({ error: message });
    }
  });

  api.delete('/schedule', (req: Request, res: Response) => {
    const removed = stopSchedule(req.apiKeyName!);

    if (!removed) {
      res.status(404).json({ error: 'Расписание не настроено.' });
      return;
    }

    res.status(204).send();
  });

  // Общий черновик списка ссылок в веб-интерфейсе (см. linksDraftStore.ts) —
  // так пользователи с разных устройств/вкладок, работающие с одним
  // API-ключом, видят один и тот же список и правки друг друга.
  api.get('/links-draft', (req: Request, res: Response) => {
    res.json(getLinksDraft(req.apiKeyName!));
  });

  api.put('/links-draft', (req: Request, res: Response) => {
    const rawLinks = (req.body as { links?: unknown })?.links;

    if (!Array.isArray(rawLinks)) {
      res.status(400).json({ error: 'Нужно передать массив links.' });
      return;
    }

    if (rawLinks.length > MAX_LINKS_PER_JOB) {
      res.status(400).json({
        error: `Слишком много ссылок: ${rawLinks.length}. Максимум: ${MAX_LINKS_PER_JOB} (настраивается через MAX_LINKS_PER_JOB).`,
      });
      return;
    }

    const links: DraftLink[] = rawLinks
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .filter((item) => typeof item.url === 'string')
      .map((item) => {
        const require = parseRequireConditions(item.require);
        return {
          url: item.url as string,
          timeoutMs: typeof item.timeoutMs === 'number' ? item.timeoutMs : undefined,
          ...(require ? { require } : {}),
        };
      });

    res.json(saveLinksDraft(req.apiKeyName!, links));
  });

  // Данные для входа на случай HTTP 403: при проверке ссылки, требующей
  // авторизации, сервер сам залогинится через форму на loginUrl и повторит
  // проверку (см. tests/links.spec.ts). Данные хранятся отдельно на каждый
  // API-ключ и никогда не возвращаются клиенту в открытом виде (только
  // домен и адрес страницы входа — без пароля).
  api.get('/credentials', (req: Request, res: Response) => {
    const list = listDomainCredentials(credentialsFileFor(req.apiKeyName!)).map(
      ({ password: _password, ...rest }) => rest,
    );
    res.json(list);
  });

  api.put('/credentials/:domain', (req: Request, res: Response) => {
    const domain = normalizeDomain(routeParam(req, 'domain'));
    const body = (req.body ?? {}) as Record<string, unknown>;

    const loginUrlRaw = typeof body.loginUrl === 'string' ? body.loginUrl.trim() : '';
    // Пустая строка и одноразовые OAuth/SSO URL (state) не сохраняем —
    // при следующей проверке тестер возьмёт свежий редирект со страницы.
    const loginUrl =
      loginUrlRaw && !/[?&](state|bo)=|\/blitz\/|openid-connect\/auth/i.test(loginUrlRaw)
        ? loginUrlRaw
        : undefined;
    const username = typeof body.username === 'string' ? body.username.trim() : undefined;
    const password = typeof body.password === 'string' ? body.password : undefined;
    const usernameSelector = typeof body.usernameSelector === 'string' ? body.usernameSelector : undefined;
    const passwordSelector = typeof body.passwordSelector === 'string' ? body.passwordSelector : undefined;
    const submitSelector = typeof body.submitSelector === 'string' ? body.submitSelector : undefined;

    if (!username || !password) {
      res.status(400).json({
        error:
          'Нужно передать строки username и password. Поле «Адрес страницы входа» необязательно — для SSO (Keycloak/Blitz) оставьте его пустым.',
      });
      return;
    }

    saveDomainCredential(credentialsFileFor(req.apiKeyName!), {
      domain,
      loginUrl,
      username,
      password,
      usernameSelector,
      passwordSelector,
      submitSelector,
    });

    res.status(200).json({ domain, loginUrl, username, usernameSelector, passwordSelector, submitSelector });
  });

  api.delete('/credentials/:domain', (req: Request, res: Response) => {
    const domain = normalizeDomain(routeParam(req, 'domain'));
    const removed = deleteDomainCredential(credentialsFileFor(req.apiKeyName!), domain);

    if (!removed) {
      res.status(404).json({ error: 'Данные для этого домена не настроены.' });
      return;
    }

    res.status(204).send();
  });

  // Уведомления администратора об ошибках через Telegram-бота: токен бота
  // и chat id хранятся отдельно на каждый API-ключ (см. src/notifier.ts).
  // Токен никогда не возвращается клиенту целиком — только признак того,
  // что он задан, и последние 4 символа для подтверждения (см. maskToken).
  api.get('/notifications', (req: Request, res: Response) => {
    const settings = getNotificationSettings(notificationsFileFor(req.apiKeyName!));

    res.json({
      chatId: settings?.chatId || '',
      enabled: settings?.enabled ?? false,
      botTokenSet: Boolean(settings?.botToken),
      botTokenPreview: settings?.botToken ? maskToken(settings.botToken) : '',
    });
  });

  api.put('/notifications', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const filePath = notificationsFileFor(req.apiKeyName!);
    const existing = getNotificationSettings(filePath);

    const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
    const botTokenRaw = typeof body.botToken === 'string' ? body.botToken.trim() : '';
    // Токен можно не передавать повторно при простом изменении chat id/enabled —
    // тогда сохраняем ранее сохранённый токен.
    const botToken = botTokenRaw || existing?.botToken || '';
    const enabled = Boolean(body.enabled);

    if (!chatId) {
      res.status(400).json({ error: 'Укажите chat id — куда бот будет присылать уведомления.' });
      return;
    }

    if (!botToken) {
      res.status(400).json({ error: 'Укажите токен Telegram-бота (получить у @BotFather).' });
      return;
    }

    saveNotificationSettings(filePath, { botToken, chatId, enabled });

    res.status(200).json({
      chatId,
      enabled,
      botTokenSet: true,
      botTokenPreview: maskToken(botToken),
    });
  });

  api.delete('/notifications', (req: Request, res: Response) => {
    const removed = deleteNotificationSettings(notificationsFileFor(req.apiKeyName!));

    if (!removed) {
      res.status(404).json({ error: 'Уведомления не настроены.' });
      return;
    }

    res.status(204).send();
  });

  // Отправляет тестовое сообщение сохранёнными настройками — чтобы
  // проверить токен бота и chat id, не дожидаясь реальной ошибки задачи.
  api.post('/notifications/test', async (req: Request, res: Response) => {
    const settings = getNotificationSettings(notificationsFileFor(req.apiKeyName!));

    if (!settings?.botToken || !settings.chatId) {
      res.status(400).json({ error: 'Сначала сохраните токен бота и chat id.' });
      return;
    }

    const result = await sendTelegramMessage(
      settings.botToken,
      settings.chatId,
      `✅ Тестовое сообщение от Playwright Link Tester (ключ «${req.apiKeyName}»). Если вы его видите — уведомления настроены верно.`,
    );

    if (!result.ok) {
      res.status(502).json({ error: result.error || 'Telegram не принял сообщение.' });
      return;
    }

    res.status(200).json({ ok: true });
  });

  app.use('/api/v1', api);

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `Маршрут не найден: ${req.method} ${req.path}` });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Необработанная ошибка запроса:', message);
    res.status(400).json({ error: `Некорректный запрос: ${message}` });
  });

  if (loadApiKeys().length === 0) {
    console.warn(
      '\n⚠ Внимание: переменная окружения API_KEYS не задана — ни один запрос к /api/v1 не пройдёт проверку. ' +
        'См. .env.example.\n',
    );
  }

  return app;
}
