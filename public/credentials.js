// Страница «Доступы для входа» — управление логинами/паролями по доменам.
// Данные хранятся на сервере в .credentials/<apiKey>.json.

const RECHECK_STORAGE_KEY = 'pendingRecheck';

const state = {
  apiKey: localStorage.getItem('apiKey') || '',
  /** @type {{ jobId: string, items: Array<{ domain: string, loginPageUrl?: string, links: Array<{url: string, timeoutMs?: number}>, loginFailed?: boolean }> } | null} */
  pending: null,
  /** Индекс текущего домена в очереди pending.items */
  currentIndex: 0,
};

const els = {
  apiKeyInput: document.getElementById('api-key'),
  saveKeyBtn: document.getElementById('save-key'),
  keyStatus: document.getElementById('key-status'),
  errorBox: document.getElementById('error-box'),
  statusBox: document.getElementById('status-box'),
  pendingQueue: document.getElementById('pending-queue'),
  pendingList: document.getElementById('pending-list'),
  domain: document.getElementById('cred-domain'),
  loginUrl: document.getElementById('cred-login-url'),
  username: document.getElementById('cred-username'),
  password: document.getElementById('cred-password'),
  userSel: document.getElementById('cred-user-sel'),
  passSel: document.getElementById('cred-pass-sel'),
  submitSel: document.getElementById('cred-submit-sel'),
  saveBtn: document.getElementById('cred-save'),
  form: document.getElementById('cred-form'),
  formStatus: document.getElementById('cred-form-status'),
  refreshBtn: document.getElementById('cred-refresh'),
  tableBody: document.getElementById('cred-table-body'),
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

function showStatus(message) {
  els.statusBox.textContent = message;
  els.statusBox.classList.remove('hidden');
}

function clearStatus() {
  els.statusBox.classList.add('hidden');
  els.statusBox.textContent = '';
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

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function isEphemeralLoginUrl(url) {
  return /[?&](state|bo|code_challenge)=|\/blitz\/|openid-connect\/auth|\/realms\//i.test(url || '');
}

/** Нормализует старый формат { jobId, domain, links } и новый { jobId, items }. */
function normalizePending(raw) {
  if (!raw || !raw.jobId) return null;

  if (Array.isArray(raw.items) && raw.items.length > 0) {
    return {
      jobId: raw.jobId,
      items: raw.items.filter((item) => item?.domain && Array.isArray(item.links) && item.links.length > 0),
    };
  }

  // Старый формат из предыдущей версии UI.
  if (raw.domain && Array.isArray(raw.links) && raw.links.length > 0) {
    return {
      jobId: raw.jobId,
      items: [
        {
          domain: raw.domain,
          loginPageUrl: raw.loginPageUrl || '',
          links: raw.links,
          loginFailed: Boolean(raw.loginFailed),
        },
      ],
    };
  }

  return null;
}

function readPendingRecheck() {
  try {
    const raw = sessionStorage.getItem(RECHECK_STORAGE_KEY);
    return normalizePending(raw ? JSON.parse(raw) : null);
  } catch {
    return null;
  }
}

function writePendingRecheck(pending) {
  if (!pending || !pending.items?.length) {
    sessionStorage.removeItem(RECHECK_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(RECHECK_STORAGE_KEY, JSON.stringify(pending));
}

function clearPendingRecheck() {
  sessionStorage.removeItem(RECHECK_STORAGE_KEY);
  state.pending = null;
  state.currentIndex = 0;
}

function currentPendingItem() {
  if (!state.pending?.items?.length) return null;
  const idx = Math.min(state.currentIndex, state.pending.items.length - 1);
  return state.pending.items[idx] || null;
}

function fillFormFromItem(item) {
  if (!item) return;
  els.domain.value = item.domain || '';
  const loginUrl = item.loginPageUrl || '';
  els.loginUrl.value = isEphemeralLoginUrl(loginUrl) ? '' : loginUrl;
  els.username.value = '';
  els.password.value = '';
}

function renderPendingQueue() {
  const pending = state.pending;
  if (!pending?.items?.length) {
    els.pendingQueue.classList.add('hidden');
    els.pendingList.innerHTML = '';
    clearStatus();
    els.saveBtn.textContent = 'Сохранить';
    return;
  }

  els.pendingQueue.classList.remove('hidden');
  const totalLinks = pending.items.reduce((sum, item) => sum + item.links.length, 0);
  showStatus(
    `После сохранения текущего домена будет перепроверена его ссылка(и) в задаче ${String(pending.jobId).slice(0, 8)}. В очереди: ${pending.items.length} домен(ов), ${totalLinks} ссылка(и).`,
  );
  els.saveBtn.textContent = 'Сохранить и перепроверить';

  els.pendingList.innerHTML = pending.items
    .map((item, index) => {
      const active = index === state.currentIndex ? ' is-active' : '';
      const urls = item.links.map((l) => escapeHtml(l.url)).join('<br>');
      return `
        <li class="pending-item${active}" data-pending-index="${index}">
          <button type="button" class="pending-item-btn" data-pending-index="${index}">
            <strong>${escapeHtml(item.domain)}</strong>
            <span class="muted">${item.links.length} ссылка(и)</span>
            <div class="pending-item-urls">${urls}</div>
          </button>
        </li>`;
    })
    .join('');
}

/** Убирает из очереди домены, для которых вход уже не нужен (проверка прошла). */
async function prunePendingAgainstJob() {
  if (!state.pending?.jobId || !state.pending.items?.length) {
    renderPendingQueue();
    return;
  }

  try {
    const results = await api(`/jobs/${state.pending.jobId}/results`);
    const stillNeeded = new Set();
    for (const r of results.results || []) {
      if (!r.loginDomain) continue;
      if (r.needsLogin || (r.usedLogin && !r.passed)) {
        stillNeeded.add(String(r.loginDomain).toLowerCase());
      }
    }

    state.pending.items = state.pending.items.filter((item) =>
      stillNeeded.has(String(item.domain).toLowerCase()),
    );

    if (!state.pending.items.length) {
      clearPendingRecheck();
    } else {
      writePendingRecheck(state.pending);
      state.currentIndex = Math.min(state.currentIndex, state.pending.items.length - 1);
      fillFormFromItem(currentPendingItem());
    }
  } catch {
    // Задача ещё без results.json — оставляем очередь как есть.
  }

  renderPendingQueue();
}

function applyQueryAndPending() {
  state.pending = readPendingRecheck();
  state.currentIndex = 0;

  const params = new URLSearchParams(window.location.search);
  const queryDomain = params.get('domain');
  if (queryDomain && state.pending?.items?.length) {
    const idx = state.pending.items.findIndex((item) => item.domain === queryDomain);
    if (idx >= 0) state.currentIndex = idx;
  }

  const item = currentPendingItem();
  if (item) {
    fillFormFromItem(item);
  } else if (queryDomain) {
    els.domain.value = queryDomain;
    const loginUrl = params.get('loginUrl') || '';
    els.loginUrl.value = isEphemeralLoginUrl(loginUrl) ? '' : loginUrl;
  }

  renderPendingQueue();
}

function buildPayload() {
  const domain = els.domain.value.trim();
  const username = els.username.value.trim();
  const password = els.password.value;
  const loginUrlRaw = els.loginUrl.value.trim();

  if (!domain) {
    throw new Error('Укажите домен.');
  }
  if (!username || !password) {
    throw new Error('Укажите логин и пароль.');
  }

  const payload = { username, password };
  if (loginUrlRaw && !isEphemeralLoginUrl(loginUrlRaw)) {
    payload.loginUrl = loginUrlRaw;
  }

  const userSel = els.userSel.value.trim();
  const passSel = els.passSel.value.trim();
  const submitSel = els.submitSel.value.trim();
  if (userSel) payload.usernameSelector = userSel;
  if (passSel) payload.passwordSelector = passSel;
  if (submitSel) payload.submitSelector = submitSel;

  return { domain, payload };
}

function removePendingDomain(domain) {
  if (!state.pending?.items?.length) return null;

  const normalized = domain.toLowerCase();
  const removed = state.pending.items.find((item) => item.domain.toLowerCase() === normalized);
  state.pending.items = state.pending.items.filter((item) => item.domain.toLowerCase() !== normalized);

  if (!state.pending.items.length) {
    const jobId = state.pending.jobId;
    clearPendingRecheck();
    renderPendingQueue();
    return { removed, jobId, done: true };
  }

  writePendingRecheck(state.pending);
  state.currentIndex = Math.min(state.currentIndex, state.pending.items.length - 1);
  fillFormFromItem(currentPendingItem());
  renderPendingQueue();
  return { removed, jobId: state.pending.jobId, done: false };
}

async function saveCredential() {
  clearError();
  els.formStatus.textContent = 'Сохранение…';
  els.saveBtn.disabled = true;

  try {
    const { domain, payload } = buildPayload();
    await api(`/credentials/${encodeURIComponent(domain)}`, {
      method: 'PUT',
      jsonBody: payload,
    });

    els.password.value = '';
    await refreshList();

    const pending = state.pending;
    const matching =
      pending?.items?.find((item) => item.domain.toLowerCase() === domain.toLowerCase()) || null;

    if (!matching?.links?.length || !pending?.jobId) {
      // Даже без перепроверки убираем домен из очереди, если он там был.
      if (matching) removePendingDomain(domain);
      els.formStatus.textContent = 'Сохранено.';
      return;
    }

    const links = matching.links;

    els.formStatus.textContent = 'Запуск повторной проверки в той же задаче…';
    await api(`/jobs/${pending.jobId}/recheck`, {
      method: 'POST',
      jsonBody: { links },
    });

    const afterRemove = removePendingDomain(domain);

    if (afterRemove?.done) {
      els.formStatus.textContent = 'Сохранено, перепроверка запущена…';
      window.location.href = `/?job=${encodeURIComponent(pending.jobId)}`;
      return;
    }

    els.formStatus.textContent = `Сохранено, «${domain}» перепроверяется. Заполните следующий домен.`;
  } catch (error) {
    showError(error.message);
    els.formStatus.textContent = '';
  } finally {
    els.saveBtn.disabled = false;
  }
}

function renderList(list) {
  if (!Array.isArray(list) || !list.length) {
    els.tableBody.innerHTML = '<tr><td colspan="5">Доступы пока не настроены</td></tr>';
    return;
  }

  els.tableBody.innerHTML = list
    .map((item) => {
      // На случай старого ответа API с accounts[] — берём первую запись.
      const row =
        Array.isArray(item.accounts) && item.accounts[0]
          ? { domain: item.domain, ...item.accounts[0] }
          : item;
      const hasSelectors = Boolean(row.usernameSelector || row.passwordSelector || row.submitSelector);
      return `
        <tr>
          <td>${escapeHtml(row.domain)}</td>
          <td class="link-cell">${escapeHtml(row.loginUrl || '—')}</td>
          <td>${escapeHtml(row.username || '—')}</td>
          <td>${hasSelectors ? 'да' : 'нет'}</td>
          <td class="job-actions-cell">
            <button type="button" class="danger small-btn" data-delete-domain="${escapeHtml(row.domain)}">Удалить</button>
          </td>
        </tr>`;
    })
    .join('');
}

async function refreshList() {
  if (!state.apiKey) return;

  try {
    const list = await api('/credentials');
    renderList(list);
  } catch (error) {
    showError(error.message);
  }
}

els.saveKeyBtn.addEventListener('click', () => {
  state.apiKey = els.apiKeyInput.value.trim();
  localStorage.setItem('apiKey', state.apiKey);
  updateKeyStatus();
  clearError();
  refreshList().then(() => prunePendingAgainstJob());
});

els.apiKeyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    els.saveKeyBtn.click();
  }
});

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveCredential();
});

els.refreshBtn.addEventListener('click', () => {
  void refreshList().then(() => prunePendingAgainstJob());
});

els.pendingList.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-pending-index]');
  if (!btn) return;
  const index = Number(btn.getAttribute('data-pending-index'));
  if (!Number.isFinite(index) || !state.pending?.items?.[index]) return;
  state.currentIndex = index;
  fillFormFromItem(currentPendingItem());
  renderPendingQueue();
});

els.tableBody.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-delete-domain]');
  if (!btn) return;

  const domain = btn.getAttribute('data-delete-domain');
  if (!domain) return;
  if (!window.confirm(`Удалить доступ для «${domain}»?`)) return;

  clearError();
  try {
    await api(`/credentials/${encodeURIComponent(domain)}`, {
      method: 'DELETE',
      expectNoContent: true,
    });
    await refreshList();
  } catch (error) {
    showError(error.message);
  }
});

applyQueryAndPending();
if (state.apiKey) {
  void refreshList().then(() => prunePendingAgainstJob());
} else {
  void prunePendingAgainstJob();
}
