import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const URL_PATTERN = /^https?:\/\/.+/i;

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();

  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  if (URL_PATTERN.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function parseText(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map(normalizeUrl)
    .filter((url): url is string => url !== null);
}

function parseJson(content: string): string[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Некорректный JSON-файл: ${message}`);
  }

  if (Array.isArray(parsed)) {
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map(normalizeUrl)
      .filter((url): url is string => url !== null);
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    'links' in parsed &&
    Array.isArray((parsed as { links: unknown }).links)
  ) {
    return (parsed as { links: unknown[] }).links
      .filter((item): item is string => typeof item === 'string')
      .map(normalizeUrl)
      .filter((url): url is string => url !== null);
  }

  throw new Error(
    'JSON-файл должен содержать массив ссылок или объект вида { "links": [...] }',
  );
}

export function loadLinks(filePath: string): string[] {
  const absolutePath = resolve(filePath);
  const content = readFileSync(absolutePath, 'utf-8');
  const extension = extname(absolutePath).toLowerCase();

  const links =
    extension === '.json' ? parseJson(content) : parseText(content);

  if (links.length === 0) {
    throw new Error(`В файле не найдено ни одной корректной ссылки: ${absolutePath}`);
  }

  return links;
}
