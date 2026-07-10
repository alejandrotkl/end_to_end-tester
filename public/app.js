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

  loginBanner: document.getElementById('login-needed-banner'),
  loginNeededText: document.getElementById('login-needed-text'),
  loginNeededList: document.getElementById('login-needed-list'),
  loginNeededLink: document.getElementById('login-needed-link'),
  loginNeededDismiss: document.getElementById('login-needed-dismiss'),
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
  return '';
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

// --- Интерактивный список ссылок ---

function createRequireRow(condition) {
  const row = document.createElement('div');
  row.className = 'link-require-row';

  let path = condition?.path || '';
  let tag = condition?.tag || '';
  let classes = condition?.classes || '';
  let text = condition?.text || '';

  if (condition?.kind === 'text' && condition.value) {
    text = condition.value;
  }

  row.innerHTML = `
    <div class="link-require-fields">
      <label class="link-require-field">
        <span>Внутри</span>
        <input type="text" class="link-require-path" placeholder="form / nav / tr" title="Опционально: родительские теги" />
      </label>
      <label class="link-require-field link-require-field-tag">
        <span>Элемент</span>
        <input type="text" class="link-require-tag" placeholder="button / a / td" title="Тег: button, a, td, div…" />
      </label>
      <label class="link-require-field link-require-field-class">
        <span>Классы</span>
        <input type="text" class="link-require-class" placeholder="вставьте class как в HTML" title="class целиком из DevTools" />
      </label>
      <label class="link-require-field">
        <span>Текст</span>
        <input type="text" class="link-require-text" placeholder="опционально" title="Прямой текст именно этого элемента" />
      </label>
      <button type="button" class="danger small-btn link-require-remove" title="Удалить условие">✕</button>
    </div>
  `;

  row.querySelector('.link-require-path').value = path;
  row.querySelector('.link-require-tag').value = tag;
  row.querySelector('.link-require-class').value = classes;
  row.querySelector('.link-require-text').value = text;
  return row;
}

function collectRequireFromItem(item) {
  const rows = item.querySelectorAll('.link-require-row');
  const require = [];

  for (const row of rows) {
    const path = row.querySelector('.link-require-path').value.trim();
    const tag = row.querySelector('.link-require-tag').value.trim();
    const classes = row.querySelector('.link-require-class').value.trim();
    const text = row.querySelector('.link-require-text').value.trim();

    if (!path && !tag && !classes && !text) continue;

    require.push({
      kind: 'element',
      ...(path ? { path } : {}),
      ...(tag ? { tag } : {}),
      ...(classes ? { classes } : {}),
      ...(text ? { text } : {}),
    });
  }

  return require.length ? require : undefined;
}

function createLinkItem(link) {
  const item = document.createElement('div');
  item.className = 'link-item';

  const hasRequire = Array.isArray(link?.require) && link.require.length > 0;

  item.innerHTML = `
    <div class="link-row">
      <span class="link-handle" draggable="true" title="Перетащите, чтобы изменить порядок">⠿</span>
      <span class="link-rank" title="Приоритет (порядковый номер в списке)">1</span>
      <input type="text" class="link-url" placeholder="https://example.com" />
      <button type="button" class="secondary small-btn link-extra-toggle" title="Доп. настройки" aria-expanded="false">⚙</button>
      <input type="number" class="link-timeout" min="5" max="600" step="5" value="30" title="Таймаут ожидания страницы, секунд" />
      <span class="hint link-timeout-unit">с</span>
      <button type="button" class="danger small-btn link-remove" title="Удалить ссылку">✕</button>
    </div>
    <div class="link-extra${hasRequire ? ' is-open' : ''}">
      <div class="link-require-list"></div>
      <button type="button" class="secondary small-btn link-require-add">+ Условие</button>
    </div>
  `;

  item.querySelector('.link-url').value = link?.url || '';
  item.querySelector('.link-timeout').value = Math.round((link?.timeoutMs || 30000) / 1000);

  const list = item.querySelector('.link-require-list');
  const conditions = hasRequire ? link.require : [];
  if (conditions.length === 0) {
    list.appendChild(createRequireRow(null));
  } else {
    for (const condition of conditions) {
      list.appendChild(createRequireRow(condition));
    }
  }

  if (hasRequire) {
    item.querySelector('.link-extra-toggle').setAttribute('aria-expanded', 'true');
  }

  return item;
}

