/**
 * Очередь выполнения задач: каждая задача — это отдельный процесс
 * Playwright, изолированный своей папкой (.jobs/<id>).
 *
 * Логи в терминал сервера — как раньше: stdout/stderr дочернего процесса
 * пробрасываются построчно с префиксом [job <id>]. Строки вида
 * [УСПЕХ]/[ОШИБКА] пишет logLinkResult / russianReporter в дочернем процессе.
 *
 * Запуск: npx playwright test через shell (кроссплатформенно; на Windows
 * надёжнее, чем spawn без shell).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { LinkRequireCondition } from '../loadLinks.js';
import { credentialsFileFor } from './credentialStore.js';
import {
  getJob,
  jobDirFor,
  progressFileFor,
  resultsFileFor,
  updateJob,
  type Job,
  type JobSummary,
} from './jobStore.js';

const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS) || 1);

function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

interface QueueEntry {
  jobId: string;
  linksFile: string;
  /** Если задано — повторная проверка: LOG_DIR = recheckDir, результаты мержатся в основную задачу. */
  recheckDir?: string;
  onComplete?: (job: Job | undefined) => void;
}

export interface RecheckLinkInput {
  url: string;
  timeoutMs?: number;
  require?: LinkRequireCondition[];
}

/** Строка результата в progress/results — может содержать доп. поля от теста. */
export interface LinkResultRow {
  url: string;
  status: number | null;
  loadMs: number;
  totalMs: number;
  passed: boolean;
  error?: string;
  usedLogin?: boolean;
  needsLogin?: boolean;
  loginDomain?: string;
  loginPageUrl?: string;
  loginMs?: number;
  loginUsername?: string;
  priority?: number;
  timeoutMs?: number;
  require?: LinkRequireCondition[];
}

interface ProgressFile {
  total: number;
  completed: number;
  current: string | null;
  results: LinkResultRow[];
}

interface ResultsFile {
  total: number;
  passed: number;
  failed: number;
  avgLoadMs: number;
  avgTotalMs: number;
  results: LinkResultRow[];
}

let activeCount = 0;
const queue: QueueEntry[] = [];

function readResultsSummary(jobId: string): JobSummary | undefined {
  const resultsPath = resultsFileFor(jobId);

  if (!existsSync(resultsPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(resultsPath, 'utf-8')) as JobSummary;
    return {
      total: parsed.total,
      passed: parsed.passed,
      failed: parsed.failed,
      avgLoadMs: parsed.avgLoadMs,
      avgTotalMs: parsed.avgTotalMs,
    };
  } catch {
    return undefined;
  }
}

function shortId(jobId: string): string {
  return jobId.slice(0, 8);
}

function logJob(jobId: string, message: string, asError = false): void {
  const line = `[job ${shortId(jobId)}] ${message}`;
  if (asError) {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * Построчно печатает вывод дочернего процесса в консоль сервера с префиксом
 * [job <id>] — как на старых версиях проекта.
 */
function pipeWithPrefix(jobId: string, stream: NodeJS.ReadableStream, asError = false): void {
  let buffer = '';

  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    // \r?\n — и Windows, и Linux/macOS
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      // Пустые строки тоже пробрасываем — как в старом выводе («Запуск тестов» и итоги).
      logJob(jobId, line, asError);
    }
  });

  stream.on('end', () => {
    if (buffer.length > 0) {
      logJob(jobId, buffer, asError);
    }
  });
}

function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

function summarizeResults(results: LinkResultRow[]): JobSummary {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const avgLoadMs =
    total === 0 ? 0 : Math.round(results.reduce((sum, r) => sum + (r.loadMs || 0), 0) / total);
  const avgTotalMs =
    total === 0 ? 0 : Math.round(results.reduce((sum, r) => sum + (r.totalMs || 0), 0) / total);
  return { total, passed, failed, avgLoadMs, avgTotalMs };
}

