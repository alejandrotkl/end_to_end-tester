import { config as loadEnv } from 'dotenv';

// dotenv нужно загрузить до того, как выполнится код модулей сервера — а в
// ESM статические import поднимаются наверх и вычисляются до остального
// кода файла, независимо от того, где текстуально стоит вызов loadEnv().
// Поэтому модули сервера (где часть настроек — это константы уровня
// модуля, например JOBS_DIR или MAX_CONCURRENT_JOBS) подключаем через
// динамический import() уже после загрузки .env.
loadEnv({ quiet: true });

const { createApp } = await import('./server/app.js');
const { loadJobsFromDisk } = await import('./server/jobStore.js');
const { loadSchedulesFromDisk } = await import('./server/scheduleStore.js');
const { resumeSchedulesOnStartup } = await import('./server/scheduler.js');
const { startCleanupSchedule } = await import('./server/cleanup.js');

const PORT = Number(process.env.PORT) || 3000;

loadJobsFromDisk();
loadSchedulesFromDisk();

const app = createApp();

app.listen(PORT, () => {
  console.log(`API-сервер Playwright Link Tester запущен: http://localhost:${PORT}`);
  console.log(`Проверка состояния: GET http://localhost:${PORT}/health`);
  resumeSchedulesOnStartup();
  startCleanupSchedule();
});
