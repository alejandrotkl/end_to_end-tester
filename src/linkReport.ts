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

const LOG_DIR = 'test-results';
const LOG_FILE = join(LOG_DIR, 'links.log');
const results: LinkResult[] = [];

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

export function initLinkLog(): void {
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(
    LOG_FILE,
    `Запуск тестирования ссылок — ${new Date().toISOString()}\n\n`,
    'utf-8',
  );
}

export function logLinkResult(result: LinkResult): void {
  results.push(result);
  const line = formatLine(result);
  console.log(line);
  appendFileSync(LOG_FILE, `${line}\n`, 'utf-8');
}

export function printLinkSummary(): void {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const avgLoad =
    results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + r.loadMs, 0) / results.length)
      : 0;
  const avgTotal =
    results.length > 0
      ? Math.round(results.reduce((sum, r) => sum + r.totalMs, 0) / results.length)
      : 0;

  const summary = [
    '',
    '--- Итоги ---',
    `Всего: ${results.length} | Успешно: ${passed} | Ошибок: ${failed}`,
    `Среднее время загрузки: ${avgLoad} мс | Среднее общее время: ${avgTotal} мс`,
    `Файл лога: ${LOG_FILE}`,
  ].join('\n');

  console.log(summary);
  appendFileSync(LOG_FILE, `${summary}\n`, 'utf-8');
}