/**
 * Подменяет в основном progress/results строки с теми же URL результатами
 * повторной проверки (остальные ссылки задачи не трогаем).
 */
function mergeRecheckIntoJob(jobId: string, recheckDir: string): JobSummary | undefined {
  const recheckResults = readJsonFile<ResultsFile>(join(recheckDir, 'results.json'));
  const recheckProgress = readJsonFile<ProgressFile>(join(recheckDir, 'progress.json'));
  const recheckRows =
    recheckResults?.results ||
    recheckProgress?.results ||
    [];

  if (recheckRows.length === 0) {
    return undefined;
  }

  const byUrl = new Map(recheckRows.map((row) => [row.url, row]));

  const mainProgressPath = progressFileFor(jobId);
  const mainResultsPath = resultsFileFor(jobId);

  const mainProgress = readJsonFile<ProgressFile>(mainProgressPath) || {
    total: 0,
    completed: 0,
    current: null,
    results: [],
  };

  mainProgress.results = (mainProgress.results || []).map((row) => byUrl.get(row.url) || row);
  // Если URL не было в progress (редко) — добавим.
  for (const row of recheckRows) {
    if (!mainProgress.results.some((r) => r.url === row.url)) {
      mainProgress.results.push(row);
    }
  }
  mainProgress.completed = mainProgress.results.length;
  mainProgress.current = null;
  writeFileSync(mainProgressPath, JSON.stringify(mainProgress, null, 2), 'utf-8');

  let mainResults = readJsonFile<ResultsFile>(mainResultsPath);
  if (mainResults?.results) {
    mainResults.results = mainResults.results.map((row) => byUrl.get(row.url) || row);
    for (const row of recheckRows) {
      if (!mainResults.results.some((r) => r.url === row.url)) {
        mainResults.results.push(row);
      }
    }
  } else {
    mainResults = {
      ...summarizeResults(mainProgress.results),
      results: mainProgress.results,
    };
  }

  const summary = summarizeResults(mainResults.results);
  const merged: ResultsFile = { ...summary, results: mainResults.results };
  writeFileSync(mainResultsPath, JSON.stringify(merged, null, 2), 'utf-8');
  return summary;
}

