// Страница проверки ссылок (index.html). Логи задач — отдельная страница logs.html.

const state = {
  apiKey: localStorage.getItem('apiKey') || '',
  // ID задачи, которую показывает панель «Сейчас выполняется».
  // Берётся из общего списка задач API-ключа, поэтому все устройства
  // с одним ключом видят одну и ту же текущую проверку.
  activeJobId: null,
  schedule: null,
  draftUpdatedAt: null,
};

const els = {
  apiKeyInput: document.getElementById('api-key'),
  saveKeyBtn: document.getElementById('save-key'),
  keyStatus: document.getElementById('key-status'),
  errorBox: document.getElementById('error-box'),

  progressJobId: document.getElementById('progress-job-id'),
  progressCount: document.getElementById('progress-count'),
  progressTotal: document.getElementById('progress-total'),
  progressCurrent: document.getElementById('progress-current'),
  progressStarted: document.getElementById('progress-started'),
  progressNextRun: document.getElementById('progress-next-run'),
  progressResults: document.getElementById('progress-results'),

  linksRows: document.getElementById('links-rows'),
  linksAdd: document.getElementById('links-add'),
  linksFile: document.getElementById('links-file'),

  manualRun: document.getElementById('manual-run'),
  manualStatus: document.getElementById('manual-status'),

  scheduleInterval: document.getElementById('schedule-interval'),
  scheduleSave: document.getElementById('schedule-save'),
  scheduleRun: document.getElementById('schedule-run'),
  scheduleStop: document.getElementById('schedule-stop'),
  scheduleStatus: document.getElementById('schedule-status'),

  loginModal: document.getElementById('login-modal'),
  loginBackdrop: document.getElementById('login-backdrop'),
  loginInfo: document.getElementById('login-modal-info'),
  loginDomain: document.getElementById('login-domain'),
  loginUrl: document.getElementById('login-url'),
  loginUsername: document.getElementById('login-username'),
  loginPassword: document.getElementById('login-password'),
  loginStatus: document.getElementById('login-modal-status'),
  loginCancel: document.getElementById('login-cancel'),
  loginSubmit: document.getElementById('login-submit'),
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

function rankBadge(priority) {
  return priority ? `<span class="badge rank">${priority}</span>` : '—';
}

function loginNote(r) {
  if (r.usedLogin) return '<span class="hint">вход выполнен</span>';
  if (r.needsLogin) return '<span class="hint" style="color:var(--danger)">требуется вход</span>';
  return '';
}

function formatErrorText(error) {
  if (!error) return '';
  return error.replace(/\u001b\[[0-9;]*m/g, '').split(/\n\s*\n/)[0].trim();
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

// --- Интерактивный список ссылок ---

function createLinkRow() {
  const row = document.createElement('div');
  row.className = 'link-row';
  row.innerHTML = `
    <span class="link-handle" draggable="true" title="Перетащите, чтобы изменить порядок">⠿</span>
    <span class="link-rank" title="Приоритет (порядковый номер в списке)">1</span>
    <input type="text" class="link-url" placeholder="https://example.com" />
    <input type="number" class="link-timeout" min="5" max="600" step="5" value="30" title="Таймаут ожидания страницы, секунд" />
    <span class="hint link-timeout-unit">с</span>
    <button type="button" class="danger small-btn link-remove" title="Удалить ссылку">✕</button>
  `;
  return row;
}

function renumberRows(container) {
  container.querySelectorAll('.link-row').forEach((row, index) => {
    row.querySelector('.link-rank').textContent = String(index + 1);
  });
}

function addLinkRow(container) {
  container.appendChild(createLinkRow());
  renumberRows(container);
}

let draggedLinkRow = null;

function initLinkRows(container, addButton) {
  addLinkRow(container);
  addButton.addEventListener('click', () => {
    addLinkRow(container);
    scheduleDraftSave();
  });

  container.addEventListener('click', (event) => {
    const row = event.target.closest('.link-row');
    if (!row) return;

    if (event.target.classList.contains('link-remove')) {
      const rows = container.querySelectorAll('.link-row');
      if (rows.length > 1) {
        row.remove();
      } else {
        row.querySelector('.link-url').value = '';
      }
      renumberRows(container);
      scheduleDraftSave();
    }
  });

  container.addEventListener('input', () => scheduleDraftSave());

  container.addEventListener('dragstart', (event) => {
    const handle = event.target.closest('.link-handle');
    if (!handle) return;
    draggedLinkRow = handle.closest('.link-row');
    event.dataTransfer.effectAllowed = 'move';
    draggedLinkRow.classList.add('dragging');
  });

  container.addEventListener('dragover', (event) => {
    if (!draggedLinkRow) return;
    event.preventDefault();

    const targetRow = event.target.closest('.link-row');
    if (!targetRow || targetRow === draggedLinkRow) return;

    const rect = targetRow.getBoundingClientRect();
    const before = event.clientY - rect.top < rect.height / 2;
    container.insertBefore(draggedLinkRow, before ? targetRow : targetRow.nextSibling);
    renumberRows(container);
  });

  container.addEventListener('dragend', () => {
    if (draggedLinkRow) {
      draggedLinkRow.classList.remove('dragging');
      draggedLinkRow = null;
      renumberRows(container);
      scheduleDraftSave();
    }
  });
}

function collectLinkRows(container) {
  return Array.from(container.querySelectorAll('.link-row'))
    .map((row) => {
      const url = row.querySelector('.link-url').value.trim();
      if (!url) return null;
      const timeoutSeconds = Number(row.querySelector('.link-timeout').value) || 30;
      return { url, timeoutMs: Math.round(timeoutSeconds * 1000) };
    })
    .filter((item) => item !== null);
}

function fillLinkRows(container, links) {
  container.innerHTML = '';

  if (links.length === 0) {
    addLinkRow(container);
    return;
  }

  for (const link of links) {
    const row = createLinkRow();
    row.querySelector('.link-url').value = link.url;
    row.querySelector('.link-timeout').value = Math.round((link.timeoutMs || 30000) / 1000);
    container.appendChild(row);
  }

  renumberRows(container);
}

initLinkRows(els.linksRows, els.linksAdd);

function normalizeImportedTimeoutMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 30000;
  return num < 1000 ? num * 1000 : num;
}

function parseLinksFileContent(filename, content) {
  if (filename.toLowerCase().endsWith('.json')) {
    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error(`Некорректный JSON-файл: ${error.message}`);
    }

    const items = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.links) ? parsed.links : null;

    if (!items) {
      throw new Error('JSON-файл должен содержать массив ссылок или объект вида { "links": [...] }');
    }

    return items
      .map((item) => {
        if (typeof item === 'string') {
          return { url: item, timeoutMs: 30000 };
        }

        if (item && typeof item === 'object' && typeof item.url === 'string') {
          return { url: item.url, timeoutMs: normalizeImportedTimeoutMs(item.timeoutMs) };
        }

        return null;
      })
      .filter((item) => item !== null);
  }

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((url) => ({ url, timeoutMs: 30000 }));
}

