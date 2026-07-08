import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LinkResult {
  url: string;
  status: number | null;
  loadMs: number;
  totalMs: number;
  passed: boolean;
  error?: string;
}

// LOG_DIR можно переопределить переменной окружения — так API-сервер
// изолирует лог и результаты каждой задачи в собственную папку
// (.jobs/<id>), не трогая обычный test-results/ при локальном запуске.
export const LOG_DIR = process.env.LOG_DIR ?? 'test-results';
export const LOG_FILE = join(LOG_DIR, 'links.log');
export const RESULTS_JSON_FILE = join(LOG_DIR, 'results.json');

function formatLine(result: LinkResult): string {
  const status = result.status ?? 'нет ответа';
  const outcome = result.passed ? 'УСПЕХ' : 'ОШИБКА';

  let line =
    `[${outcome}] ${result.url} | HTTP ${status} | загрузка: ${result.loadMs} мс | всего: ${result.totalMs} мс`;

  if (result.error) {
    line += ` | ${result.error}`;
  }

  return line;
}

/**
 * Вызывается один раз за весь прогон (из globalSetup), а не из beforeAll —
 * Playwright может перезапускать воркер-процесс после упавшего теста,
 * и повторный вызов из beforeAll каждого нового воркера затирал бы файл лога.
 */
export function initLinkLog(): void {
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(
    LOG_FILE,
    `Запуск тестирования ссылок — ${new Date().toISOString()}\n\n`,
    'utf-8',
  );
}

export function logLinkResult(result: LinkResult): void {
  const line = formatLine(result);
  console.log(line);
  appendFileSync(LOG_FILE, `${line}\n`, 'utf-8');
}