function renumberRows(container) {
  container.querySelectorAll('.link-item').forEach((item, index) => {
    item.querySelector('.link-rank').textContent = String(index + 1);
  });
}

function addLinkRow(container, link) {
  container.appendChild(createLinkItem(link));
  renumberRows(container);
}

let draggedLinkItem = null;

function initLinkRows(container, addButton) {
  addLinkRow(container);
  addButton.addEventListener('click', () => {
    addLinkRow(container);
    scheduleDraftSave();
  });

  container.addEventListener('click', (event) => {
    const item = event.target.closest('.link-item');
    if (!item) return;

    if (event.target.classList.contains('link-remove')) {
      const items = container.querySelectorAll('.link-item');
      if (items.length > 1) {
        item.remove();
      } else {
        item.querySelector('.link-url').value = '';
        const list = item.querySelector('.link-require-list');
        list.innerHTML = '';
        list.appendChild(createRequireRow(null));
        item.querySelector('.link-extra').classList.remove('is-open');
        item.querySelector('.link-extra-toggle').setAttribute('aria-expanded', 'false');
      }
      renumberRows(container);
      scheduleDraftSave();
      return;
    }

    if (event.target.classList.contains('link-extra-toggle')) {
      const extra = item.querySelector('.link-extra');
      const open = extra.classList.toggle('is-open');
      event.target.setAttribute('aria-expanded', open ? 'true' : 'false');
      return;
    }

    if (event.target.classList.contains('link-require-add')) {
      item.querySelector('.link-require-list').appendChild(createRequireRow(null));
      scheduleDraftSave();
      return;
    }

    if (event.target.classList.contains('link-require-remove')) {
      const row = event.target.closest('.link-require-row');
      const list = item.querySelector('.link-require-list');
      if (list.querySelectorAll('.link-require-row').length > 1) {
        row.remove();
      } else {
        row.querySelectorAll('input').forEach((input) => {
          input.value = '';
        });
      }
      scheduleDraftSave();
    }
  });

  container.addEventListener('input', () => scheduleDraftSave());

  container.addEventListener('dragstart', (event) => {
    const handle = event.target.closest('.link-handle');
    if (!handle) return;
    draggedLinkItem = handle.closest('.link-item');
    event.dataTransfer.effectAllowed = 'move';
    draggedLinkItem.classList.add('dragging');
  });

  container.addEventListener('dragover', (event) => {
    if (!draggedLinkItem) return;
    event.preventDefault();

    const targetItem = event.target.closest('.link-item');
    if (!targetItem || targetItem === draggedLinkItem) return;

    const rect = targetItem.getBoundingClientRect();
    const before = event.clientY - rect.top < rect.height / 2;
    container.insertBefore(draggedLinkItem, before ? targetItem : targetItem.nextSibling);
    renumberRows(container);
  });

  container.addEventListener('dragend', () => {
    if (draggedLinkItem) {
      draggedLinkItem.classList.remove('dragging');
      draggedLinkItem = null;
      renumberRows(container);
      scheduleDraftSave();
    }
  });
}

function collectLinkRows(container) {
  return Array.from(container.querySelectorAll('.link-item'))
    .map((item) => {
      const url = item.querySelector('.link-url').value.trim();
      if (!url) return null;
      const timeoutSeconds = Number(item.querySelector('.link-timeout').value) || 30;
      const require = collectRequireFromItem(item);
      return {
        url,
        timeoutMs: Math.round(timeoutSeconds * 1000),
        ...(require ? { require } : {}),
      };
    })
    .filter((item) => item !== null);
}

function fillLinkRows(container, links) {
  container.innerHTML = '';

  if (!links || links.length === 0) {
    addLinkRow(container);
    return;
  }

  for (const link of links) {
    addLinkRow(container, link);
  }

  renumberRows(container);
}

initLinkRows(els.linksRows, els.linksAdd);

function normalizeImportedTimeoutMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 30000;
  return num < 1000 ? num * 1000 : num;
}