els.linksFile.addEventListener('change', async () => {
  const file = els.linksFile.files[0];
  if (!file) return;

  clearError();

  try {
    const content = await file.text();
    const links = parseLinksFileContent(file.name, content);

    if (links.length === 0) {
      showError('В файле не найдено ни одной ссылки.');
      return;
    }

    fillLinkRows(els.linksRows, links);
    scheduleDraftSave();
  } catch (error) {
    showError(error.message);
  } finally {
    els.linksFile.value = '';
  }
});

els.saveKeyBtn.addEventListener('click', () => {
  state.apiKey = els.apiKeyInput.value.trim();
  localStorage.setItem('apiKey', state.apiKey);
  updateKeyStatus();
  clearError();
  state.draftUpdatedAt = null;
  refreshSchedule();
  refreshDraft();
  syncActiveJobAndProgress();
});

// --- Общий список ссылок между устройствами ---

let draftSaveTimer = null;

function scheduleDraftSave() {
  if (!state.apiKey) return;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveDraftNow, 800);
}

async function saveDraftNow() {
  if (!state.apiKey) return;

  try {
    const draft = await api('/links-draft', { method: 'PUT', jsonBody: { links: collectLinkRows(els.linksRows) } });
    state.draftUpdatedAt = draft.updatedAt;
  } catch {
    // фоновая синхронизация
  }
}

