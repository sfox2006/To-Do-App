/* Service worker registration and the Install app button.
   beforeinstallprompt is stored as soon as it fires, including before the button exists. */

export function isIos(ua, hints) {
  const source = ua == null
    ? (typeof navigator !== 'undefined' ? navigator.userAgent || '' : '')
    : String(ua);
  const info = hints || (typeof navigator !== 'undefined'
    ? { platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints || 0 }
    : {});
  const platform = String(info.platform || '');
  const touch = Number(info.maxTouchPoints) || 0;
  return /iPad|iPhone|iPod/.test(source) || (platform === 'MacIntel' && touch > 1);
}

/** Installed when the page is standalone, or iOS reports navigator.standalone. */
export function isStandalone(nav = {}, matchMedia = () => ({ matches: false })) {
  try {
    if (matchMedia('(display-mode: standalone)').matches) return true;
  } catch (err) { /* ignore a broken matchMedia */ }
  return nav.standalone === true;
}

/** The prompt captured before the button was drawn still counts. */
export function resolveInstallPrompt(local, stashed) {
  return local || stashed || null;
}

/** Browser-specific steps shown when the native install prompt is unavailable. */
export function installHelp(ua, hints) {
  const source = ua == null
    ? (typeof navigator !== 'undefined' ? navigator.userAgent || '' : '')
    : String(ua);
  const info = hints || (typeof navigator !== 'undefined'
    ? { platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints || 0 }
    : {});
  if (isIos(source, info)) {
    return {
      heading: 'Add to Home Screen',
      text: 'Tap Share, then Add to Home Screen.',
    };
  }
  const android = /Android/i.test(source);
  const firefox = /Firefox/i.test(source);
  const edgeDesktop = /Edg\//i.test(source) && !/EdgA\//i.test(source);
  const opera = /OPR\/|Opera/i.test(source);
  const samsung = /SamsungBrowser/i.test(source);
  const chrome = /Chrome|Chromium/i.test(source) && !edgeDesktop && !/EdgA\//i.test(source) && !opera && !samsung;
  if (android && chrome) {
    return {
      heading: 'Install app',
      text: 'Open the menu and choose Install app or Add to Home screen.',
    };
  }
  if (!android && firefox) {
    return {
      heading: 'Install app',
      text: 'Firefox does not install web apps on desktop. Bookmark the page, or open it in Chrome or Edge.',
    };
  }
  if (!android && (chrome || edgeDesktop)) {
    return {
      heading: 'Install app',
      text: 'Click the install icon at the right end of the address bar, or open the browser menu (three dots) and choose Cast, save and share > Install page as app (Chrome) / Apps > Install this site as an app (Edge).',
    };
  }
  return {
    heading: 'Install app',
    text: 'Open the browser menu and look for Install app or Add to Home Screen.',
  };
}

let deferredPrompt = null;
let onPrompt = () => {};
let onInstalled = () => {};

function stashPrompt(event) {
  if (event && event.preventDefault) event.preventDefault();
  deferredPrompt = event;
  if (typeof window !== 'undefined') window.__deferredInstallPrompt = event;
  onPrompt();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  if (window.__deferredInstallPrompt) deferredPrompt = window.__deferredInstallPrompt;
  window.addEventListener('beforeinstallprompt', stashPrompt);
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    window.__deferredInstallPrompt = null;
    onInstalled();
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
  bindInstall();
}

function bindInstall() {
  const install = document.getElementById('install-app');
  const dialog = document.getElementById('install-dialog');
  const heading = document.getElementById('install-heading');
  const instructions = document.getElementById('install-instructions');
  const closeBtn = document.getElementById('install-close');
  if (!install) return;

  let restoreInstallOnClose = false;

  function standaloneNow() {
    return isStandalone(navigator, (query) => window.matchMedia(query));
  }

  function hideInstall() {
    install.hidden = true;
    closeInstallDialog(false);
  }

  function showInstallButton(mode) {
    if (standaloneNow()) {
      install.hidden = true;
      return;
    }
    install.hidden = false;
    if (mode === 'instructions') {
      install.setAttribute('aria-haspopup', 'dialog');
      install.setAttribute('aria-controls', 'install-dialog');
    } else {
      install.removeAttribute('aria-haspopup');
      install.removeAttribute('aria-controls');
    }
  }

  function restoreInstallFocus() {
    if (!install.hidden) install.focus();
  }

  function openInstallDialog() {
    if (!dialog) return;
    const help = installHelp();
    if (heading) heading.textContent = help.heading;
    if (instructions) instructions.textContent = help.text;
    if (dialog.showModal && !dialog.open) dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeInstallDialog(restore) {
    if (!dialog) return;
    const wasOpen = dialog.open || dialog.hasAttribute('open');
    if (!wasOpen) return;
    restoreInstallOnClose = Boolean(restore);
    if (dialog.close) dialog.close();
    else dialog.removeAttribute('open');
    if (!dialog.close && restore) restoreInstallFocus();
  }

  if (dialog) {
    dialog.addEventListener('cancel', () => {
      restoreInstallOnClose = true;
    });
    dialog.addEventListener('close', () => {
      if (!restoreInstallOnClose) return;
      restoreInstallOnClose = false;
      restoreInstallFocus();
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeInstallDialog(true);
    });
  }
  if (closeBtn) closeBtn.addEventListener('click', () => closeInstallDialog(true));

  const standaloneQuery = window.matchMedia('(display-mode: standalone)');
  const onDisplayMode = () => {
    if (standaloneNow()) hideInstall();
    else showInstallButton(resolveInstallPrompt(deferredPrompt, window.__deferredInstallPrompt) ? 'native' : 'instructions');
  };
  if (standaloneQuery.addEventListener) standaloneQuery.addEventListener('change', onDisplayMode);
  else if (standaloneQuery.addListener) standaloneQuery.addListener(onDisplayMode);

  onPrompt = () => {
    if (!standaloneNow()) showInstallButton('native');
  };
  onInstalled = hideInstall;

  deferredPrompt = resolveInstallPrompt(deferredPrompt, window.__deferredInstallPrompt);
  if (standaloneNow()) hideInstall();
  else showInstallButton(deferredPrompt ? 'native' : 'instructions');

  install.addEventListener('click', async () => {
    const promptEvent = resolveInstallPrompt(deferredPrompt, window.__deferredInstallPrompt);
    if (promptEvent) {
      deferredPrompt = null;
      window.__deferredInstallPrompt = null;
      install.disabled = true;
      let accepted = false;
      try {
        const pending = promptEvent.prompt();
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
        const choice = await promptEvent.userChoice;
        accepted = Boolean(choice && choice.outcome === 'accepted');
      } catch (err) {
        if (!standaloneNow()) showInstallButton('instructions');
        openInstallDialog();
        return;
      } finally {
        install.disabled = false;
      }
      if (accepted) hideInstall();
      else if (!standaloneNow()) showInstallButton('instructions');
      return;
    }
    openInstallDialog();
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
