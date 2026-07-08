import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { basename, resolve } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { loadLinks } from './loadLinks.js';
import { searchCommonFolders } from './findFile.js';

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);

  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

async function askQuestion(question: string): Promise<string> {
  const rl = createInterface({ input, output });

  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function resolveLinksInput(): Promise<string> {
  const fromArg = getArgValue('--file') ?? getArgValue('-f');

  if (fromArg) {
    return fromArg;
  }

  return askQuestion('Введите путь или имя файла со ссылками (.txt или .json): ');
}

async function chooseFromMatches(matches: string[]): Promise<string> {
  console.log('\nНайдено несколько файлов с таким именем:');
  matches.forEach((match, index) => {
    console.log(`  ${index + 1}. ${match}`);
  });

  for (;;) {
    const answer = await askQuestion(
      `\nВведите номер нужного файла (1-${matches.length}): `,
    );
    const choice = Number(answer);

    if (Number.isInteger(choice) && choice >= 1 && choice <= matches.length) {
      return matches[choice - 1];
    }

    console.log('Некорректный номер, попробуйте снова.');
  }
}

async function resolveLinksFile(requestedPath: string): Promise<string> {
  const directCandidate = resolve(requestedPath);

  if (existsSync(directCandidate)) {
    if (!statSync(directCandidate).isFile()) {
      console.error(`Указанный путь не является файлом: ${directCandidate}`);
      process.exit(1);
    }

    return directCandidate;
  }

  const fileName = basename(requestedPath);
  console.log(
    `Файл не найден по прямому пути, ищу «${fileName}» в папке проекта, на Рабочем столе, в Документах и Загрузках...`,
  );

  const matches = searchCommonFolders(fileName);

  if (matches.length === 0) {
    console.error(`Файл не найден: ${directCandidate}`);
    console.error('Поиск в стандартных папках тоже не дал результатов.');
    process.exit(1);
  }

  if (matches.length === 1) {
    console.log(`Найден файл: ${matches[0]}`);
    return matches[0];
  }

  return chooseFromMatches(matches);
}

async function main(): Promise<void> {
  const requestedPath = await resolveLinksInput();
  const linksFile = await resolveLinksFile(requestedPath);

  const links = loadLinks(linksFile);
  console.log(`Загружено ссылок: ${links.length} (файл: ${linksFile})`);

  // Команда передаётся одной строкой, а не через args-массив: так shell
  // сам находит npx (в т.ч. npx.cmd на Windows) и не возникает
  // предупреждения Node о неэкранированных аргументах (DEP0190), которое
  // появляется при combining shell: true с массивом args.
  const result = spawnSync('npx playwright test', {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      LINKS_FILE: linksFile,
    },
  });

  if (result.error) {
    console.error(`Не удалось запустить Playwright: ${result.error.message}`);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
