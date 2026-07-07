import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_DEPTH = 6;
const MAX_ENTRIES_SCANNED = 50_000;

const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  '.cache',
  '.next',
  '.vscode',
  '.idea',
  '$RECYCLE.BIN',
  'System Volume Information',
]);

function getSearchRoots(): string[] {
  const home = homedir();

  return [
    ...new Set([
      process.cwd(),
      join(home, 'Desktop'),
      join(home, 'Documents'),
      join(home, 'Downloads'),
    ]),
  ];
}

interface SearchState {
  targetNameLower: string;
  results: string[];
  entriesScanned: number;
}

function searchDirectory(dir: string, depth: number, state: SearchState): void {
  if (depth > MAX_DEPTH || state.entriesScanned >= MAX_ENTRIES_SCANNED) {
    return;
  }

  let entries;

  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (state.entriesScanned >= MAX_ENTRIES_SCANNED) {
      return;
    }

    state.entriesScanned += 1;

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || IGNORED_DIR_NAMES.has(entry.name)) {
        continue;
      }

      searchDirectory(join(dir, entry.name), depth + 1, state);
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase() === state.targetNameLower) {
      state.results.push(join(dir, entry.name));
    }
  }
}

/**
 * Ищет файл по имени в папке проекта и стандартных пользовательских папках
 * (Рабочий стол, Документы, Загрузки), чтобы не требовать от пользователя
 * ввода полного пути.
 */
export function searchCommonFolders(fileName: string): string[] {
  const state: SearchState = {
    targetNameLower: fileName.toLowerCase(),
    results: [],
    entriesScanned: 0,
  };

  for (const root of getSearchRoots()) {
    let rootStat;

    try {
      rootStat = statSync(root);
    } catch {
      continue;
    }

    if (!rootStat.isDirectory()) {
      continue;
    }

    searchDirectory(root, 0, state);
  }

  return [...new Set(state.results)];
}
