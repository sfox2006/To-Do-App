/* Service worker registration and the single Download app entry point. */
export function detectPlatform(ua = '', hints = {}) {
  const source = String(ua || '');
  const platform = String(hints.platform || '');
  const touch = Number(hints.maxTouchPoints) || 0;
  const iPadOS = platform === 'MacIntel' && touch > 1;
  if (/iPad|iPhone|iPod/.test(source) || iPadOS) return 'ios';
  if (/Android/i.test(source)) return 'android';
  if (/Windows/i.test(source) || /Win32|Win64/.test(platform)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(source) || platform === 'MacIntel') return 'mac';
  return 'other';
}

/** True for Safari on iPhone/iPad. Other iOS browsers include CriOS, FxiOS, EdgiOS. */
export function isIosSafari(ua = '') {
  return /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA/.test(ua);
}

export function isInstalled(nav = {}, matchMedia = () => ({ matches: false })) {
  const modes = ['standalone', 'fullscreen', 'window-controls-overlay'];
  for (const mode of modes) {
    try {
      if (matchMedia(`(display-mode: ${mode})`).matches) return true;
    } catch (err) { /* ignore a broken matchMedia */ }
  }
  return nav.standalone === true;
}

const OPTION = { ios: 'opt-ios', android: 'opt-android', windows: 'opt-windows', mac: 'opt-mac' };

let deferredPrompt = null;
let refreshPrompt = () => {};

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    refreshPrompt();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    refreshPrompt();
    if (typeof window.__pwaMarkInstalled === 'function') window.__pwaMarkInstalled();
  });
}

function boot() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    });
  }

  const downloadBtn = document.getElementById('download-app');
  const installedEl = document.getElementById('already-installed');
  const dlg = document.getElementById('install-dialog');
  if (!downloadBtn || !dlg) return;

  const ua = navigator.userAgent || '';
  const platform = detectPlatform(ua, {
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints || 0,
  });

  function markInstalled() {
    downloadBtn.hidden = true;
    downloadBtn.setAttribute('aria-expanded', 'false');
    if (installedEl) installedEl.hidden = false;
    if (dlg.open) dlg.close();
  }
  window.__pwaMarkInstalled = markInstalled;

  document.querySelectorAll('.install-option').forEach((el) => {
    const on = el.id === OPTION[platform];
    el.classList.toggle('is-current', on);
    el.open = on;
    const badge = el.querySelector('.device-badge');
    if (badge) badge.hidden = !on;
    if (on) el.setAttribute('aria-current', 'true');
  });

  const safariWarn = document.getElementById('ios-not-safari');
  if (safariWarn) safariWarn.hidden = !(platform === 'ios' && !isIosSafari(ua));

  const installNow = document.getElementById('install-now');
  const promptNote = document.getElementById('install-prompt-note');

  function placePrompt() {
    if (!installNow || !promptNote) return;
    const show = !!deferredPrompt;
    installNow.hidden = !show;
    promptNote.hidden = !show;
    const current = dlg.querySelector('.install-option.is-current .install-body');
    const fallback = document.querySelector('#opt-windows .install-body');
    const host = current || fallback;
    if (!host) return;
    host.prepend(promptNote);
    host.prepend(installNow);
    if (show && platform === 'other') {
      const win = document.getElementById('opt-windows');
      if (win) win.open = true;
    }
  }
  refreshPrompt = placePrompt;
  placePrompt();

  if (isInstalled(navigator, (query) => window.matchMedia(query))) {
    markInstalled();
    return;
  }

  function focusables() {
    return [...dlg.querySelectorAll('button, summary')].filter((node) => !node.disabled && !node.hidden && node.offsetParent !== null);
  }
  function openDialog() {
    if (!dlg.open) dlg.showModal();
    downloadBtn.setAttribute('aria-expanded', 'true');
    const target = (installNow && !installNow.hidden && installNow) ||
      dlg.querySelector('.install-option.is-current summary') ||
      document.getElementById('install-close');
    if (target) target.focus();
  }
  function closeDialog() {
    if (dlg.open) dlg.close();
    downloadBtn.setAttribute('aria-expanded', 'false');
    downloadBtn.focus();
  }

  downloadBtn.addEventListener('click', openDialog);
  document.getElementById('install-close').addEventListener('click', closeDialog);
  dlg.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });
  dlg.addEventListener('click', (event) => { if (event.target === dlg) closeDialog(); });
  dlg.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const nodes = focusables();
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  if (installNow) {
    installNow.addEventListener('click', () => {
      if (!deferredPrompt) return;
      const prompt = deferredPrompt;
      deferredPrompt = null;
      placePrompt();
      try {
        const pending = prompt.prompt();
        if (pending && pending.catch) pending.catch(() => {});
      } catch (err) { /* the browser declined to show the install prompt */ }
      if (prompt.userChoice) prompt.userChoice.catch(() => {});
    });
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