async function refreshDraft() {
  if (!state.apiKey) return;

  try {
    const draft = await api('/links-draft');

    if (draft.updatedAt === state.draftUpdatedAt) {
      return;
    }

    if (els.linksRows.contains(document.activeElement)) {
      return;
    }

    state.draftUpdatedAt = draft.updatedAt;
    fillLinkRows(els.linksRows, draft.links);
  } catch {
    // фоновая синхронизация
  }
}

// --- Сейчас выполняется (общее для всех устройств с одним API-ключом) ---

/**
 * Находит самую свежую активную задачу среди всех задач этого API-ключа
 * и показывает её прогресс. Так любой пользователь видит ту же проверку,
 * что и остальные — неважно, кто её запустил.
 */
async function syncActiveJobAndProgress() {
  if (!state.apiKey) {
    renderIdleProgress();
    return;
  }

  try {
    const jobs = await api('/jobs');
    const activeJob = jobs.find((job) => job.status === 'running' || job.status === 'pending');

    if (activeJob) {
      state.activeJobId = activeJob.id;
      const progress = await api(`/jobs/${activeJob.id}/progress`);
      renderProgress(progress);
      return;
    }

    // Активной нет — если раньше следили за задачей, покажем её финальный
    // прогресс (если файл ещё есть), иначе — состояние покоя.
    if (state.activeJobId) {
      try {
        const progress = await api(`/jobs/${state.activeJobId}/progress`);
        renderProgress(progress);
        return;
      } catch {
        state.activeJobId = null;
      }
    }

    renderIdleProgress();
  } catch {
    renderIdleProgress();
  }
}

function nextScheduledRunText() {
  if (!state.schedule || !state.schedule.enabled) return 'расписание не настроено';
  return fmtDate(state.schedule.nextRunAt);
}

function renderIdleProgress() {
  els.progressJobId.textContent = '—';
  els.progressCount.textContent = '0';
  els.progressTotal.textContent = '0';
  els.progressCurrent.textContent = 'сейчас ничего не проверяется';
  els.progressStarted.textContent = '—';
  els.progressNextRun.textContent = nextScheduledRunText();
  els.progressResults.innerHTML = '';
}

