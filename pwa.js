/* Service worker registration and the Download app button.
   beforeinstallprompt is stored as soon as it fires, including before the button exists. */
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

/** The prompt captured before the button was drawn still counts. */
export function resolveInstallPrompt(local, stashed) {
  return local || stashed || null;
}

/** One line shown only when the browser will not open its own install prompt. */
export function installFallback(ua = '', hints = {}) {
  const platform = detectPlatform(ua, hints);
  if (platform === 'ios' && isIosSafari(ua)) {
    return { kind: 'ios', text: 'Share, then Add to Home Screen' };
  }
  if (platform === 'ios') {
    return { kind: 'text', text: 'Open this page in Safari, then Share, then Add to Home Screen.' };
  }
  const edge = /Edg\/|EdgA|EdgiOS/.test(ua);
  const firefox = /Firefox|FxiOS/.test(ua);
  const chrome = /Chrome|CriOS/.test(ua) && !edge;
  const safari = /Safari/.test(ua) && !/Chrome|CriOS|Chromium|Edg|FxiOS|Android/.test(ua);
  if (edge) return { kind: 'text', text: 'In Edge, open the menu, then Apps, then Install this site as an app.' };
  if (firefox) return { kind: 'text', text: 'Firefox can’t install this web app. Open it in Chrome or Edge.' };
  if (chrome && platform === 'android') return { kind: 'text', text: 'In Chrome, open the menu and tap Install app.' };
  if (chrome) return { kind: 'text', text: 'In Chrome, click the install icon in the address bar.' };
  if (safari) return { kind: 'text', text: 'In Safari, choose File, then Add to Dock.' };
  return { kind: 'text', text: 'Use your browser’s menu to install this site.' };
}

let deferredPrompt = null;
let refreshPrompt = () => {};

function stashPrompt(event) {
  if (event && event.preventDefault) event.preventDefault();
  deferredPrompt = event;
  if (typeof window !== 'undefined') window.__deferredInstallPrompt = event;
  refreshPrompt();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  if (window.__deferredInstallPrompt) deferredPrompt = window.__deferredInstallPrompt;
  window.addEventListener('beforeinstallprompt', stashPrompt);
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    window.__deferredInstallPrompt = null;
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
  const hint = document.getElementById('install-hint');
  const hintText = document.getElementById('install-hint-text');
  const hintArrow = document.getElementById('install-hint-arrow');
  if (!downloadBtn) return;

  const ua = navigator.userAgent || '';
  const hints = { platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints || 0 };
  deferredPrompt = resolveInstallPrompt(deferredPrompt, window.__deferredInstallPrompt);

  function hideHint() {
    if (!hint) return;
    hint.hidden = true;
    downloadBtn.setAttribute('aria-expanded', 'false');
  }
  function markInstalled() {
    hideHint();
    downloadBtn.hidden = true;
    if (installedEl) installedEl.hidden = false;
  }
  window.__pwaMarkInstalled = markInstalled;
  refreshPrompt = () => {};

  if (isInstalled(navigator, (query) => window.matchMedia(query))) {
    markInstalled();
    return;
  }

  function showFallback() {
    if (!hint || !hintText) return;
    const fallback = installFallback(ua, hints);
    hintText.textContent = fallback.text;
    hint.classList.toggle('is-ios', fallback.kind === 'ios');
    if (hintArrow) hintArrow.hidden = fallback.kind !== 'ios';
    hint.hidden = false;
    downloadBtn.setAttribute('aria-expanded', 'true');
  }

  downloadBtn.addEventListener('click', () => {
    const prompt = resolveInstallPrompt(deferredPrompt, window.__deferredInstallPrompt);
    if (prompt) {
      deferredPrompt = null;
      window.__deferredInstallPrompt = null;
      hideHint();
      try {
        const pending = prompt.prompt();
        if (pending && pending.catch) pending.catch(() => {});
      } catch (err) { /* the browser declined to show its install prompt */ }
      if (prompt.userChoice) {
        prompt.userChoice.then((choice) => {
          if (choice && choice.outcome === 'accepted') markInstalled();
        }).catch(() => {});
      }
      return;
    }
    if (hint && !hint.hidden) hideHint();
    else showFallback();
  });

  const close = document.getElementById('install-hint-close');
  if (close) close.addEventListener('click', hideHint);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideHint();
  });
  document.addEventListener('click', (event) => {
    if (!hint || hint.hidden) return;
    if (event.target === downloadBtn || hint.contains(event.target)) return;
    hideHint();
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
