import { initLinkLog } from './linkReport.js';

/**
 * Выполняется Playwright ровно один раз за весь тестовый прогон, в отдельном
 * процессе — в отличие от test.beforeAll(), который выполняется заново
 * в каждом воркере (в т.ч. после перезапуска воркера из-за упавшего теста).
 */
export default function globalSetup(): void {
  initLinkLog();
}
