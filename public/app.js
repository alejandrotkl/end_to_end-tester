// Простой интерфейс поверх API сервера (см. README.md, раздел "Запуск как
// сервер (API)"). Без сборки и фреймворков — обычный fetch() к /api/v1/*.

const state = {
  apiKey: localStorage.getItem('apiKey') || '',
};

const els = {
  apiKeyInput: document.getElementById('api-key'),
  saveKeyBtn: document.getElementById('save-key'),
  keyStatus: document.getElementById('key-status'),
  errorBox: document.getElementById('error-box'),

  manualLinks: document.getElementById('manual-links'),
  manualFile: document.getElementById('manual-file'),
  manualRun: document.getElementById('manual-run'),
  manualStatus: document.getElementById('manual-status'),
  manualResults: document.getElementById('manual-results'),

  jobsRefresh: document.getElementById('jobs-refresh'),
  jobsTableBody: document.querySelector('#jobs-table tbody'),

  scheduleLinks: document.getElementById('schedule-links'),
  scheduleFile: document.getElementById('schedule-file'),
  scheduleInterval: document.getElementById('schedule-interval'),
  scheduleSave: document.getElementById('schedule-save'),
  scheduleRun: document.getElementById('schedule-run'),
  scheduleStop: document.getElementById('schedule-stop'),
  scheduleStatus: document.getElementById('schedule-status'),
};

els.apiKeyInput.value = state.apiKey;
updateKeyStatus();

function updateKeyStatus() {
  els.keyStatus.textContent = state.apiKey ? 'ключ сохранён в этом браузере' : 'ключ не задан';
}

function showError(message) {
  els.errorBox.textContent = message;
  els.errorBox.classList.remove('hidden');
}

function clearError() {
  els.errorBox.classList.add('hidden');
  els.errorBox.textContent = '';
}

async function api(path, { method = 'GET', jsonBody, formBody, expectNoContent = false } = {}) {
  const headers = { 'X-API-Key': state.apiKey };
  let body;

  if (jsonBody !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(jsonBody);
  } else if (formBody !== undefined) {
    // Content-Type для multipart/form-data (с границей) браузер выставляет
    // сам — вручную его указывать нельзя, иначе граница потеряется.
    body = formBody;
  }

  const res = await fetch(`/api/v1${path}`, { method, headers, body });

  if (expectNoContent && res.status === 204) {
    return null;
  }

  const text = await res.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!res.ok) {
    throw new Error((data && data.error) || `Ошибка запроса: ${res.status}`);
  }

  return data;
}

