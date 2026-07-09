import { appendFileSync, mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Убирает служебный diff Playwright из текста ошибки — оставляет понятное сообщение. */
export function simplifyErrorMessage(text: string): string {
  const cleaned = stripAnsi(text).trim();
  const firstBlock = cleaned.split(/\n\s*\n/)[0]?.trim();
  return firstBlock || cleaned;
}

export interface LinkResult {
  url: string;
  status: number | null;
  loadMs: number;
  totalMs: number;
  passed: boolean;
  error?: string;
  /** Страница требовала вход (HTTP 403 или форма логина), и была выполнена попытка входа. */
  usedLogin?: boolean;
  /** Страница требует вход (HTTP 403 или форма логина), но данные для домена не настроены. */
  needsLogin?: boolean;
  /** Домен, для которого нужен/использовался вход — веб-интерфейс показывает по нему окно ввода данных. */
  loginDomain?: string;
  /** Адрес обнаруженной страницы входа — подставляется в окно ввода данных как loginUrl по умолчанию. */
  loginPageUrl?: string;
  /** Порядковый номер ссылки в списке на момент проверки (её приоритет — чем меньше, тем раньше). */
  priority?: number;
  /** Таймаут, с которым проверялась именно эта ссылка (мс) — совпадает с общим, если не задан свой. */
  timeoutMs?: number;
}

// LOG_DIR можно переопределить переменной окружения — так API-сервер
// изолирует лог и результаты каждой задачи в собственную папку
// (.jobs/<id>), не трогая обычный test-results/ при локальном запуске.
export const LOG_DIR = process.env.LOG_DIR ?? 'test-results';
export const LOG_FILE = join(LOG_DIR, 'links.log');
export const RESULTS_JSON_FILE = join(LOG_DIR, 'results.json');
export const PROGRESS_JSON_FILE = join(LOG_DIR, 'progress.json');

function formatLine(result: LinkResult): string {
  const status = result.status ?? 'нет ответа';
  const outcome = result.passed ? 'УСПЕХ' : 'ОШИБКА';
  const loginNote = result.usedLogin
    ? ' | вход выполнен'
    : result.needsLogin
      ? ' | ТРЕБУЕТСЯ ВХОД (данные не настроены)'
      : '';

  let line =
    `[${outcome}] ${result.url} | HTTP ${status} | загрузка: ${result.loadMs} мс | всего: ${result.totalMs} мс${loginNote}`;

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
  // Как раньше: сразу в консоль (сервер пробрасывает stdout с префиксом [job …]).
  // writeSync — без буферизации pipe на Windows/Linux.
  writeSync(1, `${line}\n`);
  appendFileSync(LOG_FILE, `${line}\n`, 'utf-8');
}
