// Страница «Уведомления» — токен Telegram-бота и chat id для уведомлений
// администратора об ошибках. Настройки хранятся на сервере в
// .notifications/<apiKey>.json (см. src/notifier.ts).

const state = {
  apiKey: localStorage.getItem('apiKey') || '',
};

const els = {
  apiKeyInput: document.getElementById('api-key'),
  saveKeyBtn: document.getElementById('save-key'),
  keyStatus: document.getElementById('key-status'),
  errorBox: document.getElementById('error-box'),
  statusBox: document.getElementById('status-box'),
  form: document.getElementById('notif-form'),
  token: document.getElementById('notif-token'),
  chatId: document.getElementById('notif-chat-id'),
  enabled: document.getElementById('notif-enabled'),
  saveBtn: document.getElementById('notif-save'),
  testBtn: document.getElementById('notif-test'),
  deleteBtn: document.getElementById('notif-delete'),
  formStatus: document.getElementById('notif-form-status'),
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

async function loadSettings() {
  if (!state.apiKey) return;

  try {
    const settings = await api('/notifications');
    els.chatId.value = settings.chatId || '';
    els.enabled.checked = Boolean(settings.enabled);
    els.token.value = '';
    els.token.placeholder = settings.botTokenSet
      ? `токен задан (${settings.botTokenPreview}) — оставьте пустым, чтобы не менять`
      : '123456789:AA...';
  } catch (error) {
    showError(error.message);
  }
}

async function saveSettings() {
  clearError();
  clearStatus();
  els.formStatus.textContent = 'Сохранение…';
  els.saveBtn.disabled = true;

  try {
    const chatId = els.chatId.value.trim();
    const botToken = els.token.value.trim();

    if (!chatId) {
      throw new Error('Укажите chat id.');
    }

    const settings = await api('/notifications', {
      method: 'PUT',
      jsonBody: { chatId, botToken, enabled: els.enabled.checked },
    });

    els.token.value = '';
    els.token.placeholder = `токен задан (${settings.botTokenPreview}) — оставьте пустым, чтобы не менять`;
    els.formStatus.textContent = 'Сохранено.';
  } catch (error) {
    showError(error.message);
    els.formStatus.textContent = '';
  } finally {
    els.saveBtn.disabled = false;
  }
}

async function sendTest() {
  clearError();
  els.formStatus.textContent = 'Отправка тестового сообщения…';
  els.testBtn.disabled = true;

  try {
    await api('/notifications/test', { method: 'POST' });
    els.formStatus.textContent = 'Тестовое сообщение отправлено — проверьте Telegram.';
  } catch (error) {
    showError(error.message);
    els.formStatus.textContent = '';
  } finally {
    els.testBtn.disabled = false;
  }
}

async function deleteSettings() {
  if (!window.confirm('Удалить настройки уведомлений (токен бота и chat id)?')) return;

  clearError();
  try {
    await api('/notifications', { method: 'DELETE', expectNoContent: true });
    els.chatId.value = '';
    els.token.value = '';
    els.token.placeholder = '123456789:AA...';
    els.enabled.checked = false;
    els.formStatus.textContent = 'Настройки удалены.';
  } catch (error) {
    showError(error.message);
  }
}

els.saveKeyBtn.addEventListener('click', () => {
  state.apiKey = els.apiKeyInput.value.trim();
  localStorage.setItem('apiKey', state.apiKey);
  updateKeyStatus();
  clearError();
  void loadSettings();
});

els.apiKeyInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    els.saveKeyBtn.click();
  }
});

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveSettings();
});

els.testBtn.addEventListener('click', () => {
  void sendTest();
});

els.deleteBtn.addEventListener('click', () => {
  void deleteSettings();
});

if (state.apiKey) {
  void loadSettings();
}
