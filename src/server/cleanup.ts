/**
 * Автоматическая очистка старых логов (данных завершённых задач).
 *
 * Каждая задача — это папка .jobs/<id> с входным файлом, логом, результатом
 * и скриншотами Playwright. При регулярных плановых проверках (см.
 * scheduler.ts) такие папки накапливаются без ограничения — например, при
 * проверке раз в 5 минут это больше 8000 папок в месяц. Чтобы диск не
 * переполнялся, раз в сутки проверяем возраст завершённых задач и удаляем
 * те, что старше срока хранения (по умолчанию 30 дней) — то есть по факту
 * логи каждой задачи «живут» около месяца, как и требовалось.
 *
 * Задачи, которые ещё выполняются (pending/running), никогда не удаляются
 * независимо от возраста.
 */

import { deleteJob, listAllJobs } from './jobStore.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const LOG_RETENTION_MS = (Number(process.env.LOG_RETENTION_DAYS) || 30) * DAY_MS;
export const CLEANUP_INTERVAL_MS = Number(process.env.CLEANUP_INTERVAL_MS) || DAY_MS;

/** Возвращает количество удалённых задач — используется только для логирования. */
export function cleanupOldJobs(retentionMs: number = LOG_RETENTION_MS): number {
  const cutoff = Date.now() - retentionMs;
  let removed = 0;

  for (const job of listAllJobs()) {
    if (job.status !== 'completed' && job.status !== 'failed') {
      continue;
    }

    const referenceDate = job.finishedAt ?? job.createdAt;

    if (new Date(referenceDate).getTime() < cutoff) {
      deleteJob(job.id);
      removed += 1;
    }
  }

  return removed;
}

/**
 * Форматирует миллисекунды в наиболее подходящую единицу (дни/часы/минуты/
 * секунды) — при LOG_RETENTION_DAYS < 1 (например, при тестировании) вывод
 * вида «старше 0 дн.» выглядел бы как «сразу», хотя срок хранения на самом
 * деле применяется точно, просто он меньше суток.
 */
function formatDuration(ms: number): string {
  const units: [number, string][] = [
    [DAY_MS, 'дн.'],
    [60 * 60 * 1000, 'ч.'],
    [60 * 1000, 'мин.'],
    [1000, 'сек.'],
  ];

  for (const [unitMs, label] of units) {
    if (ms >= unitMs) {
      return `${Math.round(ms / unitMs)} ${label}`;
    }
  }

  return `${ms} мс`;
}

/**
 * Запускает фоновую очистку: сразу при старте сервера (на случай, если он
 * был выключен дольше срока хранения) и дальше каждые CLEANUP_INTERVAL_MS
 * (по умолчанию раз в сутки — так срок хранения соблюдается точно, а не
 * «плюс-минус», как было бы при setInterval на месяц с учётом перезапусков).
 */
export function startCleanupSchedule(): void {
  const retentionLabel = formatDuration(LOG_RETENTION_MS);

  const runCleanup = (): void => {
    const removed = cleanupOldJobs();

    if (removed > 0) {
      console.log(`[очистка логов] Удалено старых задач (старше ${retentionLabel}): ${removed}.`);
    }
  };

  runCleanup();
  setInterval(runCleanup, CLEANUP_INTERVAL_MS);

  console.log(
    `[очистка логов] Включена: срок хранения ${retentionLabel}, проверка каждые ${formatDuration(CLEANUP_INTERVAL_MS)}`,
  );
}
