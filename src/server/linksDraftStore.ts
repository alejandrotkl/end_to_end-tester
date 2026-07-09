/**
 * Общий «черновик» списка ссылок на каждый API-ключ — то, что показано
 * в поле «Проверка ссылок» веб-интерфейса. Хранится на сервере (а не только
 * в браузере), чтобы пользователи с разных устройств/вкладок, работающие
 * с одним API-ключом, видели один и тот же список и правки друг друга —
 * веб-интерфейс периодически опрашивает GET и отправляет свои изменения
 * через PUT (см. public/app.js, refreshDraft/scheduleDraftSave).
 *
 * Это намеренно простая синхронизация «кто сохранил последним, тот и прав»,
 * без поэлементного слияния — для совместного редактирования одного
 * небольшого списка ссылок этого достаточно.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DraftLink {
  url: string;
  timeoutMs?: number;
}

export interface LinksDraft {
  links: DraftLink[];
  updatedAt: string;
}

export const DRAFTS_DIR = process.env.DRAFTS_DIR || join(process.env.JOBS_DIR || '.jobs', 'drafts');

function draftFileFor(apiKeyName: string): string {
  return join(DRAFTS_DIR, `${apiKeyName}.json`);
}

const EMPTY_DRAFT: LinksDraft = { links: [], updatedAt: new Date(0).toISOString() };

export function getLinksDraft(apiKeyName: string): LinksDraft {
  const filePath = draftFileFor(apiKeyName);

  if (!existsSync(filePath)) {
    return EMPTY_DRAFT;
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as LinksDraft;
  } catch {
    return EMPTY_DRAFT;
  }
}

export function saveLinksDraft(apiKeyName: string, links: DraftLink[]): LinksDraft {
  const draft: LinksDraft = { links, updatedAt: new Date().toISOString() };
  mkdirSync(DRAFTS_DIR, { recursive: true });
  writeFileSync(draftFileFor(apiKeyName), JSON.stringify(draft, null, 2), 'utf-8');
  return draft;
}
