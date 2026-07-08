/**
 * Хранилище конфигураций плановых проверок (по одной на каждый API-ключ).
 *
 * Устроено так же, как jobStore.ts: список расписаний держим в памяти и
 * дублируем в schedules.json на диске, чтобы настройки не терялись при
 * перезапуске сервера. Сам список ссылок для плановой проверки хранится
 * отдельным файлом рядом (links.json) — его переиспользует jobRunner при
 * каждом плановом или ручном запуске.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOBS_DIR } from './jobStore.js';

export interface Schedule {
  apiKeyName: string;
  intervalMs: number;
  enabled: boolean;
  totalLinks: number;
  /** Имя файла со ссылками внутри scheduleDirFor(apiKeyName), например input.json. */
  linksFileName?: string;
  createdAt: string;
  updatedAt: string;
  lastJobId?: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

const SCHEDULES_DIR = join(JOBS_DIR, 'schedules');
const INDEX_FILE = join(SCHEDULES_DIR, 'index.json');

const schedules = new Map<string, Schedule>();

export function scheduleDirFor(apiKeyName: string): string {
  // Имя API-ключа приходит из API_KEYS (см. src/server/apiKeys.ts) и
  // задаётся администратором сервера, а не произвольным пользователем,
  // поэтому используем его как есть для имени папки.
  return join(SCHEDULES_DIR, apiKeyName);
}

function persistIndex(): void {
  mkdirSync(SCHEDULES_DIR, { recursive: true });
  writeFileSync(INDEX_FILE, JSON.stringify(Array.from(schedules.values()), null, 2), 'utf-8');
}

export function loadSchedulesFromDisk(): void {
  schedules.clear();

  if (!existsSync(INDEX_FILE)) {
    return;
  }

  try {
    const raw = readFileSync(INDEX_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Schedule[];

    for (const schedule of parsed) {
      schedules.set(schedule.apiKeyName, schedule);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Не удалось прочитать ${INDEX_FILE}, список расписаний будет пустым: ${message}`);
  }
}

export function getSchedule(apiKeyName: string): Schedule | undefined {
  return schedules.get(apiKeyName);
}

export function listSchedules(): Schedule[] {
  return Array.from(schedules.values());
}

export function upsertSchedule(
  apiKeyName: string,
  patch: Partial<Omit<Schedule, 'apiKeyName' | 'createdAt'>>,
): Schedule {
  const existing = schedules.get(apiKeyName);
  const now = new Date().toISOString();

  const schedule: Schedule = existing
    ? { ...existing, ...patch, updatedAt: now }
    : {
        apiKeyName,
        intervalMs: patch.intervalMs ?? 5 * 60 * 1000,
        enabled: patch.enabled ?? true,
        totalLinks: patch.totalLinks ?? 0,
        createdAt: now,
        updatedAt: now,
        ...patch,
      };

  schedules.set(apiKeyName, schedule);
  persistIndex();
  return schedule;
}

export function deleteSchedule(apiKeyName: string): boolean {
  if (!schedules.has(apiKeyName)) {
    return false;
  }

  schedules.delete(apiKeyName);
  persistIndex();

  rmSync(scheduleDirFor(apiKeyName), { recursive: true, force: true });
  return true;
}