function parseLinksTextarea(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function buildFormData(file, extraFields) {
  const formData = new FormData();
  formData.append('file', file);

  for (const [key, value] of Object.entries(extraFields || {})) {
    formData.append(key, String(value));
  }

  return formData;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU');
}

function statusBadge(status) {
  const labels = { pending: 'в очереди', running: 'выполняется', completed: 'готово', failed: 'ошибка' };
  return `<span class="badge ${status}">${labels[status] || status}</span>`;
}

// --- API-ключ ---

els.saveKeyBtn.addEventListener('click', () => {
  state.apiKey = els.apiKeyInput.value.trim();
  localStorage.setItem('apiKey', state.apiKey);
  updateKeyStatus();
  clearError();
  refreshJobs();
  refreshSchedule();
});

// --- Ручная проверка ---

els.manualRun.addEventListener('click', async () => {
  clearError();
  const file = els.manualFile.files[0];
  const links = parseLinksTextarea(els.manualLinks.value);

  if (!file && links.length === 0) {
    showError('Добавьте хотя бы одну ссылку или выберите файл.');
    return;
  }

  els.manualRun.disabled = true;
  els.manualStatus.textContent = 'Создание задачи...';
  els.manualResults.innerHTML = '';

  try {
    const job = file
      ? await api('/jobs', { method: 'POST', formBody: buildFormData(file) })
      : await api('/jobs', { method: 'POST', jsonBody: { links } });

    await pollJobToCompletion(job.id, (status) => {
      els.manualStatus.textContent = `Статус: ${status}...`;
    });

    const results = await api(`/jobs/${job.id}/results`);
    renderManualResults(results);
    els.manualStatus.textContent = `Готово: успешно ${results.passed} из ${results.total}.`;
  } catch (error) {
    showError(error.message);
    els.manualStatus.textContent = '';
  } finally {
    els.manualRun.disabled = false;
    refreshJobs();
  }
});

async function pollJobToCompletion(id, onStatus) {
  for (;;) {
    const job = await api(`/jobs/${id}`);
    onStatus(job.status);

    if (job.status === 'completed') {
      return job;
    }

    if (job.status === 'failed') {
      throw new Error(job.error || 'Задача завершилась с ошибкой.');
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function renderManualResults(results) {
  const rows = results.results
    .map(
      (r) => `
      <tr>
        <td class="link-cell">${escapeHtml(r.url)}</td>
        <td>${r.status ?? '—'}</td>
        <td>${r.loadMs ?? '—'}</td>
        <td>${r.totalMs ?? '—'}</td>
        <td>${r.passed ? '✅' : '❌'}</td>
      </tr>`,
    )
    .join('');

  els.manualResults.innerHTML = `
    <table>
      <thead>
        <tr><th>Ссылка</th><th>HTTP</th><th>Загрузка, мс</th><th>Всего, мс</th><th>Итог</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// --- Список задач ---

els.jobsRefresh.addEventListener('click', () => refreshJobs());

async function refreshJobs() {
  if (!state.apiKey) return;

  try {
    const jobs = await api('/jobs');
    renderJobsTable(jobs);
  } catch (error) {
    showError(error.message);
  }
}

function renderJobsTable(jobs) {
  if (jobs.length === 0) {
    els.jobsTableBody.innerHTML = '<tr><td colspan="6">Задач пока нет.</td></tr>';
    return;
  }

  els.jobsTableBody.innerHTML = jobs
    .map((job) => {
      const summary = job.summary ? `${job.summary.passed}/${job.summary.total}` : '—';
      const canDelete = job.status === 'completed' || job.status === 'failed';

      return `
        <tr>
          <td title="${job.id}">${job.id.slice(0, 8)}</td>
          <td>${statusBadge(job.status)}</td>
          <td>${fmtDate(job.createdAt)}</td>
          <td>${job.totalLinks}</td>
          <td>${summary}</td>
          <td>
            ${job.status === 'completed' ? `<button class="secondary small-btn" data-results="${job.id}">Результаты</button>` : ''}
            ${canDelete ? `<button class="danger small-btn" data-delete="${job.id}">Удалить</button>` : ''}
          </td>
        </tr>`;
    })
    .join('');
}

els.jobsTableBody.addEventListener('click', async (event) => {
  const resultsId = event.target.getAttribute('data-results');
  const deleteId = event.target.getAttribute('data-delete');

  clearError();

  if (resultsId) {
    try {
      const results = await api(`/jobs/${resultsId}/results`);
      renderManualResults(results);
      els.manualStatus.textContent = `Результаты задачи ${resultsId.slice(0, 8)}: успешно ${results.passed} из ${results.total}.`;
      els.manualResults.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) {
      showError(error.message);
    }
  }

  if (deleteId) {
    try {
      await api(`/jobs/${deleteId}`, { method: 'DELETE', expectNoContent: true });
      refreshJobs();
    } catch (error) {
      showError(error.message);
    }
  }
});

// --- Расписание ---

els.scheduleSave.addEventListener('click', async () => {
  clearError();
  const file = els.scheduleFile.files[0];
  const links = parseLinksTextarea(els.scheduleLinks.value);

  if (!file && links.length === 0) {
    showError('Добавьте хотя бы одну ссылку для расписания или выберите файл.');
    return;
  }

  const intervalMinutes = Number(els.scheduleInterval.value) || 5;

  els.scheduleSave.disabled = true;

  try {
    if (file) {
      await api('/schedule', { method: 'PUT', formBody: buildFormData(file, { intervalMinutes }) });
    } else {
      await api('/schedule', { method: 'PUT', jsonBody: { links, intervalMinutes } });
    }
    await refreshSchedule();
  } catch (error) {
    showError(error.message);
  } finally {
    els.scheduleSave.disabled = false;
  }
});

els.scheduleRun.addEventListener('click', async () => {
  clearError();
  els.scheduleRun.disabled = true;

  try {
    await api('/schedule/run', { method: 'POST' });
    await refreshSchedule();
    refreshJobs();
  } catch (error) {
    showError(error.message);
  } finally {
    els.scheduleRun.disabled = false;
  }
});

els.scheduleStop.addEventListener('click', async () => {
  clearError();

  try {
    await api('/schedule', { method: 'DELETE', expectNoContent: true });
    await refreshSchedule();
  } catch (error) {
    showError(error.message);
  }
});

async function refreshSchedule() {
  if (!state.apiKey) return;

  try {
    const schedule = await api('/schedule');
    renderSchedule(schedule);
  } catch (error) {
    if (error.message.includes('404') || /не настроено/i.test(error.message)) {
      renderSchedule(null);
    } else {
      showError(error.message);
    }
  }
}

function renderSchedule(schedule) {
  if (!schedule) {
    els.scheduleStatus.innerHTML = '<p class="hint">Расписание пока не настроено.</p>';
    return;
  }

  els.scheduleStatus.innerHTML = `
    <dl>
      <dt>Статус</dt><dd>${schedule.enabled ? 'включено' : 'остановлено'}</dd>
      <dt>Интервал</dt><dd>${Math.round(schedule.intervalMs / 60000)} мин.</dd>
      <dt>Ссылок</dt><dd>${schedule.totalLinks}</dd>
      <dt>Последний запуск</dt><dd>${fmtDate(schedule.lastRunAt)}</dd>
      <dt>Следующий запуск</dt><dd>${fmtDate(schedule.nextRunAt)}</dd>
      <dt>Последняя задача</dt><dd>${schedule.lastJobId ? schedule.lastJobId.slice(0, 8) : '—'}</dd>
    </dl>`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

// --- Периодическое обновление ---

if (state.apiKey) {
  refreshJobs();
  refreshSchedule();
}

setInterval(() => {
  refreshJobs();
  refreshSchedule();
}, 5000);
