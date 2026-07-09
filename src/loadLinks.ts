import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const URL_PATTERN = /^https?:\/\/.+/i;

export interface LinkInput {
  url: string;
  /** Порядковый номер в списке — чем меньше, тем раньше проверяется ссылка. По умолчанию — порядок в файле/списке. */
  priority: number;
  /** Сколько ждать ответа/загрузки, прежде чем считать ссылку ошибочной (мс). */
  timeoutMs: number;
}

export const DEFAULT_LINK_TIMEOUT_MS = 30_000;
const MIN_LINK_TIMEOUT_MS = 1_000;
const MAX_LINK_TIMEOUT_MS = 10 * 60 * 1000;

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();

  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  return URL_PATTERN.test(trimmed) ? trimmed : null;
}

/** Принимает значение и в секундах (маленькие числа), и в миллисекундах — так проще для веб-интерфейса и .env-подобных настроек. */
function normalizeTimeoutMs(raw: unknown): number {
  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_LINK_TIMEOUT_MS;
  }

  const ms = value < 1000 ? value * 1000 : value;
  return Math.min(Math.max(Math.round(ms), MIN_LINK_TIMEOUT_MS), MAX_LINK_TIMEOUT_MS);
}

/** Явно указанный номер приоритета переопределяет порядок по умолчанию (позицию в списке). */
function normalizePriority(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseTextLine(raw: string, fallbackPriority: number): LinkInput | null {
  const url = normalizeUrl(raw);
  return url ? { url, priority: fallbackPriority, timeoutMs: DEFAULT_LINK_TIMEOUT_MS } : null;
}

function parseText(content: string): LinkInput[] {
  return content
    .split(/\r?\n/)
    .map((line, index) => parseTextLine(line, index + 1))
    .filter((item): item is LinkInput => item !== null);
}

/**
 * Один элемент JSON-массива ссылок — либо просто строка (обычная ссылка,
 * приоритет по умолчанию — её позиция в списке), либо объект
 * { url, priority?, timeoutMs? } — так собирается список из веб-интерфейса
 * (интерактивный список ссылок, приоритет = порядковый номер).
 */
function parseEntry(item: unknown, fallbackPriority: number): LinkInput | null {
  if (typeof item === 'string') {
    return parseTextLine(item, fallbackPriority);
  }

  if (item && typeof item === 'object') {
    const obj = item as Record<string, unknown>;
    const url = typeof obj.url === 'string' ? normalizeUrl(obj.url) : null;

    if (!url) {
      return null;
    }

    return {
      url,
      priority: normalizePriority(obj.priority, fallbackPriority),
      timeoutMs: obj.timeoutMs !== undefined ? normalizeTimeoutMs(obj.timeoutMs) : DEFAULT_LINK_TIMEOUT_MS,
    };
  }

  return null;
}

function parseJson(content: string): LinkInput[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Некорректный JSON-файл: ${message}`);
  }

  const rawItems: unknown[] | null = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === 'object' &&
        'links' in parsed &&
        Array.isArray((parsed as { links: unknown }).links)
      ? (parsed as { links: unknown[] }).links
      : null;

  if (!rawItems) {
    throw new Error(
      'JSON-файл должен содержать массив ссылок или объект вида { "links": [...] }',
    );
  }

  return rawItems
    .map((item, index) => parseEntry(item, index + 1))
    .filter((item): item is LinkInput => item !== null);
}

/** Более приоритетные ссылки (меньший номер) идут первыми. Порядок ссылок с одинаковым приоритетом не меняется. */
function sortByPriority(links: LinkInput[]): LinkInput[] {
  return links
    .map((link, index) => ({ link, index }))
    .sort((a, b) => {
      const diff = a.link.priority - b.link.priority;
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map((entry) => entry.link);
}

export function loadLinks(filePath: string): LinkInput[] {
  const absolutePath = resolve(filePath);
  const content = readFileSync(absolutePath, 'utf-8');
  const extension = extname(absolutePath).toLowerCase();

  const links = extension === '.json' ? parseJson(content) : parseText(content);

  if (links.length === 0) {
    throw new Error(`В файле не найдено ни одной корректной ссылки: ${absolutePath}`);
  }

  return sortByPriority(links);
}
