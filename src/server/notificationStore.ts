/**
 * Настройки Telegram-уведомлений на сервере хранятся отдельным файлом на
 * каждый API-ключ (.notifications/<имя ключа>.json) — как и учётные данные
 * для входа (см. src/server/credentialStore.ts). Сама работа с файлом —
 * в src/notifier.ts, этот модуль только определяет путь для конкретного
 * владельца ключа.
 */

import { join } from 'node:path';

export const NOTIFICATIONS_DIR = process.env.NOTIFICATIONS_DIR || '.notifications';

export function notificationsFileFor(apiKeyName: string): string {
  return join(NOTIFICATIONS_DIR, `${apiKeyName}.json`);
}
