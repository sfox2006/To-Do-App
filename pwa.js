/* PWA glue: service worker registration, install button, iOS hint. */
(function () {
  'use strict';

  // --- Service worker (relative path so it works from a subpath) ---
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function (err) {
        console.warn('Service worker registration failed:', err);
      });
    });
  }

  var isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  if (isStandalone) return; // already installed: no prompts

  function css() {
    if (document.getElementById('pwa-style')) return;
    var s = document.createElement('style');
    s.id = 'pwa-style';
    s.textContent =
      '.pwa-install-btn{font:inherit;font-size:.875rem;font-weight:600;padding:.4rem .8rem;border-radius:999px;' +
      'border:1px solid #4f46e5;background:#4f46e5;color:#fff;cursor:pointer}' +
      '.pwa-install-btn:hover{background:#4338ca}' +
      '.pwa-install-btn:focus-visible{outline:3px solid #a5b4fc;outline-offset:2px}' +
      '.pwa-install-btn.pwa-floating{position:fixed;right:1rem;bottom:calc(1rem + env(safe-area-inset-bottom,0px));' +
      'z-index:1000;box-shadow:0 4px 14px rgba(0,0,0,.25)}' +
      '.pwa-ios-hint{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(1rem + env(safe-area-inset-bottom,0px));' +
      'z-index:1000;max-width:calc(100% - 2rem);display:flex;gap:.75rem;align-items:center;background:#1f2937;color:#fff;' +
      'padding:.7rem .9rem;border-radius:12px;font:inherit;font-size:.9rem;box-shadow:0 6px 20px rgba(0,0,0,.35)}' +
      '.pwa-ios-hint button{font:inherit;background:transparent;border:0;color:#c7d2fe;font-weight:600;cursor:pointer;padding:.2rem .4rem}';
    document.head.appendChild(s);
  }

  // --- Install button (Chrome/Edge/Android/desktop) ---
  var deferredPrompt = null;
  var btn = null;

  function showInstallButton() {
    if (btn || !deferredPrompt) return;
    css();
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pwa-install-btn';
    btn.textContent = 'Install app';
    btn.setAttribute('aria-label', 'Install this app');
    btn.addEventListener('click', function () {
      if (!deferredPrompt) return;
      var p = deferredPrompt;
      deferredPrompt = null;
      hideInstallButton();
      p.prompt();
      if (p.userChoice) p.userChoice.catch(function () {});
    });
    var slot = document.getElementById('install-slot');
    if (slot) {
      slot.appendChild(btn);
    } else {
      btn.classList.add('pwa-floating');
      document.body.appendChild(btn);
    }
  }

  function hideInstallButton() {
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
    btn = null;
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (document.body) showInstallButton();
    else document.addEventListener('DOMContentLoaded', showInstallButton);
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    hideInstallButton();
  });

  // --- iOS Safari one-time hint ---
  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA/.test(ua);
  var HINT_KEY = 'pwa-ios-hint-shown';

  function seen() {
    try { return localStorage.getItem(HINT_KEY) === '1'; } catch (e) { return false; }
  }
  function markSeen() {
    try { localStorage.setItem(HINT_KEY, '1'); } catch (e) {}
  }

  function showIOSHint() {
    css();
    var box = document.createElement('div');
    box.className = 'pwa-ios-hint';
    box.setAttribute('role', 'status');
    var msg = document.createElement('span');
    msg.textContent = 'Tap Share then Add to Home Screen';
    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Got it';
    close.addEventListener('click', function () {
      if (box.parentNode) box.parentNode.removeChild(box);
    });
    box.appendChild(msg);
    box.appendChild(close);
    document.body.appendChild(box);
    markSeen();
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 15000);
  }

  if (isIOS && isSafari && !seen()) {
    window.addEventListener('load', function () { setTimeout(showIOSHint, 1500); });
  }
})();
