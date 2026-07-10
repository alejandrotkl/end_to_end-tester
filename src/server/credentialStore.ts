/**
 * Данные для входа на сервере хранятся отдельным файлом на каждый API-ключ
 * (.credentials/<имя ключа>.json) — так учётные данные разных клиентов не
 * пересекаются. Сама работа с файлом (чтение/запись/удаление домена) — в
 * src/credentialStore.ts, этот модуль только определяет путь для конкретного
 * владельца ключа.
 */

import { join } from 'node:path';

export const CREDENTIALS_DIR = process.env.CREDENTIALS_DIR || '.credentials';

export function credentialsFileFor(apiKeyName: string): string {
  return join(CREDENTIALS_DIR, `${apiKeyName}.json`);
}
