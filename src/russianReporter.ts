import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

class RussianReporter implements Reporter {
  onBegin(config: FullConfig, suite: Suite): void {
    console.log(
      `\nЗапуск тестов: ${suite.allTests().length} (воркеров: ${config.workers})\n`,
    );
  }

  onStdOut(chunk: string | Buffer): void {
    process.stdout.write(chunk);
  }

  onStdErr(chunk: string | Buffer): void {
    process.stderr.write(chunk);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
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
    const seconds = (result.duration / 1000).toFixed(1);
    const statusText =
      result.status === 'passed'
        ? 'Все тесты успешно пройдены'
        : 'Обнаружены ошибки в тестах';

    console.log(`\n${statusText} (${seconds} с)\n`);
  }
}

export default RussianReporter;