function renderProgress(progress) {
  els.progressJobId.textContent = (progress.jobId || state.activeJobId || '—').toString().slice(0, 8);
  els.progressCount.textContent = progress.completed ?? 0;
  els.progressTotal.textContent = progress.total ?? '—';
  els.progressStarted.textContent = fmtDate(progress.startedAt || progress.createdAt);
  els.progressNextRun.textContent = nextScheduledRunText();

  const statusLabels = {
    pending: 'ожидание запуска…',
    completed: 'проверка завершена',
    failed: 'задача завершилась с ошибкой',
  };
  els.progressCurrent.textContent = progress.current || statusLabels[progress.status] || 'сейчас ничего не проверяется';

  const results = progress.results || [];

  if (results.length === 0) {
    els.progressResults.innerHTML =
      progress.status === 'pending' || progress.status === 'running'
        ? '<p class="hint">Результатов пока нет.</p>'
        : '';
    return;
  }

  const rows = results
    .slice()
    .reverse()
    .map(
      (r) => `
      <tr>
        <td class="link-cell">${escapeHtml(r.url)}</td>
        <td>${rankBadge(r.priority)}</td>
        <td>${r.status ?? '—'}</td>
        <td>${formatDuration(r.totalMs)}</td>
        <td>${r.passed ? '✅' : '❌'} ${loginNote(r)}</td>
        <td class="link-cell">${escapeHtml(formatErrorText(r.error))}</td>
      </tr>`,
    )
    .join('');

  els.progressResults.innerHTML = `
    <table>
      <thead>
        <tr><th>Ссылка</th><th>№</th><th>HTTP</th><th>Время</th><th>Итог</th><th>Описание ошибки</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  maybeShowLoginPrompt(progress);
}

renderIdleProgress();

// --- Всплывающее окно входа (страница требует авторизацию) ---
//
// Если проверка обнаружила, что ссылка требует вход (HTTP 403 или вместо
// содержимого показана форма логина), в результате появляется loginDomain.
// Показываем окно ввода данных; после сохранения запускаем повторную
// проверку только затронутых ссылок — тестер сам залогинится и перейдёт
// на исходную страницу уже в авторизованной сессии.

const loginPrompt = {
  open: false,
  current: null,
  // Ключи "jobId:domain", по которым окно уже показывалось (введены данные
  // или нажато «Пропустить») — чтобы не открывать его заново на каждый
  // опрос прогресса той же задачи.
  handled: new Set(),
};

function collectLoginPrompts(progress) {
  const byDomain = new Map();

  for (const r of progress.results || []) {
    if (!r.loginDomain) continue;

    // Окно нужно в двух случаях: данных для домена нет (needsLogin) или
    // вход был выполнен с сохранёнными данными, но не помог (usedLogin + ошибка).
    if (!(r.needsLogin || (r.usedLogin && !r.passed))) continue;

    const key = `${progress.jobId}:${r.loginDomain}`;
    if (loginPrompt.handled.has(key)) continue;

    if (!byDomain.has(r.loginDomain)) {
      byDomain.set(r.loginDomain, {
        key,
        domain: r.loginDomain,
        loginPageUrl: r.loginPageUrl || '',
        retryLinks: [],
        loginFailed: false,
      });
    }

    const entry = byDomain.get(r.loginDomain);
    entry.retryLinks.push({ url: r.url, timeoutMs: r.timeoutMs || 30000 });
    if (!entry.loginPageUrl && r.loginPageUrl) entry.loginPageUrl = r.loginPageUrl;
    if (r.usedLogin && !r.passed) entry.loginFailed = true;
  }

  return Array.from(byDomain.values());
}

function maybeShowLoginPrompt(progress) {
  if (loginPrompt.open) return;

  const prompts = collectLoginPrompts(progress);
  if (prompts.length === 0) return;

  openLoginModal(prompts[0]);
}

function isEphemeralLoginUrl(url) {
  return /[?&](state|bo|code_challenge)=|\/blitz\/|openid-connect\/auth|\/realms\//i.test(url || '');
}

function openLoginModal(prompt) {
  loginPrompt.open = true;
  loginPrompt.current = prompt;

  const urls = prompt.retryLinks.map((l) => l.url).join(', ');
  els.loginInfo.textContent = prompt.loginFailed
    ? `Вход на «${prompt.domain}» с сохранёнными данными не удался. Проверьте логин и пароль — после сохранения ссылки будут проверены снова: ${urls}`
    : `Для проверки требуется вход на «${prompt.domain}». После входа тестер вернётся на исходную страницу и проверит её: ${urls}`;

  els.loginDomain.value = prompt.domain;
  // OAuth/SSO URL с одноразовым state нельзя сохранять — при следующем
  // входе state уже протух. Оставляем поле пустым: тестер заполнит форму
  // на свежем редиректе, который получит при открытии исходной ссылки.
  els.loginUrl.value = isEphemeralLoginUrl(prompt.loginPageUrl) ? '' : prompt.loginPageUrl || '';
  els.loginUrl.placeholder =
    'оставьте пустым для SSO (Keycloak/Blitz) — форма откроется сама при проверке';
  els.loginUsername.value = '';
  els.loginPassword.value = '';
  els.loginStatus.textContent = '';
  els.loginSubmit.disabled = false;
  els.loginModal.classList.remove('hidden');
  els.loginUsername.focus();
}

function closeLoginModal() {
  if (loginPrompt.current) {
    loginPrompt.handled.add(loginPrompt.current.key);
  }
  loginPrompt.open = false;
  loginPrompt.current = null;
  els.loginModal.classList.add('hidden');
}

els.loginCancel.addEventListener('click', closeLoginModal);
els.loginBackdrop.addEventListener('click', closeLoginModal);

els.loginSubmit.addEventListener('click', async () => {
  const prompt = loginPrompt.current;
  if (!prompt) return;

  const username = els.loginUsername.value.trim();
  const password = els.loginPassword.value;

  if (!username || !password) {
    els.loginStatus.textContent = 'Укажите логин и пароль.';
    return;
  }

  els.loginSubmit.disabled = true;
  els.loginStatus.textContent = 'Сохранение данных…';

  try {
    const loginUrlRaw = els.loginUrl.value.trim();
    const payload = {
      username,
      password,
    };
    // Одноразовые SSO URL не отправляем вообще — иначе старые версии API
    // или повторный вход с протухшим state ломают проверку.
    if (loginUrlRaw && !isEphemeralLoginUrl(loginUrlRaw)) {
      payload.loginUrl = loginUrlRaw;
    }

    await api(`/credentials/${encodeURIComponent(prompt.domain)}`, {
      method: 'PUT',
      jsonBody: payload,
    });

    els.loginStatus.textContent = 'Запуск повторной проверки…';
    const job = await api('/jobs', { method: 'POST', jsonBody: { links: prompt.retryLinks } });
    state.activeJobId = job.id;

    closeLoginModal();
    els.manualStatus.textContent = `Повторная проверка «${prompt.domain}» после входа запущена…`;
    await syncActiveJobAndProgress();
  } catch (error) {
    els.loginSubmit.disabled = false;
    els.loginStatus.textContent = `Ошибка: ${error.message}`;
  }
});

// --- Проверить один раз ---

els.manualRun.addEventListener('click', async () => {
  clearError();
  const links = collectLinkRows(els.linksRows);

  if (links.length === 0) {
    showError('Добавьте хотя бы одну ссылку.');
    return;
  }

  els.manualRun.disabled = true;
  els.manualStatus.textContent = 'Создание задачи...';

  try {
    const job = await api('/jobs', { method: 'POST', jsonBody: { links } });
    state.activeJobId = job.id;
    els.manualStatus.textContent = 'Проверка запущена…';
    await syncActiveJobAndProgress();

    await pollJobToCompletion(job.id, (status) => {
      els.manualStatus.textContent = `Статус: ${status}...`;
    });

    const results = await api(`/jobs/${job.id}/results`);
    els.manualStatus.textContent = `Готово: успешно ${results.passed} из ${results.total}. Подробности — на странице «Логи задач».`;
    await syncActiveJobAndProgress();
  } catch (error) {
    showError(error.message);
    els.manualStatus.textContent = '';
  } finally {
    els.manualRun.disabled = false;
    await syncActiveJobAndProgress();
  }
});

async function pollJobToCompletion(id, onStatus) {
  for (;;) {
    const job = await api(`/jobs/${id}`);
    onStatus(job.status);
    await syncActiveJobAndProgress();

    if (job.status === 'completed') {
      return job;
    }

    if (job.status === 'failed') {
      throw new Error(job.error || 'Задача завершилась с ошибкой.');
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

// --- Расписание ---

els.scheduleSave.addEventListener('click', async () => {
  clearError();
  const links = collectLinkRows(els.linksRows);

  if (links.length === 0) {
    showError('Добавьте хотя бы одну ссылку для расписания.');
    return;
  }

  const intervalMinutes = Number(els.scheduleInterval.value) || 5;
  els.scheduleSave.disabled = true;

  try {
    const schedule = await api('/schedule', { method: 'PUT', jsonBody: { links, intervalMinutes } });

    if (schedule.lastJobId) {
      state.activeJobId = schedule.lastJobId;
    }

    await refreshSchedule();
    await syncActiveJobAndProgress();
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
    const schedule = await api('/schedule/run', { method: 'POST' });

    if (schedule.lastJobId) {
      state.activeJobId = schedule.lastJobId;
    }

    await refreshSchedule();
    await syncActiveJobAndProgress();
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
  state.schedule = schedule;

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

if (state.apiKey) {
  refreshSchedule();
  refreshDraft();
  syncActiveJobAndProgress();
}

setInterval(() => {
  refreshSchedule();
}, 5000);

setInterval(() => {
  syncActiveJobAndProgress();
}, 1500);

setInterval(() => {
  refreshDraft();
}, 3000);
