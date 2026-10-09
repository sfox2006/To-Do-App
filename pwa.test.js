import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isIos, isStandalone, installHelp, resolveInstallPrompt } from './pwa.js';

const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ipad = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const chromeIOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1';
const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';
const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0';
const chromeEdgeSteps = 'Click the install icon at the right end of the address bar, or open the browser menu (three dots) and choose Cast, save and share > Install page as app (Chrome) / Apps > Install this site as an app (Edge).';

test('isIos includes iPhone, iPad, and iPadOS', () => {
  assert.equal(isIos(iphone), true);
  assert.equal(isIos(ipad), true);
  assert.equal(isIos(chromeIOS), true);
  assert.equal(isIos(mac, { platform: 'MacIntel', maxTouchPoints: 5 }), true);
  assert.equal(isIos(android), false);
  assert.equal(isIos(windows), false);
  assert.equal(isIos(mac, { platform: 'MacIntel', maxTouchPoints: 0 }), false);
});

test('a prompt saved before the button exists is the one that runs', () => {
  const early = { prompt() {} };
  assert.equal(resolveInstallPrompt(null, early), early);
  assert.equal(resolveInstallPrompt(early, null), early);
  assert.equal(resolveInstallPrompt(null, null), null);
});

test('install help matches the browser', () => {
  assert.equal(installHelp(iphone).heading, 'Add to Home Screen');
  assert.equal(installHelp(iphone).text, 'Tap Share, then Add to Home Screen.');
  assert.equal(installHelp(ipad).text, 'Tap Share, then Add to Home Screen.');
  assert.equal(installHelp(chromeIOS).text, 'Tap Share, then Add to Home Screen.');
  assert.equal(installHelp(mac, { platform: 'MacIntel', maxTouchPoints: 5 }).text, 'Tap Share, then Add to Home Screen.');
  assert.equal(installHelp(android).text, 'Open the menu and choose Install app or Add to Home screen.');
  assert.equal(installHelp(firefox).text, 'Firefox does not install web apps on desktop. Bookmark the page, or open it in Chrome or Edge.');
  assert.equal(installHelp(windows).text, chromeEdgeSteps);
  assert.equal(installHelp(edge).text, chromeEdgeSteps);
  assert.equal(installHelp(mac).text, 'Open the browser menu and look for Install app or Add to Home Screen.');
});

test('the installed app is Brain Dump at /To-Do-App/, not the shared origin', () => {
  const manifest = JSON.parse(readFileSync(new URL('./manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.name, 'Brain Dump');
  assert.equal(manifest.short_name, 'Brain Dump');
  assert.equal(manifest.id, '/To-Do-App/');
  assert.equal(manifest.start_url, '/To-Do-App/?source=pwa');
  assert.equal(manifest.scope, '/To-Do-App/');
  assert.equal(manifest.start_url.startsWith(manifest.scope), true);
  const sw = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  assert.match(sw, /const VERSION = 'v15'/);
  assert.match(sw, /function networkFirst/);
  assert.match(sw, /function isShellCode/);
  assert.match(sw, /const CACHE = `todo-app-\$\{VERSION\}`/);
  assert.match(sw, /pathname\.startsWith\(APP_PATH\)/);
  assert.match(sw, /k\.startsWith\('todo-app-'\)/);
  assert.doesNotMatch(sw, /dc-social/);
  const pwa = readFileSync(new URL('./pwa.js', import.meta.url), 'utf8');
  assert.match(pwa, /register\('\/To-Do-App\/sw\.js', \{ scope: '\/To-Do-App\/' \}\)/);
  assert.match(pwa, /controllerchange/);
  assert.match(pwa, /location\.reload\(\)/);
});

test('isStandalone accepts display-mode standalone and the iOS navigator flag', () => {
  const media = (query) => ({ matches: query === '(display-mode: standalone)' });
  assert.equal(isStandalone({}, media), true);
  assert.equal(isStandalone({ standalone: true }, () => ({ matches: false })), true);
  assert.equal(isStandalone({}, () => ({ matches: false })), false);
  assert.equal(isStandalone({}, (query) => ({ matches: query === '(display-mode: fullscreen)' })), false);
});
