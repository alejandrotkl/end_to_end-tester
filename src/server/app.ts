import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { loadLinks } from '../loadLinks.js';
import { findApiKeyOwner, loadApiKeys } from './apiKeys.js';
import {
  createJob,
  deleteJob,
  getJob,
  jobDirFor,
  listJobs,
  resultsFileFor,
} from './jobStore.js';
import { enqueueJob } from './jobRunner.js';

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

// В Express 5 значения req.params типизированы как string | string[] —
// это нужно только для wildcard-маршрутов (например, "/files/*"), которых
// у нас нет. Для обычного ":id" это всегда строка, но TypeScript об этом
// не знает, поэтому явно приводим тип.
function idParam(req: Request): string {
  const { id } = req.params;
  return Array.isArray(id) ? id[0] : id;
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