function executeJob(jobId: string, linksFile: string, recheckDir?: string): Promise<void> {
  return new Promise((resolvePromise) => {
    const jobDir = jobDirFor(jobId);
    const apiKeyName = getJob(jobId)?.apiKeyName;
    const isRecheck = Boolean(recheckDir);
    const logDir = recheckDir || jobDir;

    updateJob(jobId, {
      status: 'running',
      ...(isRecheck ? {} : { startedAt: new Date().toISOString() }),
      error: undefined,
    });
    logJob(
      jobId,
      isRecheck ? 'Повторная проверка выбранных ссылок в этой же задаче...' : 'Запуск проверки ссылок...',
    );

    const absLinksFile = absolutePath(linksFile);
    const absLogDir = absolutePath(logDir);
    const absCredentials = apiKeyName
      ? absolutePath(credentialsFileFor(apiKeyName))
      : undefined;

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      LINKS_FILE: absLinksFile,
      LOG_DIR: absLogDir,
      ...(absCredentials ? { CREDENTIALS_FILE: absCredentials } : {}),
    };
    // Иначе Node пишет warning, если в окружении родителя уже есть FORCE_COLOR/NO_COLOR.
    delete childEnv.FORCE_COLOR;
    delete childEnv.NO_COLOR;

    // Как в рабочей версии со скрина: одна строка + shell: true.
    // На Windows это надёжно запускает npx.cmd; stdout/stderr с [УСПЕХ]/[ОШИБКА]
    // пробрасываются через pipeWithPrefix.
    const child = spawn('npx playwright test', {
      shell: true,
      cwd: process.cwd(),
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-4000);
    });

    if (child.stdout) {
      pipeWithPrefix(jobId, child.stdout, false);
    }
    if (child.stderr) {
      pipeWithPrefix(jobId, child.stderr, true);
    }

    child.on('error', (error) => {
      updateJob(jobId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: `Не удалось запустить Playwright: ${error.message}`,
      });
      logJob(jobId, `Не удалось запустить Playwright: ${error.message}`, true);
      resolvePromise();
    });

    child.on('close', (code) => {
      if (isRecheck && recheckDir) {
        const summary = mergeRecheckIntoJob(jobId, recheckDir);
        if (summary) {
          updateJob(jobId, {
            status: 'completed',
            finishedAt: new Date().toISOString(),
            summary,
            error: undefined,
          });
          logJob(
            jobId,
            `Повторная проверка завершена: всего ${summary.total}, успешно ${summary.passed}, ошибок ${summary.failed}.`,
          );
        } else {
          const error =
            stderrTail.trim() ||
            (code === null
              ? 'Повторная проверка завершилась без результатов.'
              : `Повторная проверка завершилась с кодом ${code} без результатов.`);
          updateJob(jobId, {
            status: 'failed',
            finishedAt: new Date().toISOString(),
            error,
          });
          logJob(jobId, `Повторная проверка не выполнена: ${error}`, true);
        }
        resolvePromise();
        return;
      }

      const summary = readResultsSummary(jobId);

      if (summary) {
        updateJob(jobId, {
          status: 'completed',
          finishedAt: new Date().toISOString(),
          summary,
        });
        logJob(
          jobId,
          `Завершено: всего ${summary.total}, успешно ${summary.passed}, ошибок ${summary.failed}.`,
        );
      } else {
        const error =
          stderrTail.trim() ||
          (code === null
            ? 'Playwright завершился без результатов.'
            : `Playwright завершился с кодом ${code} без результатов.`);
        updateJob(jobId, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error,
        });
        logJob(jobId, `Задача не выполнена: ${error}`, true);
      }

      resolvePromise();
    });
  });
}

function pump(): void {
  while (activeCount < MAX_CONCURRENT_JOBS && queue.length > 0) {
    const entry = queue.shift();

    if (!entry || !getJob(entry.jobId)) {
      continue;
    }

    activeCount += 1;

    void executeJob(entry.jobId, entry.linksFile, entry.recheckDir)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        updateJob(entry.jobId, { status: 'failed', finishedAt: new Date().toISOString(), error: message });
      })
      .finally(() => {
        activeCount -= 1;
        entry.onComplete?.(getJob(entry.jobId));
        pump();
      });
  }
}

export function enqueueJob(
  job: Job,
  linksFile: string,
  onComplete?: (job: Job | undefined) => void,
): void {
  logJob(
    job.id,
    `Принята задача от «${job.apiKeyName}»: ${job.totalLinks} ссылок(и). Постановка в очередь.`,
  );
  queue.push({ jobId: job.id, linksFile, onComplete });
  pump();
}

/**
 * Повторная проверка части ссылок внутри уже существующей задачи —
 * после сохранения логина/пароля. Новая задача не создаётся: результаты
 * подменяются по URL в progress/results исходной задачи.
 */
export function enqueueRecheck(
  job: Job,
  links: RecheckLinkInput[],
  onComplete?: (job: Job | undefined) => void,
): void {
  const jobDir = jobDirFor(job.id);
  const recheckDir = join(jobDir, `recheck-${Date.now()}`);
  mkdirSync(recheckDir, { recursive: true });

  const linksFile = join(recheckDir, 'input.json');
  writeFileSync(linksFile, JSON.stringify({ links }, null, 2), 'utf-8');

  logJob(
    job.id,
    `Повторная проверка ${links.length} ссылок(и) в той же задаче. Постановка в очередь.`,
  );

  updateJob(job.id, {
    status: 'pending',
    error: undefined,
    finishedAt: undefined,
  });

  queue.push({ jobId: job.id, linksFile, recheckDir, onComplete });
  pump();
}
