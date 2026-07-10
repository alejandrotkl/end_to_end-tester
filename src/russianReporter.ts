import { appendFileSync, writeFileSync, writeSync } from 'node:fs';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { LOG_FILE, PROGRESS_JSON_FILE, RESULTS_JSON_FILE, type LinkResult } from './linkReport.js';
import { getNotificationSettings, sendTelegramMessage, type NotificationSettings } from './notifier.js';

const ATTACHMENT_NAME = 'link-result';

// Заголовок теста в tests/links.spec.ts — "проверка ссылки: <url>". Отсюда
// достаём саму ссылку для файла прогресса, чтобы не тащить её отдельным
// параметром через attachment ради одного onTestBegin.
const TITLE_PREFIX = 'проверка ссылки: ';

function urlFromTitle(title: string): string {
  return title.startsWith(TITLE_PREFIX) ? title.slice(TITLE_PREFIX.length) : title;
}

/**
 * Пишем в stdout синхронно: при запуске через API-сервер stdout дочернего
 * процесса — pipe (не TTY), и обычный console.log может буферизоваться.
 * Формат строк — как раньше: [УСПЕХ]/[ОШИБКА] из logLinkResult, итоги отсюда.
 */
function printLine(line: string): void {
  writeSync(1, `${line}\n`);
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/** Одна строка — максимально короткое описание причины ошибки для уведомления. */
function shortErrorReason(result: LinkResult): string {
  if (result.needsLogin) {
    return 'требуется вход (данные не настроены)';
  }
  if (result.error) {
    // Первая строка сообщения об ошибке обычно и есть суть (Playwright
    // кладёт технические детали/diff дальше) — этого достаточно для уведомления.
    const firstLine = result.error.split('\n')[0]?.trim() || result.error;
    return truncate(firstLine, 200);
  }
  return `HTTP ${result.status ?? 'нет ответа'}`;
}

class RussianReporter implements Reporter {
  private results: LinkResult[] = [];
  private total = 0;
  /** Настройки уведомлений читаются один раз на весь прогон (не на каждую ссылку). */
  private notificationSettings: NotificationSettings | undefined;
  private jobLabel = '';

  onBegin(_config: FullConfig, suite: Suite): void {
    this.total = suite.allTests().length;
    printLine(`\nЗапуск тестов: ${this.total}\n`);
    this.writeProgress(null);

    const notificationsFile = process.env.NOTIFICATIONS_FILE;
    if (notificationsFile) {
      try {
        this.notificationSettings = getNotificationSettings(notificationsFile);
      } catch {
        this.notificationSettings = undefined;
      }
    }
    this.jobLabel = (process.env.JOB_ID || '').slice(0, 8);
  }

  onStdOut(chunk: string | Buffer): void {
    process.stdout.write(chunk);
  }

  onStdErr(chunk: string | Buffer): void {
    process.stderr.write(chunk);
  }

  /**
   * Пишем файл прогресса и в начале, и в конце каждой ссылки — так
   * веб-интерфейс (см. GET /api/v1/jobs/:id/progress) может показывать,
   * какая ссылка проверяется прямо сейчас, и результаты уже готовых, не
   * дожидаясь завершения всей задачи (это может занимать заметное время
   * при большом списке ссылок).
   */
  onTestBegin(test: TestCase): void {
    this.writeProgress(urlFromTitle(test.title));
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    // Собираем результат через attachment, а не через переменную в памяти
    // теста: Playwright может перезапускать воркер-процесс после упавшего
    // теста, а репортер (в отличие от воркеров) живёт в одном процессе
    // на весь прогон — только так итоговая сводка не теряет данные.
    const attachment = result.attachments.find(
      (item) => item.name === ATTACHMENT_NAME,
    );

    let linkResult: LinkResult | undefined;

    if (attachment?.body) {
      try {
        linkResult = JSON.parse(attachment.body.toString('utf-8')) as LinkResult;
        this.results.push(linkResult);
      } catch {
        // Повреждённый attachment — пропускаем, чтобы не падать в репортере.
      }
    }

    this.writeProgress(null);

    // Строки [УСПЕХ]/[ОШИБКА] уже печатает logLinkResult в воркере.
    // Здесь — только если attachment не пришёл, а тест упал.
    if (!attachment?.body && (result.status === 'failed' || result.status === 'timedOut')) {
      printLine(`✗ ОШИБКА: ${test.title}`);
      for (const testError of result.errors) {
        if (testError.message) {
          printLine(testError.message);
        }
      }
    }

    // Уведомление в Telegram сразу при обнаружении ошибки на ссылке — не
    // дожидаясь конца всей задачи (список ссылок может проверяться долго).
    if (linkResult && !linkResult.passed) {
      await this.notifyLinkFailed(linkResult);
    }
  }

  private async notifyLinkFailed(result: LinkResult): Promise<void> {
    const settings = this.notificationSettings;
    if (!settings?.enabled || !settings.botToken || !settings.chatId) {
      return;
    }

    const jobPrefix = this.jobLabel ? `[job ${this.jobLabel}] ` : '';
    const text = `❌ ${jobPrefix}${result.url}\n${shortErrorReason(result)}`;

    try {
      const sendResult = await sendTelegramMessage(settings.botToken, settings.chatId, text);
      if (!sendResult.ok) {
        printLine(`[уведомления] Не удалось отправить в Telegram: ${sendResult.error}`);
      }
    } catch {
      // Сбой отправки уведомления не должен влиять на сам прогон тестов.
    }
  }

  private writeProgress(current: string | null): void {
    try {
      writeFileSync(
        PROGRESS_JSON_FILE,
        JSON.stringify(
          {
            total: this.total,
            completed: this.results.length,
            current,
            results: this.results,
          },
          null,
          2,
        ),
        'utf-8',
      );
    } catch {
      // Файл прогресса — вспомогательный (для live-просмотра), сбой записи
      // не должен прерывать сам прогон тестов.
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

    printLine(summary);
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

    this.writeProgress(null);

    const seconds = (result.duration / 1000).toFixed(1);
    const statusText =
      result.status === 'passed'
        ? 'Все тесты успешно пройдены'
        : 'Обнаружены ошибки в тестах';

    printLine(`\n${statusText} (${seconds} с)\n`);
  }
}

export default RussianReporter;
