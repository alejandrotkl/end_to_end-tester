/**
 * Очередь выполнения задач: каждая задача — это отдельный процесс
 * Playwright, изолированный своей папкой (.jobs/<id>).
 *
 * Логи в терминал сервера — как раньше: stdout/stderr дочернего процесса
 * пробрасываются построчно с префиксом [job <id>]. Строки вида
 * [УСПЕХ]/[ОШИБКА] пишет logLinkResult / russianReporter в дочернем процессе.
 *
 * Запуск: node <cli.js> test без shell (кроссплатформенно; на Windows
 * надёжнее, чем npx + shell: true).
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { credentialsFileFor } from './credentialStore.js';
import {
  getJob,
  jobDirFor,
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
  onComplete?: (job: Job | undefined) => void;
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

function executeJob(jobId: string, linksFile: string): Promise<void> {
  return new Promise((resolvePromise) => {
    const jobDir = jobDirFor(jobId);
    const apiKeyName = getJob(jobId)?.apiKeyName;

    updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() });
    logJob(jobId, 'Запуск проверки ссылок...');

    const absLinksFile = absolutePath(linksFile);
    const absJobDir = absolutePath(jobDir);
    const absCredentials = apiKeyName
      ? absolutePath(credentialsFileFor(apiKeyName))
      : undefined;

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      LINKS_FILE: absLinksFile,
      LOG_DIR: absJobDir,
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

    void executeJob(entry.jobId, entry.linksFile)
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
