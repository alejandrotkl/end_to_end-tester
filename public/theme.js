// Общая светлая/тёмная тема. Тумблер #theme-toggle: солнце ↔ луна.
(function initTheme() {
  const KEY = 'uiTheme';

  function current() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }

  function syncToggle(theme) {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    btn.setAttribute(
      'aria-label',
      theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему',
    );
    btn.title = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
  }

  function apply(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // private mode
    }
    syncToggle(next);
  }

  let saved = 'light';
  try {
    saved = localStorage.getItem(KEY) || 'light';
  } catch {
    saved = 'light';
  }
  apply(saved);

  window.__setTheme = apply;
  window.__toggleTheme = function toggleTheme() {
    apply(current() === 'dark' ? 'light' : 'dark');
  };

  document.addEventListener('DOMContentLoaded', () => {
    apply(current());
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      window.__toggleTheme();
    });
  });
})();
