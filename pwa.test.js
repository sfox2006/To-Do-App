import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, isIosSafari, isInstalled, installFallback, resolveInstallPrompt } from './pwa.js';

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ipad = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const chromeIOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1';
const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

test('detectPlatform picks the device from the user agent', () => {
  assert.equal(detectPlatform(iphone), 'ios');
  assert.equal(detectPlatform(ipad), 'ios');
  assert.equal(detectPlatform(chromeIOS), 'ios');
  assert.equal(detectPlatform(mac, { platform: 'MacIntel', maxTouchPoints: 5 }), 'ios');
  assert.equal(detectPlatform(android), 'android');
  assert.equal(detectPlatform(windows), 'windows');
  assert.equal(detectPlatform(windows, { platform: 'Win32' }), 'windows');
  assert.equal(detectPlatform(mac, { platform: 'MacIntel', maxTouchPoints: 0 }), 'mac');
  assert.equal(detectPlatform('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'), 'other');
  assert.equal(detectPlatform(''), 'other');
});

test('isIosSafari is only Safari, not Chrome on iPhone', () => {
  assert.equal(isIosSafari(iphone), true);
  assert.equal(isIosSafari(chromeIOS), false);
  assert.equal(isIosSafari(windows), true);
});

test('a prompt saved before the button exists is the one that runs', () => {
  const early = { prompt() {} };
  assert.equal(resolveInstallPrompt(null, early), early);
  assert.equal(resolveInstallPrompt(early, null), early);
  assert.equal(resolveInstallPrompt(null, null), null);
});

test('install fallback is one line, and only iOS Safari points at Share', () => {
  const ios = installFallback(iphone);
  assert.equal(ios.kind, 'ios');
  assert.equal(ios.text, 'Share, then Add to Home Screen');
  assert.match(installFallback(chromeIOS).text, /Safari/);
  assert.equal(installFallback(chromeIOS).kind, 'text');
  assert.match(installFallback(windows).text, /address bar/);
  assert.match(installFallback(android).text, /Install app/);
  const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
  assert.match(installFallback(edge).text, /Apps/);
  const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0';
  assert.match(installFallback(firefox).text, /Firefox/);
  assert.match(installFallback(firefox).text, /Chrome or Edge/);
  assert.match(installFallback(mac).text, /Add to Dock/);
  for (const sample of [iphone, chromeIOS, windows, android, edge, firefox, mac]) {
    assert.equal(installFallback(sample).text.includes('\n'), false);
  }
});

test('isInstalled accepts standalone and the iOS navigator flag', () => {
  const media = (query) => ({ matches: query === '(display-mode: standalone)' });
  assert.equal(isInstalled({}, media), true);
  assert.equal(isInstalled({ standalone: true }, () => ({ matches: false })), true);
  assert.equal(isInstalled({}, () => ({ matches: false })), false);
  assert.equal(isInstalled({}, (query) => ({ matches: query === '(display-mode: window-controls-overlay)' })), true);
});
