/**
 * Очередь выполнения задач: каждая задача — это отдельный процесс
 * `npx playwright test`, изолированный от других задач своей собственной
 * папкой (.jobs/<id>) для входного файла со ссылками, лога и результата.
 *
 * Проверка ссылок через браузер может занимать заметное время, поэтому
 * задачи выполняются асинхронно, а число одновременных прогонов
 * ограничено MAX_CONCURRENT_JOBS (по умолчанию 1 — прогоны Playwright
 * не мешают друг другу за ресурсы CPU/сеть).
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { getJob, jobDirFor, resultsFileFor, updateJob, type Job, type JobSummary } from './jobStore.js';

const MAX_CONCURRENT_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS) || 1);

interface QueueEntry {
  jobId: string;
  linksFile: string;
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

/**
 * Построчно печатает вывод дочернего процесса в консоль сервера с префиксом
 * [job <id>] — без этого прогресс задач был бы совсем не виден в логах
 * сервера (сам дочерний процесс выводит эти строки через RussianReporter).
 */
function pipeWithPrefix(jobId: string, stream: NodeJS.ReadableStream, write: (text: string) => void): void {
  let buffer = '';

  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      write(`[job ${shortId(jobId)}] ${line}`);
    }
  });

  stream.on('end', () => {
    if (buffer.trim()) {
      write(`[job ${shortId(jobId)}] ${buffer}`);
    }
  });
}

function executeJob(jobId: string, linksFile: string): Promise<void> {
  return new Promise((resolvePromise) => {
    const jobDir = jobDirFor(jobId);

    updateJob(jobId, { status: 'running', startedAt: new Date().toISOString() });
    console.log(`[job ${shortId(jobId)}] Запуск проверки ссылок...`);

    // Команда передаётся одной строкой (см. комментарий в src/run.ts) —
    // это одновременно чинит запуск npx.cmd на Windows и убирает
    // предупреждение Node DEP0190 про shell: true + массив args.
    const child = spawn('npx playwright test', {
      shell: true,
      env: {
        ...process.env,
        LINKS_FILE: linksFile,
        LOG_DIR: jobDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-4000);
    });

    if (child.stdout) {
      pipeWithPrefix(jobId, child.stdout, (line) => console.log(line));
    }
    if (child.stderr) {
      pipeWithPrefix(jobId, child.stderr, (line) => console.error(line));
    }

    child.on('error', (error) => {
      updateJob(jobId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: `Не удалось запустить Playwright: ${error.message}`,
      });
      console.error(`[job ${shortId(jobId)}] Не удалось запустить Playwright: ${error.message}`);
      resolvePromise();
    });

    child.on('close', () => {
      const summary = readResultsSummary(jobId);

      if (summary) {
        updateJob(jobId, {
          status: 'completed',
          finishedAt: new Date().toISOString(),
          summary,
        });
        console.log(
          `[job ${shortId(jobId)}] Завершено: всего ${summary.total}, успешно ${summary.passed}, ошибок ${summary.failed}.`,
        );
      } else {
        const error = stderrTail.trim() || 'Playwright завершился без результатов.';
        updateJob(jobId, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error,
        });
        console.error(`[job ${shortId(jobId)}] Задача не выполнена: ${error}`);
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
        pump();
      });
  }
}

export function enqueueJob(job: Job, linksFile: string): void {
  console.log(
    `[job ${shortId(job.id)}] Принята задача от «${job.apiKeyName}»: ${job.totalLinks} ссылок(и). Постановка в очередь.`,
  );
  queue.push({ jobId: job.id, linksFile });
  pump();
}
