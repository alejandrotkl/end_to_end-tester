/**
 * Разбор и проверка API-ключей сервера.
 *
 * Ключи задаются одной переменной окружения API_KEYS в формате
 * "имя1:ключ1,имя2:ключ2" — так удобно выдать отдельный ключ каждому
 * клиенту/команде и потом видеть в логах и списке задач, кто их создал.
 */

import { timingSafeEqual } from 'node:crypto';

export interface ApiKeyEntry {
  name: string;
  key: string;
}

function parseApiKeys(raw: string | undefined): ApiKeyEntry[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const separatorIndex = chunk.indexOf(':');

      if (separatorIndex === -1) {
        throw new Error(
          `Некорректная запись в API_KEYS: «${chunk}». Ожидается формат имя:ключ.`,
        );
      }

      const name = chunk.slice(0, separatorIndex).trim();
      const key = chunk.slice(separatorIndex + 1).trim();

      if (!name || !key) {
        throw new Error(
          `Некорректная запись в API_KEYS: «${chunk}». И имя, и ключ должны быть непустыми.`,
        );
      }

      return { name, key };
    });
}

let cachedKeys: ApiKeyEntry[] | null = null;

export function loadApiKeys(): ApiKeyEntry[] {
  if (cachedKeys === null) {
    cachedKeys = parseApiKeys(process.env.API_KEYS);
  }

  return cachedKeys;
}

/** Сбрасывает кэш ключей — нужно только в тестах. */
export function resetApiKeysCache(): void {
  cachedKeys = null;
}

// Сравнение за постоянное время: обычное === для секретов теоретически
// позволяет подобрать ключ по времени ответа (чем больше совпавших
// начальных байт, тем чуть дольше сравнение). Для API-ключей это дешёвая
// и стандартная защита.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function findApiKeyOwner(key: string): string | null {
  const entry = loadApiKeys().find((candidate) => safeEqual(candidate.key, key));
  return entry ? entry.name : null;
}
