import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadLinks } from './loadLinks.js';

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);

  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

async function resolveLinksFile(): Promise<string> {
  const fromArg = getArgValue('--file') ?? getArgValue('-f');

  if (fromArg) {
    return resolve(fromArg);
  }

  const rl = createInterface({ input, output });

  try {
    const answer = await rl.question(
      'Введите путь к файлу со ссылками (.txt или .json): ',
    );
    return resolve(answer.trim());
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const linksFile = await resolveLinksFile();

  if (!existsSync(linksFile)) {
    console.error(`Файл не найден: ${linksFile}`);
    process.exit(1);
  }

  const links = loadLinks(linksFile);
  console.log(`Загружено ссылок: ${links.length} (файл: ${linksFile})`);

  const result = spawnSync(
    'npx',
    ['playwright', 'test'],
    {
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        LINKS_FILE: linksFile,
      },
    },
  );

  process.exit(result.status ?? 1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
