/**
 * Плановые (периодические) проверки ссылок.
 *
 * Идея: для каждого API-ключа может быть настроено не более одного
 * расписания — список ссылок и интервал повтора. После каждой проверки
 * (плановой ИЛИ запущенной вручную через /schedule/run) таймер следующего
 * запуска взводится заново на интервал, отсчитываемый от МОМЕНТА ЗАВЕРШЕНИЯ
 * этой проверки — поэтому ручной запуск не приводит к «двойной» проверке
 * почти сразу же следом плановой, а просто сдвигает её на интервал вперёд.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createJob, jobDirFor } from './jobStore.js';
import { enqueueJob } from './jobRunner.js';
import {
  deleteSchedule as removeScheduleConfig,
  getSchedule,
  listSchedules,
  scheduleDirFor,
  upsertSchedule,
  type Schedule,
} from './scheduleStore.js';

export const DEFAULT_SCHEDULE_INTERVAL_MS = Number(process.env.SCHEDULE_INTERVAL_MS) || 5 * 60 * 1000;

const timers = new Map<string, NodeJS.Timeout>();

function clearTimer(apiKeyName: string): void {
  const timer = timers.get(apiKeyName);

  if (timer) {
    clearTimeout(timer);
    timers.delete(apiKeyName);
  }
}

function armTimer(apiKeyName: string, intervalMs: number): void {
  clearTimer(apiKeyName);
  timers.set(
    apiKeyName,
    setTimeout(() => runSchedule(apiKeyName), intervalMs),
  );
}

function linksFilePathFor(schedule: Schedule): string | undefined {
  if (!schedule.linksFileName) {
    return undefined;
  }

  return join(scheduleDirFor(schedule.apiKeyName), schedule.linksFileName);
}

function runSchedule(apiKeyName: string, options: { force?: boolean } = {}): void {
  const schedule = getSchedule(apiKeyName);

  if (!schedule || (!schedule.enabled && !options.force)) {
    return;
  }

  const linksFile = linksFilePathFor(schedule);

  if (!linksFile || !existsSync(linksFile)) {
    console.error(
      `[расписание ${apiKeyName}] Файл со ссылками не найден, плановая проверка пропущена.`,
    );
    return;
  }

  const id = randomUUID();
  mkdirSync(jobDirFor(id), { recursive: true });
  const job = createJob(id, apiKeyName, schedule.totalLinks);

  console.log(
    `[расписание ${apiKeyName}] Запуск проверки по расписанию (задача ${id.slice(0, 8)}), ${schedule.totalLinks} ссылок(и).`,
  );

  upsertSchedule(apiKeyName, {
    lastJobId: id,
    lastRunAt: new Date().toISOString(),
    nextRunAt: undefined,
  });

  enqueueJob(job, linksFile, () => {
    const current = getSchedule(apiKeyName);

    if (!current || !current.enabled) {
      return;
    }

    upsertSchedule(apiKeyName, {
      nextRunAt: new Date(Date.now() + current.intervalMs).toISOString(),
    });
    armTimer(apiKeyName, current.intervalMs);
  });
}

/**
 * Создаёт или обновляет расписание проверки для API-ключа и сразу запускает
 * первую проверку (незачем заставлять ждать первого планового запуска
 * отдельно от настройки).
 */
export function configureSchedule(
  apiKeyName: string,
  linksFileName: string,
  totalLinks: number,
  intervalMs: number,
): Schedule {
  upsertSchedule(apiKeyName, {
    intervalMs,
    enabled: true,
    totalLinks,
    linksFileName,
  });

  runSchedule(apiKeyName);

  return getSchedule(apiKeyName)!;
}

/**
 * Запускает проверку по уже настроенному расписанию немедленно (вручную).
 * Таймер следующего планового запуска будет взведён заново после
 * завершения этой проверки — см. комментарий в начале файла.
 */
export function triggerScheduleNow(apiKeyName: string): Schedule {
  const schedule = getSchedule(apiKeyName);

  if (!schedule) {
    throw new Error('Расписание для этого API-ключа ещё не настроено. Сначала выполните PUT /api/v1/schedule.');
  }

  if (!schedule.enabled) {
    throw new Error('Расписание остановлено. Включите его заново через PUT /api/v1/schedule.');
  }

  clearTimer(apiKeyName);
  runSchedule(apiKeyName);

  return getSchedule(apiKeyName)!;
}

/** Полностью останавливает и удаляет расписание вместе с файлом ссылок. */
export function stopSchedule(apiKeyName: string): boolean {
  clearTimer(apiKeyName);
  return removeScheduleConfig(apiKeyName);
}

/**
 * Возобновляет ранее настроенные и включённые расписания после перезапуска
 * сервера. Точное время «внутри интервала», на котором расписание было
 * прервано, не сохраняется — вместо этого мы просто запускаем свежую
 * проверку сразу при старте и дальше продолжаем обычный цикл.
 */
export function resumeSchedulesOnStartup(): void {
  for (const schedule of listSchedules()) {
    if (schedule.enabled) {
      console.log(
        `[расписание ${schedule.apiKeyName}] Возобновление плановой проверки после перезапуска сервера.`,
      );
      runSchedule(schedule.apiKeyName, { force: true });
    }
  }
}
