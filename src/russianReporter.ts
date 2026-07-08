import { appendFileSync, writeFileSync } from 'node:fs';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { LOG_FILE, RESULTS_JSON_FILE, type LinkResult } from './linkReport.js';

const ATTACHMENT_NAME = 'link-result';

class RussianReporter implements Reporter {
  private results: LinkResult[] = [];

  onBegin(_config: FullConfig, suite: Suite): void {
    console.log(`\nЗапуск тестов: ${suite.allTests().length}\n`);
  }

  onStdOut(chunk: string | Buffer): void {
    process.stdout.write(chunk);
  }

  onStdErr(chunk: string | Buffer): void {
    process.stderr.write(chunk);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // Собираем результат через attachment, а не через переменную в памяти
    // теста: Playwright может перезапускать воркер-процесс после упавшего
    // теста, а репортер (в отличие от воркеров) живёт в одном процессе
    // на весь прогон — только так итоговая сводка не теряет данные.
    const attachment = result.attachments.find(
      (item) => item.name === ATTACHMENT_NAME,
    );

    if (attachment?.body) {
      try {
        const data = JSON.parse(attachment.body.toString('utf-8')) as LinkResult;
        this.results.push(data);
      } catch {
        // Повреждённый attachment — пропускаем, чтобы не падать в репортере.
      }
    }

    if (result.status === 'failed' || result.status === 'timedOut') {
      console.log(`✗ ОШИБКА: ${test.title}`);

      for (const testError of result.errors) {
        if (testError.message) {
          console.log(testError.message);
        }
      }
    }
  }

  onEnd(result: FullResult): void {
    const passed = this.results.filter((r) => r.passed).length;
    const failed = this.results.length - passed;
    const avgLoad =
      this.results.length > 0
        ? Math.round(
            this.results.reduce((sum, r) => sum + r.loadMs, 0) /
              this.results.length,
          )
        : 0;
    const avgTotal =
      this.results.length > 0
        ? Math.round(
            this.results.reduce((sum, r) => sum + r.totalMs, 0) /
              this.results.length,
          )
        : 0;

    const summary = [
      '',
      '--- Итоги ---',
      `Всего: ${this.results.length} | Успешно: ${passed} | Ошибок: ${failed}`,
      `Среднее время загрузки: ${avgLoad} мс | Среднее общее время: ${avgTotal} мс`,
      `Файл лога: ${LOG_FILE}`,
    ].join('\n');

    console.log(summary);
    appendFileSync(LOG_FILE, `${summary}\n`, 'utf-8');

    // Структурированный результат для программной обработки — им пользуется
    // API-сервер, чтобы вернуть клиенту JSON, не разбирая текстовый лог.
    writeFileSync(
      RESULTS_JSON_FILE,
      JSON.stringify(
        {
          finishedAt: new Date().toISOString(),
          durationMs: result.duration,
          total: this.results.length,
          passed,
          failed,
          avgLoadMs: avgLoad,
          avgTotalMs: avgTotal,
          results: this.results,
        },
        null,
        2,
      ),
      'utf-8',
    );

    const seconds = (result.duration / 1000).toFixed(1);
    const statusText =
      result.status === 'passed'
        ? 'Все тесты успешно пройдены'
        : 'Обнаружены ошибки в тестах';

    console.log(`\n${statusText} (${seconds} с)\n`);
  }
}

export default RussianReporter;
