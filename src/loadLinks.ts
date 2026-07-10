import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const URL_PATTERN = /^https?:\/\/.+/i;

/**
 * Условие успеха по структуре HTML (поля UI: Путь / Тег / Класс / Текст).
 * kind selector/text — устаревшие форматы, ещё читаются из старых черновиков.
 */
export type LinkRequireKind = 'element' | 'selector' | 'text';

export interface LinkRequireCondition {
  kind: LinkRequireKind;
  /**
   * Путь — только родительские теги до цели (саму цель не писать).
   * Пример: `tr`, `tbody tr`, `form`, `nav ul`
   */
  path?: string;
  /**
   * Тег — имя искомого элемента.
   * Пример: `td`, `button`, `a`, `div`
   */
  tag?: string;
  /**
   * Класс — можно вставить class целиком из DevTools.
   * При проверке layout/responsive-шум (xl:, tablet/desktop, […]) отбрасывается.
   */
  classes?: string;
  /**
   * Текст — точный прямой текст узла (не из вложенных тегов).
   * Пример: `9`, `Войти`, `Сохранить`
   */
  text?: string;
  /** Устаревшее: CSS-селектор или текст страницы */
  value?: string;
}

export interface LinkInput {
  url: string;
  /** Порядковый номер в списке — чем меньше, тем раньше проверяется ссылка. По умолчанию — порядок в файле/списке. */
  priority: number;
  /** Сколько ждать ответа/загрузки, прежде чем считать ссылку ошибочной (мс). */
  timeoutMs: number;
  /** Доп. условия успеха (элемент на странице). */
  require?: LinkRequireCondition[];
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

/** Разбирает class="..." или просто список классов через пробел. */
export function parseClassList(raw: string): string[] {
  let text = raw.trim();
  if (!text) return [];

  const attrMatch = text.match(/^class\s*=\s*["']?([^"']*)["']?$/i);
  if (attrMatch) {
    text = attrMatch[1];
  } else {
    text = text.replace(/^["']|["']$/g, '');
  }

  return text
    .split(/\s+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Layout / breakpoint / arbitrary Tailwind — не идентичность элемента.
 * Тематические class (`*theme*`) оставляем даже с tablet/desktop в имени:
 * это не layout, а подпись элемента (text-theme-tablet-num-1).
 */
export function isNoiseClass(className: string): boolean {
  const token = className.trim();
  if (!token) return true;

  // Произвольные значения: !w-[var(--tablet-width)], xl:!w-[…]
  if (token.includes('[')) return true;

  // Тема/дизайн-токены — всегда значимы (даже text-theme-tablet-…)
  if (/theme/i.test(token)) return false;

  // Явные viewport/device маркеры в имени (не theme)
  if (/tablet|desktop|mobile|breakpoint/i.test(token)) return true;

  const withoutImportant = token.replace(/^!+/, '');
  // Варианты: sm: md: lg: xl: 2xl: dark: hover: group-hover: …
  const base = withoutImportant.replace(/^(?:[a-z0-9_-]+:)+/i, '').replace(/^!+/, '');
  if (!base) return true;

  // Размеры, отступы, flex/grid, позиционирование — часто отличаются по брейкпоинту
  if (
    /^(?:w|h|min-w|max-w|min-h|max-h|size|p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap|space-[xy]|inset|top|left|right|bottom|start|end|basis|grow|shrink|order|col-span|row-span|columns|grid-cols|grid-rows|auto-cols|auto-rows|z|opacity|translate|rotate|scale|skew|origin|duration|delay|ease|transition|animate|shadow|ring|outline|overflow|object|justify|items|content|self|place|cursor|font|leading|tracking|whitespace|break|hyphens|content)-/i.test(
      base,
    )
  ) {
    return true;
  }

  if (
    /^(?:flex|inline-flex|grid|inline-grid|block|inline-block|inline|contents|hidden|sr-only|truncate|grow|shrink|basis|relative|absolute|fixed|sticky|static|font-medium|font-bold|font-semibold|font-normal|italic|underline|antialiased)$/i.test(
      base,
    )
  ) {
    return true;
  }

  // border / rounded без «темы» — декоративная обвязка
  if (/^border(?:-[trblxyse]{1,2})?$/i.test(base)) return true;
  if (/^rounded(?:-[trblxyse]{1,2})?(?:-(?:sm|md|lg|xl|2xl|3xl|full))?$/i.test(base)) return true;

  return false;
}

/**
 * Нормализация class для сравнения:
 * xl:text-theme-num-1 и text-theme-tablet-num-1 → text-theme-num-1
 */
export function classFingerprint(className: string): string {
  let token = className.trim().replace(/^!+/, '');
  token = token.replace(/^(?:[a-z0-9_-]+:)+/i, '').replace(/^!+/, '');
  token = token.replace(/-tablet-|-desktop-|-mobile-/gi, '-');
  return token.toLowerCase();
}

/**
 * Значимые классы для поиска: из полной вставки DevTools.
 * Если есть theme-* — используем только их (надёжнее, чем font-medium + xl:…).
 */
export function significantClasses(rawOrList: string | string[]): string[] {
  const list = Array.isArray(rawOrList) ? rawOrList : parseClassList(rawOrList);
  const kept = list.filter((name) => !isNoiseClass(name));
  const preferred = kept.some((name) => /theme/i.test(name))
    ? kept.filter((name) => /theme/i.test(name))
    : kept;

  const seen = new Set<string>();
  const result: string[] = [];

  for (const name of preferred) {
    const fp = classFingerprint(name);
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    result.push(name);
  }

  return result;
}

/** Отпечатки значимых class — ими ищем на элементе. */
export function significantClassFingerprints(rawOrList: string | string[]): string[] {
  return significantClasses(rawOrList).map((name) => classFingerprint(name));
}

/** Путь тегов: «tbody > tr td» или «tbody td» → ['tbody','tr','td'] (только имена тегов). */
export function parseElementPath(raw: string): string[] {
  return raw
    .split(/[\s>]+/)
    .map((part) => part.trim().toLowerCase().replace(/[^a-z0-9_-]/gi, ''))
    .filter(Boolean);
}

/**
 * Экранирование токена для CSS-идентификатора (полифилл CSS.escape).
 * Нужен для Tailwind-классов вроде p-1.5 и xl:p-2.
 */
export function escapeCssIdent(value: string): string {
  const string = String(value);
  let result = '';
  const first = string.charCodeAt(0);

  for (let index = 0; index < string.length; index += 1) {
    const code = string.charCodeAt(index);
    if (code === 0x0000) {
      result += '\uFFFD';
      continue;
    }
    if (
      (code >= 0x0001 && code <= 0x001f) ||
      code === 0x007f ||
      (index === 0 && code >= 0x0030 && code <= 0x0039) ||
      (index === 1 && code >= 0x0030 && code <= 0x0039 && first === 0x002d)
    ) {
      result += `\\${code.toString(16)} `;
      continue;
    }
    if (
      code >= 0x0080 ||
      code === 0x002d ||
      code === 0x005f ||
      (code >= 0x0030 && code <= 0x0039) ||
      (code >= 0x0041 && code <= 0x005a) ||
      (code >= 0x0061 && code <= 0x007a)
    ) {
      result += string.charAt(index);
      continue;
    }
    result += `\\${string.charAt(index)}`;
  }

  return result;
}

/**
 * Собирает CSS-селектор из пути / тега / class (как в HTML).
 * Пример: path=tbody td, tag=a, classes="flex p-1.5" → `tbody td a.flex.p-1\.5`
 */
export function buildElementSelector(condition: {
  path?: string;
  tag?: string;
  classes?: string;
}): string {
  const pathTags = condition.path ? parseElementPath(condition.path) : [];
  const tag = (condition.tag || '').trim().toLowerCase();
  const classes = condition.classes ? significantClasses(condition.classes) : [];
  const classPart = classes.map((name) => `.${escapeCssIdent(name)}`).join('');

  let leaf: string;
  if (tag) {
    leaf = `${tag}${classPart}`;
  } else if (classPart) {
    leaf = classPart;
  } else {
    leaf = '*';
  }

  if (pathTags.length === 0) {
    return leaf;
  }

  return `${pathTags.join(' ')} ${leaf}`;
}

function parseOneRequireCondition(item: unknown): LinkRequireCondition | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const obj = item as Record<string, unknown>;
  const kindRaw = typeof obj.kind === 'string' ? obj.kind.trim().toLowerCase() : '';

  // Новый формат: element (path / tag / classes / text)
  if (
    kindRaw === 'element' ||
    obj.path !== undefined ||
    obj.tag !== undefined ||
    obj.classes !== undefined ||
    (obj.text !== undefined && kindRaw !== 'text' && kindRaw !== 'selector')
  ) {
    const path = typeof obj.path === 'string' ? obj.path.trim() : undefined;
    const tag = typeof obj.tag === 'string' ? obj.tag.trim().toLowerCase() : undefined;
    const classes = typeof obj.classes === 'string' ? obj.classes.trim() : undefined;
    const text = typeof obj.text === 'string' ? obj.text : undefined;

    if (!path && !tag && !classes && (text === undefined || text === '')) {
      return null;
    }

    return {
      kind: 'element',
      ...(path ? { path } : {}),
      ...(tag ? { tag } : {}),
      ...(classes ? { classes } : {}),
      ...(text !== undefined && text !== '' ? { text } : {}),
    };
  }

  // Устаревшие: selector / text с value
  if (kindRaw === 'selector' || kindRaw === 'text') {
    const value = typeof obj.value === 'string' ? obj.value.trim() : '';
    if (!value) return null;
    return { kind: kindRaw as 'selector' | 'text', value };
  }

  // Строка в value без kind — считаем CSS-селектором
  if (typeof obj.value === 'string' && obj.value.trim()) {
    return { kind: 'selector', value: obj.value.trim() };
  }

  return null;
}

/** Разбирает require из JSON/черновика: массив условий или одно условие. */
export function parseRequireConditions(raw: unknown): LinkRequireCondition[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  const items = Array.isArray(raw) ? raw : [raw];
  const parsed = items
    .map((item) => parseOneRequireCondition(item))
    .filter((item): item is LinkRequireCondition => item !== null);

  return parsed.length > 0 ? parsed : undefined;
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
 * { url, priority?, timeoutMs?, require? } — так собирается список из веб-интерфейса
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

    const require = parseRequireConditions(obj.require);

    return {
      url,
      priority: normalizePriority(obj.priority, fallbackPriority),
      timeoutMs: obj.timeoutMs !== undefined ? normalizeTimeoutMs(obj.timeoutMs) : DEFAULT_LINK_TIMEOUT_MS,
      ...(require ? { require } : {}),
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