function normalizeImportedRequire(raw) {
  if (!raw) return undefined;
  const items = Array.isArray(raw) ? raw : [raw];
  const require = items
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      if (item.kind === 'selector' || item.kind === 'text') {
        if (!item.value) return null;
        return { kind: item.kind, value: String(item.value) };
      }
      const path = typeof item.path === 'string' ? item.path.trim() : '';
      const tag = typeof item.tag === 'string' ? item.tag.trim() : '';
      const classes = typeof item.classes === 'string' ? item.classes.trim() : '';
      const text = typeof item.text === 'string' ? item.text : '';
      if (!path && !tag && !classes && !text) return null;
      return {
        kind: 'element',
        ...(path ? { path } : {}),
        ...(tag ? { tag } : {}),
        ...(classes ? { classes } : {}),
        ...(text ? { text } : {}),
      };
    })
    .filter(Boolean);
  return require.length ? require : undefined;
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
          const require = normalizeImportedRequire(item.require);
          return {
            url: item.url,
            timeoutMs: normalizeImportedTimeoutMs(item.timeoutMs),
            ...(require ? { require } : {}),
          };
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

  const ACTIVE_JOB_KEY = 'activeJobId';

  try {
    // ?job= в URL — после перепроверки с страницы доступов.
    const params = new URLSearchParams(window.location.search);
    const jobFromQuery = params.get('job');
    if (jobFromQuery) {
      state.activeJobId = jobFromQuery;
      try {
        sessionStorage.setItem(ACTIVE_JOB_KEY, jobFromQuery);
      } catch {
        // ignore
      }
    } else if (!state.activeJobId) {
      try {
        state.activeJobId = sessionStorage.getItem(ACTIVE_JOB_KEY) || null;
      } catch {
        // ignore
      }
    }

    const jobs = await api('/jobs');
    const runningJobs = jobs.filter((job) => job.status === 'running' || job.status === 'pending');

    // Предпочитаем сохранённую выполняющуюся задачу, иначе самую свежую.
    let activeJob =
      (state.activeJobId && runningJobs.find((job) => job.id === state.activeJobId)) ||
      runningJobs[0] ||
      null;

    if (activeJob) {
      state.activeJobId = activeJob.id;
      try {
        sessionStorage.setItem(ACTIVE_JOB_KEY, activeJob.id);
      } catch {
        // ignore
      }
      const progress = await api(`/jobs/${activeJob.id}/progress`);
      renderProgress(progress);
      return;
    }

    // Активной нет — если раньше следили за задачей, покажем её финальный прогресс.
    if (state.activeJobId) {
      try {
        const progress = await api(`/jobs/${state.activeJobId}/progress`);
        renderProgress(progress);
        if (progress.status === 'completed' || progress.status === 'failed') {
          try {
            sessionStorage.removeItem(ACTIVE_JOB_KEY);
          } catch {
            // ignore
          }
        }
        return;
      } catch {
        state.activeJobId = null;
        try {
          sessionStorage.removeItem(ACTIVE_JOB_KEY);
        } catch {
          // ignore
        }
      }
    }

    renderIdleProgress();
  } catch {
    // Не затираем панель при сбое сети/смене вкладки — пробуем дочитать сохранённую задачу.
    if (state.activeJobId) {
      try {
        const progress = await api(`/jobs/${state.activeJobId}/progress`);
        renderProgress(progress);
        return;
      } catch {
        // оставляем текущий UI как есть
      }
    }
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
    maybeShowLoginPrompt(progress);
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
        <td class="link-cell">${escapeHtml(formatRequireNote(r.require))}</td>
        <td>${r.passed ? '✅' : '❌'} ${loginNote(r)}</td>
        <td class="link-cell">${escapeHtml(formatErrorText(r.error))}</td>
      </tr>`,
    )
    .join('');

  els.progressResults.innerHTML = `
    <table>
      <thead>
        <tr><th>Ссылка</th><th>№</th><th>HTTP</th><th>Время</th><th>Доп. условия</th><th>Итог</th><th>Описание ошибки</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  maybeShowLoginPrompt(progress);
}

renderIdleProgress();

// --- Требуется вход: баннер → вкладка «Доступы», повтор в той же задаче ---

const RECHECK_STORAGE_KEY = 'pendingRecheck';

const loginPrompt = {
  dismissed: new Set(),
};

function isEphemeralLoginUrl(url) {
  return /[?&](state|bo|code_challenge)=|\/blitz\/|openid-connect\/auth|\/realms\//i.test(url || '');
}

