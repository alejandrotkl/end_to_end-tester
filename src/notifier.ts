/**
 * Уведомления администратора об ошибках через Telegram-бота.
 *
 * Настройки (токен бота + chat id) хранятся так же, как учётные данные
 * для входа (см. src/credentialStore.ts) — отдельным JSON-файлом на каждый
 * API-ключ, путь к которому задаёт src/server/notificationStore.ts.
 *
 * Отправка сообщений идёт напрямую через Bot API Telegram (без сторонних
 * библиотек) — достаточно одного POST-запроса на sendMessage.
 * См. https://core.telegram.org/bots/api#sendmessage
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface NotificationSettings {
  botToken: string;
  chatId: string;
  /** Уведомления можно временно выключить, не удаляя токен/chat id. */
  enabled: boolean;
}

function readSettings(filePath: string): NotificationSettings | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as NotificationSettings;
  } catch {
    return undefined;
  }
}

export function getNotificationSettings(filePath: string): NotificationSettings | undefined {
  return readSettings(filePath);
}

export function saveNotificationSettings(filePath: string, settings: NotificationSettings): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf-8');
}

export function deleteNotificationSettings(filePath: string): boolean {
  if (!existsSync(filePath)) {
    return false;
  }
  unlinkSync(filePath);
  return true;
}

/** Показывает только последние символы токена — чтобы подтвердить, что он задан, не раскрывая секрет целиком. */
export function maskToken(token: string): string {
  if (token.length <= 6) {
    return '••••';
  }
  return `••••${token.slice(-4)}`;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

/** Отправляет текстовое сообщение через Bot API Telegram. */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<SendResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });

    const data = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;

    if (!res.ok || !data?.ok) {
      return { ok: false, error: data?.description || `Telegram API вернул статус ${res.status}.` };
    }

    return { ok: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Не удалось обратиться к Telegram API: ${message}` };
  }
}
