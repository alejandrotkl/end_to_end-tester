// Страница логов задач (logs.html) — отдельно от страницы проверки.

const state = {
  apiKey: localStorage.getItem('apiKey') || '',
  expandedJobId: null,
  expandedHtml: '',
  // Кэш списка задач для модалки скачивания (чтобы не дергать API лишний раз).
  jobs: [],
  // Режим выделения мышью в модалке скачивания.
  dragSelecting: false,
  dragSelectValue: true,
};

const els = {
  apiKeyInput: document.getElementById('api-key'),
  saveKeyBtn: document.getElementById('save-key'),
  keyStatus: document.getElementById('key-status'),
  errorBox: document.getElementById('error-box'),
  jobsRefresh: document.getElementById('jobs-refresh'),
  jobsClearAll: document.getElementById('jobs-clear-all'),
  jobsDownloadJson: document.getElementById('jobs-download-json'),
  jobsTableBody: document.querySelector('#jobs-table tbody'),
  downloadModal: document.getElementById('download-modal'),
  downloadList: document.getElementById('download-list'),
  downloadSelectAll: document.getElementById('download-select-all'),
  downloadSelectNone: document.getElementById('download-select-none'),
  downloadSelectedCount: document.getElementById('download-selected-count'),
  downloadConfirm: document.getElementById('download-confirm'),
  filterDateFrom: document.getElementById('filter-date-from'),
  filterDateTo: document.getElementById('filter-date-to'),
  filterTimeFrom: document.getElementById('filter-time-from'),
  filterTimeTo: document.getElementById('filter-time-to'),
  filterReset: document.getElementById('filter-reset'),
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

async function api(path, { method = 'GET', jsonBody, expectNoContent = false } = {}) {
  const headers = { 'X-API-Key': state.apiKey };
  let body;

  if (jsonBody !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(jsonBody);
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

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU');
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} мс`;

  const totalSeconds = ms / 1000;

  if (totalSeconds < 60) {
    const rounded = Math.round(totalSeconds * 10) / 10;
    return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)} с`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes} мин ${String(seconds).padStart(2, '0')} с`;
}

function statusBadge(status) {
  const labels = { pending: 'в очереди', running: 'выполняется', completed: 'готово', failed: 'ошибка' };
  return `<span class="badge ${status}">${labels[status] || status}</span>`;
}

function rankBadge(priority) {
  return priority ? `<span class="badge rank">${priority}</span>` : '—';
}

function loginNote(r) {
  if (r.usedLogin) {
    let text = 'вход выполнен';
    if (r.loginMs !== undefined && r.loginMs !== null) {
      text += ` (${formatDuration(r.loginMs)})`;
    }
    if (r.loginUsername) {
      text += `, ${escapeHtml(r.loginUsername)}`;
    }
    return `<span class="hint">${text}</span>`;
  }
  if (r.needsLogin) return '<span class="hint" style="color:var(--danger)">требуется вход</span>';
  return '—';
}

function formatErrorText(error) {
  if (!error) return '';
  return error.replace(/\u001b\[[0-9;]*m/g, '').split(/\n\s*\n/)[0].trim();
}

function formatRequireNote(require) {
  if (!Array.isArray(require) || require.length === 0) return '—';

  return require
    .map((condition, index) => {
      if (condition.kind === 'element' || condition.path || condition.tag || condition.classes || condition.text) {
        const parts = [];
        if (condition.path) parts.push(`внутри=${condition.path}`);
        if (condition.tag) parts.push(`элемент=${condition.tag}`);
        if (condition.classes) parts.push(`class=${condition.classes}`);
        if (condition.text) parts.push(`текст=${condition.text}`);
        return parts.length ? `[${index + 1}] ${parts.join('; ')}` : '';
      }
      if (condition.kind === 'selector' && condition.value) {
        return `[${index + 1}] селектор=${condition.value}`;
      }
      if (condition.kind === 'text' && condition.value) {
        return `[${index + 1}] текст=${condition.value}`;
      }
      return '';
    })
    .filter(Boolean)
    .join(', ') || '—';
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function downloadJsonFile(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

els.saveKeyBtn.addEventListener('click', () => {
  state.apiKey = els.apiKeyInput.value.trim();
  localStorage.setItem('apiKey', state.apiKey);
  updateKeyStatus();
  clearError();
  refreshJobs();
});

els.jobsRefresh.addEventListener('click', () => refreshJobs());

els.jobsClearAll.addEventListener('click', async () => {
  clearError();

  if (!state.apiKey) {
    showError('Сначала сохраните API-ключ.');
    return;
  }

  const finished = state.jobs.filter((j) => j.status === 'completed' || j.status === 'failed').length;

  if (finished === 0) {
    showError('Нет завершённых логов для удаления.');
    return;
  }

  const ok = window.confirm(
    `Удалить все завершённые логи (${finished})?\nВыполняющиеся задачи не будут затронуты.\nЭто действие независимо от автоматической очистки.`,
  );

  if (!ok) return;

  els.jobsClearAll.disabled = true;

  try {
    const result = await api('/jobs', { method: 'DELETE' });
    state.expandedJobId = null;
    state.expandedHtml = '';
    await refreshJobs();
    window.alert(`Удалено логов: ${result.removed}.`);
  } catch (error) {
    showError(error.message);
  } finally {
    els.jobsClearAll.disabled = false;
  }
});

async function refreshJobs() {
  if (!state.apiKey) return;

  try {
    const jobs = await api('/jobs');
    state.jobs = jobs;
    renderJobsTable(jobs);
  } catch (error) {
    showError(error.message);
  }
}

function buildResultsTableHtml(results) {
  const rows = (results.results || [])
    .map(
      (r) => `
      <tr>
        <td class="link-cell">${escapeHtml(r.url)}</td>
        <td>${rankBadge(r.priority)}</td>
        <td>${r.status ?? '—'}</td>
        <td>${formatDuration(r.loadMs)}</td>
        <td>${formatDuration(r.totalMs)}</td>
        <td class="link-cell">${escapeHtml(formatRequireNote(r.require))}</td>
        <td>${r.passed ? '✅' : '❌'}</td>
        <td>${loginNote(r)}</td>
        <td class="link-cell">${escapeHtml(formatErrorText(r.error))}</td>
      </tr>`,
    )
    .join('');

  return `
    <div class="job-results-panel">
      <p class="hint">Успешно ${results.passed} из ${results.total}</p>
      <table class="job-results-table">
        <thead>
          <tr>
            <th>Ссылка</th><th>№</th><th>HTTP</th><th>Загрузка</th><th>Всего</th><th>Доп. условия</th><th>Итог</th><th>Вход</th><th>Описание ошибки</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="9">Нет результатов.</td></tr>'}</tbody>
      </table>
    </div>`;
}

function renderJobsTable(jobs) {
  if (jobs.length === 0) {
    els.jobsTableBody.innerHTML = '<tr><td colspan="6">Задач пока нет.</td></tr>';
    state.expandedJobId = null;
    state.expandedHtml = '';
    return;
  }

  if (state.expandedJobId && !jobs.some((job) => job.id === state.expandedJobId)) {
    state.expandedJobId = null;
    state.expandedHtml = '';
  }

  els.jobsTableBody.innerHTML = jobs
    .map((job) => {
      const summary = job.summary ? `${job.summary.passed}/${job.summary.total}` : '—';
      const canDelete = job.status === 'completed' || job.status === 'failed';
      const canSaveJson = job.status === 'completed';
      const isExpanded = state.expandedJobId === job.id;
      const resultsLabel = isExpanded ? 'Скрыть' : 'Результаты';

      const jobRow = `
        <tr class="job-row${isExpanded ? ' expanded' : ''}" data-job-id="${job.id}">
          <td title="${job.id}">${job.id.slice(0, 8)}</td>
          <td>${statusBadge(job.status)}</td>
          <td>${fmtDate(job.createdAt)}</td>
          <td>${job.totalLinks}</td>
          <td>${summary}</td>
          <td class="job-actions-cell">
            ${job.status === 'completed' ? `<button class="secondary small-btn" data-results="${job.id}">${resultsLabel}</button>` : ''}
            ${canDelete ? `<button class="danger small-btn" data-delete="${job.id}">Удалить</button>` : ''}
            ${canSaveJson ? `<button class="secondary small-btn" data-save-json="${job.id}">Сохранить JSON</button>` : ''}
          </td>
        </tr>`;

      const detailsRow =
        isExpanded && state.expandedHtml
          ? `<tr class="job-results-row" data-results-for="${job.id}"><td colspan="6">${state.expandedHtml}</td></tr>`
          : '';

      return jobRow + detailsRow;
    })
    .join('');
}

async function fetchJobExportPayload(jobId) {
  const job = state.jobs.find((j) => j.id === jobId) || (await api(`/jobs/${jobId}`));
  let results = null;

  if (job.status === 'completed') {
    try {
      results = await api(`/jobs/${jobId}/results`);
    } catch {
      results = null;
    }
  }

  return {
    job,
    results,
    exportedAt: new Date().toISOString(),
  };
}

els.jobsTableBody.addEventListener('click', async (event) => {
  const resultsId = event.target.getAttribute('data-results');
  const deleteId = event.target.getAttribute('data-delete');
  const saveJsonId = event.target.getAttribute('data-save-json');

  clearError();

  if (resultsId) {
    if (state.expandedJobId === resultsId) {
      state.expandedJobId = null;
      state.expandedHtml = '';
      refreshJobs();
      return;
    }

    try {
      const results = await api(`/jobs/${resultsId}/results`);
      state.expandedJobId = resultsId;
      state.expandedHtml = buildResultsTableHtml(results);
      await refreshJobs();

      const detailsRow = els.jobsTableBody.querySelector(`tr.job-results-row[data-results-for="${resultsId}"]`);
      detailsRow?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
      showError(error.message);
    }
  }

  if (deleteId) {
    try {
      await api(`/jobs/${deleteId}`, { method: 'DELETE', expectNoContent: true });
      if (state.expandedJobId === deleteId) {
        state.expandedJobId = null;
        state.expandedHtml = '';
      }
      refreshJobs();
    } catch (error) {
      showError(error.message);
    }
  }

  // Одна задача → минимальный диалог: браузерный «Сохранить как» (имя файла).
  if (saveJsonId) {
    try {
      const payload = await fetchJobExportPayload(saveJsonId);
      const short = saveJsonId.slice(0, 8);
      const defaultName = `job-${short}.json`;
      const filename = window.prompt('Имя файла для сохранения:', defaultName);

      if (!filename) return;

      const safeName = filename.endsWith('.json') ? filename : `${filename}.json`;
      downloadJsonFile(safeName, payload);
    } catch (error) {
      showError(error.message);
    }
  }
});

// --- Модалка «Скачать в формате JSON» ---

function getDownloadableJobs() {
  return state.jobs.filter((j) => j.status === 'completed' || j.status === 'failed');
}

function toLocalDateKey(iso) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toLocalTimeMinutes(iso) {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function parseTimeToMinutes(value) {
  if (!value) return null;
  const [h, m] = value.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function jobMatchesFilters(job) {
  const dateKey = toLocalDateKey(job.createdAt);
  const timeMinutes = toLocalTimeMinutes(job.createdAt);

  const dateFrom = els.filterDateFrom.value;
  const dateTo = els.filterDateTo.value;
  const timeFrom = parseTimeToMinutes(els.filterTimeFrom.value);
  const timeTo = parseTimeToMinutes(els.filterTimeTo.value);

  if (dateFrom && dateKey < dateFrom) return false;
  if (dateTo && dateKey > dateTo) return false;
  if (timeFrom !== null && timeMinutes < timeFrom) return false;
  if (timeTo !== null && timeMinutes > timeTo) return false;
  return true;
}

function renderDownloadList() {
  const downloadable = getDownloadableJobs().filter(jobMatchesFilters);

  if (downloadable.length === 0) {
    els.downloadList.innerHTML = '<p class="hint download-empty">Нет логов по выбранному фильтру.</p>';
    updateSelectedCount();
    return;
  }

  els.downloadList.innerHTML = downloadable
    .map((job) => {
      const summary = job.summary ? `${job.summary.passed}/${job.summary.total}` : '—';
      return `
        <div class="download-item" data-job-id="${job.id}" role="option" aria-selected="false">
          <input type="checkbox" class="download-check" value="${job.id}" />
          <span class="download-item-id" title="${job.id}">${job.id.slice(0, 8)}</span>
          <span>${statusBadge(job.status)}</span>
          <span class="hint">${fmtDate(job.createdAt)}</span>
          <span class="hint">${job.totalLinks} ссылок · ${summary}</span>
        </div>`;
    })
    .join('');

  updateSelectedCount();
}

function openDownloadModal() {
  const downloadable = getDownloadableJobs();

  if (downloadable.length === 0) {
    showError('Нет завершённых логов для скачивания.');
    return;
  }

  els.filterDateFrom.value = '';
  els.filterDateTo.value = '';
  els.filterTimeFrom.value = '';
  els.filterTimeTo.value = '';
  renderDownloadList();
  els.downloadModal.classList.remove('hidden');
  els.downloadModal.setAttribute('aria-hidden', 'false');
}

function closeDownloadModal() {
  els.downloadModal.classList.add('hidden');
  els.downloadModal.setAttribute('aria-hidden', 'true');
  state.dragSelecting = false;
}

function getDownloadChecks() {
  return Array.from(els.downloadList.querySelectorAll('.download-check'));
}

function updateSelectedCount() {
  const checks = getDownloadChecks();
  const selected = checks.filter((c) => c.checked).length;
  els.downloadSelectedCount.textContent = `Выбрано: ${selected}${checks.length ? ` из ${checks.length}` : ''}`;
}

function setItemChecked(item, checked) {
  if (!item) return;
  const checkbox = item.querySelector('.download-check');
  if (!checkbox) return;
  checkbox.checked = checked;
  item.classList.toggle('selected', checked);
  item.setAttribute('aria-selected', checked ? 'true' : 'false');
}

els.jobsDownloadJson.addEventListener('click', () => {
  clearError();
  if (!state.apiKey) {
    showError('Сначала сохраните API-ключ.');
    return;
  }
  openDownloadModal();
});

els.downloadSelectAll.addEventListener('click', () => {
  getDownloadChecks().forEach((c) => setItemChecked(c.closest('.download-item'), true));
  updateSelectedCount();
});

els.downloadSelectNone.addEventListener('click', () => {
  getDownloadChecks().forEach((c) => setItemChecked(c.closest('.download-item'), false));
  updateSelectedCount();
});

[els.filterDateFrom, els.filterDateTo, els.filterTimeFrom, els.filterTimeTo].forEach((input) => {
  input.addEventListener('change', () => renderDownloadList());
  input.addEventListener('input', () => renderDownloadList());
});

els.filterReset.addEventListener('click', () => {
  els.filterDateFrom.value = '';
  els.filterDateTo.value = '';
  els.filterTimeFrom.value = '';
  els.filterTimeTo.value = '';
  renderDownloadList();
});

els.downloadList.addEventListener('change', (event) => {
  if (!event.target.classList.contains('download-check')) return;
  const item = event.target.closest('.download-item');
  if (!item) return;
  item.classList.toggle('selected', event.target.checked);
  item.setAttribute('aria-selected', event.target.checked ? 'true' : 'false');
  updateSelectedCount();
});

// Клик по всей строке переключает выбор; протягивание ЛКМ выделяет диапазон.
els.downloadList.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  const item = event.target.closest('.download-item');
  if (!item) return;

  const checkbox = item.querySelector('.download-check');
  if (!checkbox) return;

  // Клик по самой галочке — оставляем браузеру (change обновит selected).
  if (event.target.classList.contains('download-check')) {
    state.dragSelecting = true;
    state.dragSelectValue = !checkbox.checked;
    return;
  }

  event.preventDefault();
  state.dragSelecting = true;
  state.dragSelectValue = !checkbox.checked;
  setItemChecked(item, state.dragSelectValue);
  updateSelectedCount();
});

els.downloadList.addEventListener('mouseover', (event) => {
  if (!state.dragSelecting) return;
  const item = event.target.closest('.download-item');
  if (!item) return;
  setItemChecked(item, state.dragSelectValue);
  updateSelectedCount();
});

document.addEventListener('mouseup', () => {
  state.dragSelecting = false;
});

els.downloadModal.addEventListener('click', (event) => {
  if (event.target.hasAttribute('data-close-modal')) {
    closeDownloadModal();
  }
});

els.downloadConfirm.addEventListener('click', async () => {
  const selectedIds = getDownloadChecks()
    .filter((c) => c.checked)
    .map((c) => c.value);

  if (selectedIds.length === 0) {
    window.alert('Выберите хотя бы один лог.');
    return;
  }

  els.downloadConfirm.disabled = true;

  try {
    const exports = [];

    for (const id of selectedIds) {
      exports.push(await fetchJobExportPayload(id));
    }

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const defaultName =
      selectedIds.length === 1
        ? `job-${selectedIds[0].slice(0, 8)}.json`
        : `jobs-export-${stamp}.json`;

    const filename = window.prompt(
      selectedIds.length === 1
        ? 'Имя файла для сохранения:'
        : `Имя файла для сохранения (${selectedIds.length} логов):`,
      defaultName,
    );

    if (!filename) return;

    const safeName = filename.endsWith('.json') ? filename : `${filename}.json`;
    const payload =
      selectedIds.length === 1
        ? exports[0]
        : { exportedAt: new Date().toISOString(), count: exports.length, jobs: exports };

    downloadJsonFile(safeName, payload);
    closeDownloadModal();
  } catch (error) {
    showError(error.message);
  } finally {
    els.downloadConfirm.disabled = false;
  }
});

if (state.apiKey) {
  refreshJobs();
}

setInterval(() => {
  // Не обновляем таблицу, пока открыта модалка — иначе сбросятся галочки.
  if (!els.downloadModal.classList.contains('hidden')) return;
  refreshJobs();
}, 5000);
