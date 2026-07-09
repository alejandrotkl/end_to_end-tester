/**
 * Хранилище учётных данных для входа на сайты, которые отвечают HTTP 403
 * без авторизации. Данные привязаны к домену (hostname), а не к конкретной
 * ссылке — так одна пара логин/пароль работает для всех защищённых страниц
 * одного сайта.
 *
 * Файл хранилища — обычный JSON (домен -> учётные данные), путь к которому
 * передаётся тестам через переменную окружения CREDENTIALS_FILE:
 *  - в консольном режиме (src/run.ts) это единый локальный файл;
 *  - на сервере (src/server/jobRunner.ts) — свой файл на каждый API-ключ,
 *    чтобы данные разных клиентов не пересекались (см. src/server/credentialStore.ts).
 *
 * Пароли хранятся в открытом виде, как и .env — файл не должен попадать
 * в Git (см. .gitignore) и должен быть доступен только на сервере.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DomainCredential {
  domain: string;
  loginUrl: string;
  username: string;
  password: string;
  /** CSS-селектор поля логина. По умолчанию — эвристика по типу/имени поля. */
  usernameSelector?: string;
  /** CSS-селектор поля пароля. По умолчанию — input[type="password"]. */
  passwordSelector?: string;
  /** CSS-селектор кнопки отправки формы. По умолчанию — эвристика по типу/тексту. */
  submitSelector?: string;
}

const DEFAULT_STORE_PATH = join('.credentials', 'domains.json');

/** Путь к файлу хранилища из CREDENTIALS_FILE, либо путь по умолчанию для локального запуска без сервера. */
export function credentialsFilePathFromEnv(): string {
  return process.env.CREDENTIALS_FILE || DEFAULT_STORE_PATH;
}

function readStore(filePath: string): Record<string, DomainCredential> {
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, DomainCredential>;
  } catch {
    return {};
  }
}

function writeStore(filePath: string, store: Record<string, DomainCredential>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

export function getDomainCredential(filePath: string, domain: string): DomainCredential | undefined {
  return readStore(filePath)[domain];
}

export function listDomainCredentials(filePath: string): DomainCredential[] {
  return Object.values(readStore(filePath));
}

export function saveDomainCredential(filePath: string, credential: DomainCredential): void {
  const store = readStore(filePath);
  store[credential.domain] = credential;
  writeStore(filePath, store);
}

export function deleteDomainCredential(filePath: string, domain: string): boolean {
  const store = readStore(filePath);

  if (!(domain in store)) {
    return false;
  }

  delete store[domain];
  writeStore(filePath, store);
  return true;
}
