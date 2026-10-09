/**
 * Phone smoke test for Manage tags.
 * Taps both entry points with touch and replays two iOS Safari quirks:
 * focusout (relatedTarget null) before the menu click, and the opening tap
 * landing on the full-screen dialog backdrop.
 *
 *   npm install
 *   npx playwright install chromium webkit
 *   node scripts/manage-tags-touch.mjs
 *
 * BASE_URL defaults to the local pages server. Set WEBKIT=0 to skip WebKit.
 */
import { chromium, webkit, devices } from 'playwright';

const base = process.env.BASE_URL || 'http://127.0.0.1:8766/To-Do-App/';
const iphone = devices['iPhone 13'];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function prepare(page) {
  await page.route(/supabase\.co|esm\.sh/, (route) => route.abort());
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-btn');
  await page.locator('#dump').fill('Email Grok #work by Friday.');
  await page.locator('#submit').tap();
  await page.waitForSelector('.tag-chip.manage');
  return errors;
}

async function sheetVisible(page) {
  return page.evaluate(() => {
    const dlg = document.querySelector('#tags-dialog');
    const panel = document.querySelector('#tags-dialog .editor-panel');
    const heading = document.querySelector('#tags-heading');
    if (!dlg || !dlg.open || !panel || !heading) return { open: false };
    const pr = panel.getBoundingClientRect();
    const hr = heading.getBoundingClientRect();
    const viewH = window.innerHeight;
    const viewW = document.documentElement.clientWidth;
    return {
      open: true,
      heading: heading.textContent.trim(),
      panelH: pr.height,
      panelTop: pr.top,
      panelBottom: pr.bottom,
      headingTop: hr.top,
      headingVisible: hr.top >= -1 && hr.bottom <= viewH + 1 && hr.width > 0,
      inView: pr.height > 120 && pr.top < viewH - 40 && pr.left >= -1 && pr.right <= viewW + 1,
    };
  });
}

async function iosFocusOutBeforeClick(page) {
  await page.locator('#menu-btn').tap();
  await page.waitForSelector('#app-menu:not([hidden])');
  const hidden = await page.evaluate(() => {
    const wrap = document.querySelector('.menu-wrap');
    const item = document.querySelector('#manage-tags');
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'touch' }));
    wrap.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    return document.querySelector('#app-menu').hidden;
  });
  assert(hidden === false, 'iOS focusout closed the menu before the tap');
  const point = await page.locator('#manage-tags').boundingBox();
  await page.locator('#manage-tags').tap();
  await page.waitForSelector('#tags-dialog[open]');
  await page.evaluate((pt) => {
    const dlg = document.querySelector('#tags-dialog');
    dlg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: pt.x, clientY: pt.y }));
  }, { x: point.x + point.width / 2, y: point.y + point.height / 2 });
  const vis = await sheetVisible(page);
  assert(vis.open && vis.heading === 'Manage tags' && vis.headingVisible && vis.inView, 'menu entry ' + JSON.stringify(vis));
  await page.screenshot({ path: `/opt/cursor/artifacts/manage_tags_${page.__label || 'phone'}.png` });
  await page.locator('#tags-close').tap();
  await page.waitForFunction(() => !document.querySelector('#tags-dialog').open);
}

async function chipEntry(page) {
  await page.locator('.tag-chip.manage').tap();
  await page.waitForSelector('#tags-dialog[open]');
  const vis = await sheetVisible(page);
  assert(vis.open && vis.heading === 'Manage tags' && vis.headingVisible && vis.inView, 'chip entry ' + JSON.stringify(vis));
  const box = await page.locator('#tags-dialog').boundingBox();
  await page.evaluate((pt) => {
    const dlg = document.querySelector('#tags-dialog');
    dlg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: pt.x, clientY: pt.y }));
    dlg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: pt.x, clientY: pt.y }));
  }, { x: box.x + 8, y: box.y + 8 });
  const closed = await page.evaluate(() => !document.querySelector('#tags-dialog').open);
  assert(closed, 'backdrop tap should still close the sheet');
}

async function run(browserType, label) {
  const browser = await browserType.launch();
  const page = await browser.newPage({ ...iphone });
  page.__label = label;
  const errors = await prepare(page);
  await iosFocusOutBeforeClick(page);
  await chipEntry(page);
  const unexpected = errors.filter((e) => !/supabase|Failed to fetch|esm\.sh/i.test(e));
  assert(unexpected.length === 0, unexpected.join('\n'));
  await browser.close();
  console.log(label + ' OK');
}

const jobs = [['chromium', chromium]];
if (process.env.WEBKIT !== '0') jobs.push(['webkit', webkit]);
let failed = false;
for (const [label, type] of jobs) {
  try {
    await run(type, label);
  } catch (err) {
    failed = true;
    console.error(label + ' FAILED', err && err.message ? err.message : err);
  }
}
if (failed) process.exit(1);
