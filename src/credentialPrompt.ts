/**
 * Интерактивный запрос данных для входа в консольном режиме (npm test).
 * Используется только тогда, когда ссылка вернула HTTP 403 и для её домена
 * ещё нет сохранённых данных в хранилище (см. credentialStore.ts) — на сервере
 * (без реального терминала) этот запрос не вызывается, там нужно заранее
 * настроить данные через API/веб-интерфейс.
 *
 * Ввод пароля в терминале не скрывается точками — это ограничение простого
 * readline без дополнительных зависимостей. Не запускайте консольный режим
 * там, где экран виден посторонним.
 */

import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { DomainCredential } from './credentialStore.js';

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input, output });

  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function isYes(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes' || normalized === 'д' || normalized === 'да';
}

export async function promptForCredential(domain: string): Promise<DomainCredential | undefined> {
  console.log(`\nСайт «${domain}» требует вход (HTTP 403 или показана форма логина).`);
  const wantsLogin = await ask('Ввести данные для входа и повторить проверку? (y/n): ');

  if (!isYes(wantsLogin)) {
    return undefined;
  }

  const loginUrl = await ask(
    `Адрес страницы входа для ${domain} (Enter — если форма входа показывается прямо на проверяемой странице): `,
  );

  const username = await ask('Логин: ');
  const password = await ask('Пароль: ');

  if (!username || !password) {
    console.log('Логин и пароль обязательны, вход выполнить не удастся.');
    return undefined;
  }

  return { domain, loginUrl: loginUrl || undefined, username, password };
}
