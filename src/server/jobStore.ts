/**
 * Хранилище задач (jobs) API-сервера.
 *
 * Данные держим в памяти (Map) для быстрого доступа и дублируем в
 * index.json на диске — чтобы список задач и их статусы не терялись
 * при перезапуске сервера. Сами результаты проверки ссылок (results.json)
 * лежат отдельно, в папке конкретной задачи — их читают по требованию,
 * а не хранят в памяти, чтобы не раздувать процесс при большом числе задач.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface JobSummary {
  total: number;
  passed: number;
  failed: number;
  avgLoadMs: number;
  avgTotalMs: number;
}

export interface Job {
  id: string;
  apiKeyName: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  totalLinks: number;
  error?: string;
  summary?: JobSummary;
}

export const JOBS_DIR = process.env.JOBS_DIR ?? '.jobs';
const INDEX_FILE = join(JOBS_DIR, 'index.json');

const jobs = new Map<string, Job>();

export function jobDirFor(id: string): string {
  return join(JOBS_DIR, id);
}

export function resultsFileFor(id: string): string {
  return join(jobDirFor(id), 'results.json');
}

function persistIndex(): void {
  mkdirSync(JOBS_DIR, { recursive: true });
  writeFileSync(INDEX_FILE, JSON.stringify(Array.from(jobs.values()), null, 2), 'utf-8');
}

/**
 * Загружает список задач с диска при старте сервера. Задачи, которые
 * остались в статусе pending/running (сервер перезапустился во время их
 * выполнения), помечаются как failed — процесс, который их выполнял, уже
 * не существует, а результата у них нет.
 */
export function loadJobsFromDisk(): void {
  jobs.clear();

  if (!existsSync(INDEX_FILE)) {
    return;
  }

  try {
    const raw = readFileSync(INDEX_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Job[];

    for (const job of parsed) {
      if (job.status === 'pending' || job.status === 'running') {
        job.status = 'failed';
        job.error = 'Задача прервана из-за перезапуска сервера.';
        job.finishedAt = new Date().toISOString();
      }

      jobs.set(job.id, job);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Не удалось прочитать ${INDEX_FILE}, список задач будет пустым: ${message}`);
  }
}

export function createJob(id: string, apiKeyName: string, totalLinks: number): Job {
  const job: Job = {
    id,
    apiKeyName,
    status: 'pending',
    createdAt: new Date().toISOString(),
    totalLinks,
  };

  jobs.set(id, job);
  persistIndex();
  return job;
}

export function updateJob(id: string, patch: Partial<Job>): Job | undefined {
  const job = jobs.get(id);

  if (!job) {
    return undefined;
  }

  Object.assign(job, patch);
  persistIndex();
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(apiKeyName: string): Job[] {
  return Array.from(jobs.values())
    .filter((job) => job.apiKeyName === apiKeyName)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Все задачи всех API-ключей — нужно только для фоновой очистки старых логов (см. cleanup.ts). */
export function listAllJobs(): Job[] {
  return Array.from(jobs.values());
}

export function deleteJob(id: string): boolean {
  if (!jobs.has(id)) {
    return false;
  }

  jobs.delete(id);
  persistIndex();

  rmSync(jobDirFor(id), { recursive: true, force: true });
  return true;
}