function collectLoginPrompts(progress) {
  const byDomain = new Map();

  for (const r of progress.results || []) {
    if (!r.loginDomain) continue;

    // Баннер нужен: данных нет (needsLogin) или вход не помог (usedLogin + ошибка).
    if (!(r.needsLogin || (r.usedLogin && !r.passed))) continue;

    const key = `${progress.jobId}:${r.loginDomain}`;
    if (loginPrompt.dismissed.has(key)) continue;

    if (!byDomain.has(r.loginDomain)) {
      byDomain.set(r.loginDomain, {
        key,
        domain: r.loginDomain,
        loginPageUrl: r.loginPageUrl || '',
        links: [],
        loginFailed: false,
      });
    }

    const entry = byDomain.get(r.loginDomain);
    entry.links.push({
      url: r.url,
      timeoutMs: r.timeoutMs || 30000,
      ...(r.require ? { require: r.require } : {}),
    });
    if (!entry.loginPageUrl && r.loginPageUrl) entry.loginPageUrl = r.loginPageUrl;
    if (r.usedLogin && !r.passed) entry.loginFailed = true;
  }

  return Array.from(byDomain.values());
}

function writePendingRecheck(jobId, items) {
  if (!jobId || !items?.length) {
    sessionStorage.removeItem(RECHECK_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(
    RECHECK_STORAGE_KEY,
    JSON.stringify({
      jobId,
      items: items.map((item) => ({
        domain: item.domain,
        loginPageUrl: isEphemeralLoginUrl(item.loginPageUrl) ? '' : item.loginPageUrl || '',
        links: item.links,
        loginFailed: Boolean(item.loginFailed),
      })),
    }),
  );
}

function hideLoginBanner() {
  els.loginBanner.classList.add('hidden');
  els.loginNeededList.innerHTML = '';
  els.loginNeededText.textContent = '';
}

function maybeShowLoginPrompt(progress) {
  if (!progress?.jobId) {
    hideLoginBanner();
    return;
  }

  // Пока задача ещё бежит — не отвлекаем баннером.
  if (progress.status === 'pending' || progress.status === 'running') {
    return;
  }

  const prompts = collectLoginPrompts(progress);
  if (prompts.length === 0) {
    hideLoginBanner();
    return;
  }

  writePendingRecheck(progress.jobId, prompts);

  const totalLinks = prompts.reduce((sum, p) => sum + p.links.length, 0);
  els.loginNeededText.textContent = prompts.some((p) => p.loginFailed)
    ? `Вход не удался или данные не настроены для ${prompts.length} домен(ов), ${totalLinks} ссылка(и). Заполните доступы — ссылки перепроверятся в той же задаче.`
    : `Для ${prompts.length} домен(ов) (${totalLinks} ссылка(и)) нужен вход. Откройте «Доступы для входа», сохраните логин/пароль — проверка продолжится в этой задаче.`;

  els.loginNeededList.innerHTML = prompts
    .map((p) => {
      const urls = p.links.map((l) => escapeHtml(l.url)).join('<br>');
      return `<li><strong>${escapeHtml(p.domain)}</strong>${p.loginFailed ? ' <span class="hint">(вход не удался)</span>' : ''}<div class="login-needed-urls">${urls}</div></li>`;
    })
    .join('');

  const first = prompts[0];
  const href = `/credentials.html?domain=${encodeURIComponent(first.domain)}${
    first.loginPageUrl && !isEphemeralLoginUrl(first.loginPageUrl)
      ? `&loginUrl=${encodeURIComponent(first.loginPageUrl)}`
      : ''
  }`;
  els.loginNeededLink.href = href;
  els.loginBanner.classList.remove('hidden');
}

els.loginNeededDismiss.addEventListener('click', () => {
  const jobId = state.activeJobId;
  if (jobId) {
    for (const key of [...loginPrompt.dismissed]) {
      // keep
    }
    // Помечаем все текущие домены баннера как скрытые.
    els.loginNeededList.querySelectorAll('li strong').forEach((el) => {
      loginPrompt.dismissed.add(`${jobId}:${el.textContent}`);
    });
  }
  hideLoginBanner();
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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    syncActiveJobAndProgress();
  }
});

window.addEventListener('pageshow', () => {
  syncActiveJobAndProgress();
});

window.addEventListener('focus', () => {
  syncActiveJobAndProgress();
});

setInterval(() => {
  refreshDraft();
}, 3000);
