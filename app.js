import { parseTasks, bucketFor } from './parser.js';
import * as store from './store.js';
import { createSync, loadSupabaseClient, ensureOwnerSession } from './sync.js';

const $ = (s) => document.querySelector(s);
const dumpEl = $('#dump'), formEl = $('#dump-form'), listsEl = $('#lists');
const searchEl = $('#search'), completedEl = $('#completed'), completedList = $('#completed-list');
const emptyEl = $('#empty');

const GROUPS = [
  ['overdue', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'],
  ['this-week', 'This week'], ['next-week', 'Next week'], ['later', 'Later'], ['no-date', 'No date'],
];

const TAG_FILTER_KEY = 'braindump-todo:tag-filter';
const TAG_COLOR_LABELS = {
  red: 'Red', orange: 'Orange', amber: 'Amber', green: 'Green',
  teal: 'Teal', blue: 'Blue', violet: 'Violet', pink: 'Pink',
};
let query = '';
let tagFilter = '';
let editorTags = [];
let renamingTag = '';
let newTagColor = '';
let pendingTagUndo = null;
let editing = null;          // { id, focus: 'title'|'date' } quick in-list edit
let editor = null;           // { id } full edit sheet/modal
let newIds = new Set();      // recently added -> highlight
const pending = new Set();   // ids mid-animation

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
$('#kbd-hint').textContent = isMac ? '⌘ ⏎' : 'Ctrl ⏎';

/* ---------- helpers ---------- */
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  kids.flat().forEach((c) => c != null && n.append(c));
  return n;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function parseISO(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function fmtWhen(t) {
  if (!t.due) return 'No date';
  const d = parseISO(t.due);
  const now = new Date();
  let s = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  if (t.time) {
    const [h, m] = t.time.split(':').map(Number);
    s += ' · ' + new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return s;
}
function bucket(t) { try { return bucketFor(t.due, new Date()); } catch { return t.due ? 'later' : 'no-date'; } }
function isOverdue(t) { return !t.done && bucket(t) === 'overdue'; }
const byDue = (a, b) =>
  (a.due || '9999').localeCompare(b.due || '9999') ||
  (a.time || '99:99').localeCompare(b.time || '99:99') || a.createdAt - b.createdAt;

/* ---------- toast ---------- */
let toastTimer;
const toastEl = $('#toast'), toastMsg = $('#toast-msg'), toastBtn = $('#toast-action');
function toast(msg, actionLabel, action, ms = 6000) {
  clearTimeout(toastTimer);
  toastMsg.textContent = msg;
  toastBtn.hidden = !action;
  toastBtn.textContent = actionLabel || '';
  toastBtn.onclick = () => { hideToast(); action && action(); };
  toastEl.hidden = false;
  toastEl.style.animation = 'none'; void toastEl.offsetWidth; toastEl.style.animation = '';
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { clearTimeout(toastTimer); toastEl.hidden = true; }

/* ---------- rendering ---------- */
function noteLine(note) { return String(note || '').replace(/\s+/g, ' ').trim(); }
function matches(t) {
  if (tagFilter && !(t.tags || []).includes(tagFilter)) return false;
  if (!query) return true;
  const q = query.toLowerCase();
  const note = (t.note || '').toLowerCase();
  return t.title.toLowerCase().includes(q)
    || (note && (note.includes(q) || note.replace(/\s+/g, ' ').includes(q)))
    || (t.tags || []).some((name) => name.includes(q))
    || (t.due && (t.due.includes(q) || fmtWhen(t).toLowerCase().includes(q)));
}

function render() {
  if (tagFilter) {
    const live = store.getTagCatalog().some((t) => t.name === tagFilter);
    const buried = store.getTagRegistry().tombstones.some((t) => t.name === tagFilter);
    if (buried && !live) {
      tagFilter = '';
      try { localStorage.removeItem(TAG_FILTER_KEY); } catch {}
    }
  }
  const all = store.getTasks();
  if (editor && !all.some((t) => t.id === editor.id)) {
    editor = null;
    const dlg = $('#editor');
    if (dlg && dlg.open) dlg.close();
  }
  const visible = all.filter(matches);
  const open = visible.filter((t) => !t.done);
  const done = visible.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

  const grouped = Object.fromEntries(GROUPS.map(([k]) => [k, []]));
  for (const t of open) (grouped[bucket(t)] || grouped['later']).push(t);

  listsEl.replaceChildren();
  for (const [key, label] of GROUPS) {
    const items = grouped[key].sort(byDue);
    if (!items.length) continue;
    const hid = 'h-' + key;
    listsEl.append(el('section', { class: `group ${key}`, 'aria-labelledby': hid },
      el('h2', { id: hid }, label, el('span', { class: 'count', text: String(items.length), 'aria-label': plural(items.length, 'task') })),
      el('ul', { class: 'tasks' }, items.map(taskRow))));
  }

  completedList.replaceChildren(...done.map(taskRow));
  const doneCount = all.filter((t) => t.done).length;
  completedEl.hidden = !done.length && !doneCount;
  $('#completed-count').textContent = String(doneCount);
  completedEl.querySelector('summary').setAttribute('aria-label',
    doneCount ? `Completed, ${plural(doneCount, 'task')}. Show or hide.` : 'Completed');
  $('#clear-completed').hidden = !all.some((t) => t.done);

  const openAll = all.filter((t) => !t.done).length;
  if (!visible.length) {
    emptyEl.hidden = false;
    emptyEl.textContent = tagFilter && !query
      ? `No tasks tagged #${tagFilter}.`
      : query ? `No tasks match “${query}”.` : 'Nothing to do yet. Dump your thoughts above ☝️';
  } else if (!open.length && !query && !tagFilter) {
    emptyEl.hidden = false; emptyEl.textContent = openAll ? '' : 'All clear! 🎉 Nothing left to do.';
  } else emptyEl.hidden = true;
  const status = [];
  if (tagFilter) status.push(`Filtered by #${tagFilter}`);
  if (query || tagFilter) status.push(`${plural(visible.length, 'task')} ${query ? 'found' : 'shown'}`);
  $('#search-status').textContent = status.join('. ');
  renderTagBar();
  if ($('#tags-dialog') && $('#tags-dialog').open) renderTagManager();

  newIds = new Set();
  if (editing && !($('#editor') && $('#editor').open)) {
    const f = document.querySelector(editing.focus === 'date' ? '.edit input[type=date]' : '.edit input[type=text]');
    if (f) { f.focus(); if (f.select && f.type === 'text') f.select(); }
  }
}

function taskRow(t) {
  if (editing && editing.id === t.id) return editRow(t);
  const cls = ['task'];
  if (isOverdue(t)) cls.push('overdue');
  if (t.done) cls.push('done-task');
  if (newIds.has(t.id)) cls.push('new');
  const cb = el('input', {
    type: 'checkbox', id: 'c-' + t.id, 'aria-label': `${t.done ? 'Mark not done' : 'Mark done'}: ${t.title}`,
    onchange: () => toggle(t.id, cb.checked, li),
  });
  cb.checked = t.done;
  const when = el('button', {
    type: 'button', class: 'when' + (t.due ? '' : ' empty'), text: fmtWhen(t),
    'aria-label': `Due: ${t.due ? fmtWhen(t) : 'no date'}${isOverdue(t) ? ' (overdue)' : ''}. Edit date`,
    onclick: () => startEdit(t.id, 'date'),
  });
  const body = el('div', { class: 'task-body' },
    el('label', { class: 'check' }, cb),
    el('div', { class: 'main' },
      el('button', {
        type: 'button', class: 'title', 'aria-label': `Edit task: ${t.title}`, 'aria-haspopup': 'dialog',
        onclick: (e) => {
          // Shift/Alt keeps the quick in-list title editor. A plain tap opens the full editor.
          if (e.shiftKey || e.altKey) startEdit(t.id, 'title');
          else openEditor(t.id, 'title');
        },
      }, el('span', { class: 'title-text', text: t.title })),
      el('div', { class: 'meta' }, when, taskTagRow(t)),
      notePreview(t),
      t.done ? el('button', {
        type: 'button', class: 'restore', text: 'Restore',
        'aria-label': `Move back to to-do: ${t.title}`,
        onclick: () => restore(t.id),
      }) : null),
    el('button', { type: 'button', class: 'del', 'aria-label': `Delete: ${t.title}`, title: 'Delete', text: '✕', onclick: () => remove(t.id, li) }));
  const li = el('li', { class: cls.join(' '), 'data-id': t.id },
    el('div', { class: 'swipe-bg', 'aria-hidden': 'true' }, el('span', { class: 'l', text: t.done ? '↺ Undo done' : '✓ Done' }), el('span', { class: 'r', text: 'Delete 🗑' })),
    body);
  attachSwipe(li, body, t);
  return li;
}

function glyph(paths) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'glyph');
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.8');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
  }
  return svg;
}
function notePreview(t) {
  if (!t.note) return null;
  const line = noteLine(t.note);
  return el('button', {
    type: 'button', class: 'note-preview', 'aria-haspopup': 'dialog',
    'aria-label': `Note: ${line.slice(0, 180)}. Edit task`,
    onclick: () => openEditor(t.id, 'note'),
  }, glyph([
    'M6 3.5h8.2L19.5 8.8V20a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 20V5A1.5 1.5 0 0 1 6 3.5z',
    'M14.2 3.8V9H19.2',
    'M8 12.2h8',
    'M8 16h5.5',
  ]), el('span', { class: 'note-text', text: line }));
}

function editRow(t) {
  const title = el('input', { type: 'text', id: 'e-title', value: t.title, 'aria-label': 'Task title', maxlength: '500' });
  const date = el('input', { type: 'date', id: 'e-date', value: t.due || '' });
  const time = el('input', { type: 'time', id: 'e-time', value: t.time || '' });
  time.disabled = !t.due;
  date.addEventListener('input', () => { time.disabled = !date.value; if (!date.value) time.value = ''; });
  const save = () => {
    const nt = title.value.trim();
    if (!nt) { title.focus(); return; }
    editing = null;
    store.updateTask(t.id, { title: nt, due: date.value || null, time: date.value ? (time.value || null) : null });
  };
  const cancel = () => { editing = null; render(); };
  const form = el('form', { class: 'edit', onsubmit: (e) => { e.preventDefault(); save(); } },
    el('label', { class: 'sr-only', for: 'e-title', text: 'Task title' }), title,
    el('div', { class: 'row' },
      el('label', { for: 'e-date' }, 'Date', date),
      el('label', { for: 'e-time' }, 'Time (optional)', time)),
    el('div', { class: 'actions' },
      el('button', { type: 'submit', class: 'save', text: 'Save' }),
      el('button', { type: 'button', text: 'Cancel', onclick: cancel }),
      el('button', { type: 'button', class: 'nodate', text: 'No date', onclick: () => { date.value = ''; time.value = ''; time.disabled = true; } })));
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } });
  return el('li', { class: 'task editing', 'data-id': t.id }, form);
}

/* ---------- full editor (bottom sheet on a phone, dialog on a laptop) ---------- */
function editorFields() {
  return {
    title: $('#editor-task-title'),
    date: $('#editor-date'),
    time: $('#editor-time'),
    note: $('#editor-note'),
  };
}
function focusables(dlg) {
  return [...dlg.querySelectorAll('button, input, textarea')].filter((n) => !n.disabled);
}
function openEditor(id, focus = 'title') {
  const t = store.getTasks().find((x) => x.id === id);
  if (!t) return;
  editing = null;
  editor = { id };
  const f = editorFields();
  f.title.value = t.title;
  f.date.value = t.due || '';
  f.time.value = t.time || '';
  f.time.disabled = !t.due;
  f.note.value = t.note || '';
  editorTags = [...(t.tags || [])];
  const tagInput = $('#editor-tag-input');
  if (tagInput) tagInput.value = '';
  renderEditorTags();
  render();
  const dlg = $('#editor');
  showDialog(dlg);
  const field = focus === 'note' ? f.note : f.title;
  field.focus();
  if (focus !== 'note' && field.select) field.select();
}
function closeEditor() {
  const id = editor && editor.id;
  editor = null;
  const dlg = $('#editor');
  if (dlg.open) dlg.close();
  if (!id) return;
  const back = document.querySelector(`[data-id="${CSS.escape(id)}"] .title`);
  if (back) back.focus();
}
function saveEditor() {
  if (!editor) return;
  const f = editorFields();
  const title = f.title.value.trim();
  if (!title) { f.title.focus(); return; }
  const id = editor.id;
  const due = f.date.value || null;
  const time = due ? (f.time.value || null) : null;
  const note = f.note.value;
  const tags = editorTags.slice();
  editor = null;
  const dlg = $('#editor');
  if (dlg.open) dlg.close();
  store.updateTask(id, { title, due, time, note, tags });
  const back = document.querySelector(`[data-id="${CSS.escape(id)}"] .title`);
  if (back) back.focus();
}
function showDialog(dlg) {
  document.querySelectorAll('dialog').forEach((other) => {
    if (other !== dlg && other.open) other.close();
  });
  if (dlg.open) return;
  try {
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  } catch (err) {
    // iOS throws if another dialog is still closing. The [open] styles still show the sheet.
    if (!dlg.open) dlg.setAttribute('open', '');
  }
}
function bindBackdropDismiss(dlg, close) {
  // iOS delivers the opening tap to whatever is now under the finger. A bottom
  // sheet's backdrop is the full-screen dialog, so that click used to close it
  // in the same gesture. Only a pointerdown that starts on the backdrop counts.
  let pointerOnBackdrop = false;
  dlg.addEventListener('pointerdown', (e) => { pointerOnBackdrop = e.target === dlg; });
  dlg.addEventListener('click', (e) => {
    const dismiss = pointerOnBackdrop && e.target === dlg;
    pointerOnBackdrop = false;
    if (dismiss) close();
  });
}
function bindEditorViewport(dlg, { scrollFocused = true } = {}) {
  const vv = window.visualViewport;
  const narrow = () => window.matchMedia('(max-width: 39.99rem)').matches;
  function place() {
    if (!dlg.open || !narrow() || !vv || vv.height < 1) {
      dlg.style.top = '';
      dlg.style.height = '';
      dlg.style.bottom = '';
      return;
    }
    dlg.style.top = `${vv.offsetTop}px`;
    dlg.style.height = `${vv.height}px`;
    dlg.style.bottom = 'auto';
    const active = document.activeElement;
    if (scrollFocused && active && dlg.contains(active) && active !== dlg && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }
  if (vv) {
    vv.addEventListener('resize', place);
    vv.addEventListener('scroll', place);
  }
  window.addEventListener('resize', place);
  dlg.addEventListener('toggle', place);
  dlg.addEventListener('close', () => {
    dlg.style.top = '';
    dlg.style.height = '';
    dlg.style.bottom = '';
  });
}
function menuOpen() {
  const menu = $('#app-menu');
  return menu && !menu.hidden;
}
function closeMenu(restore) {
  const menu = $('#app-menu');
  const btn = $('#menu-btn');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    if (restore) btn.focus();
  }
}
function openMenu() {
  const menu = $('#app-menu');
  const btn = $('#menu-btn');
  if (!menu || !btn) return;
  syncInstallMenuItem();
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  const first = menu.querySelector('[role="menuitem"]:not([hidden])');
  if (first) first.focus();
}
function syncInstallMenuItem() {
  const install = $('#install-app');
  const item = $('#menu-install');
  if (!install || !item) return;
  const narrow = window.matchMedia('(max-width: 39.99rem)').matches;
  item.hidden = !narrow || install.hidden;
}
function setupMenu() {
  const wrap = document.querySelector('.menu-wrap');
  const btn = $('#menu-btn');
  const menu = $('#app-menu');
  if (!wrap || !btn || !menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu(false);
  });
  document.addEventListener('pointerdown', (e) => {
    if (menu.hidden || wrap.contains(e.target)) return;
    closeMenu(false);
  });
  // iOS fires focusout with relatedTarget null before click, and hiding the
  // menu at that point drops the tap. Ignore focus moves during the tap itself.
  let tappingMenu = false;
  wrap.addEventListener('pointerdown', () => {
    tappingMenu = true;
    setTimeout(() => { tappingMenu = false; }, 700);
  });
  document.addEventListener('focusin', (e) => {
    if (menu.hidden || tappingMenu || wrap.contains(e.target)) return;
    closeMenu(false);
  });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('[role="menuitem"]:not([hidden])')];
    const index = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
      return;
    }
    if (index === -1 && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (!items.length) return;
      if (e.key === 'Home') items[0].focus();
      else if (e.key === 'End') items[items.length - 1].focus();
      else if (e.key === 'ArrowDown') items[(index + 1) % items.length].focus();
      else items[(index - 1 + items.length) % items.length].focus();
    }
  });
  $('#menu-install').addEventListener('click', () => {
    closeMenu(false);
    const install = $('#install-app');
    if (install) install.click();
  });
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[role="menuitem"]');
    if (!item || item.id === 'menu-install') return;
    closeMenu(false);
  });
  const install = $('#install-app');
  if (install && window.MutationObserver) {
    new MutationObserver(syncInstallMenuItem).observe(install, { attributes: true, attributeFilter: ['hidden'] });
  }
  const narrowQuery = window.matchMedia('(max-width: 39.99rem)');
  if (narrowQuery.addEventListener) narrowQuery.addEventListener('change', syncInstallMenuItem);
  syncInstallMenuItem();
}
function deleteFromEditor() {
  if (!editor) return;
  const id = editor.id;
  const li = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
  editor = null;
  const dlg = $('#editor');
  if (dlg.open) dlg.close();
  remove(id, li);
}
function setupEditor() {
  const dlg = $('#editor');
  const f = editorFields();
  f.date.addEventListener('input', () => {
    f.time.disabled = !f.date.value;
    if (!f.date.value) f.time.value = '';
  });
  $('#editor-form').addEventListener('submit', (e) => { e.preventDefault(); saveEditor(); });
  $('#editor-cancel').addEventListener('click', () => closeEditor());
  $('#editor-nodate').addEventListener('click', () => {
    f.date.value = '';
    f.time.value = '';
    f.time.disabled = true;
    f.date.focus();
  });
  $('#editor-delete').addEventListener('click', () => deleteFromEditor());
  $('#editor-tag-add').addEventListener('click', () => addEditorTag());
  $('#editor-tag-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addEditorTag(); }
  });
  bindEditorViewport(dlg);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeEditor(); });
  bindBackdropDismiss(dlg, () => closeEditor());
  dlg.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveEditor(); return; }
    if (e.key !== 'Tab') return;
    const nodes = focusables(dlg);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

function colorOf(name) {
  const hit = store.getTagCatalog().find((t) => t.name === name);
  return hit && hit.color ? hit.color : '';
}
function chipClass(name, extra) {
  const color = colorOf(name);
  return ['tag-chip', extra, color ? 'c-' + color : ''].filter(Boolean).join(' ');
}
function gearIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'glyph');
  const circle = document.createElementNS(ns, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '3');
  circle.setAttribute('fill', 'none');
  circle.setAttribute('stroke', 'currentColor');
  circle.setAttribute('stroke-width', '1.8');
  svg.append(circle);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('d', 'M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6 16.8 7.2M7.2 16.8 5.6 18.4');
  svg.append(path);
  return svg;
}
function readTagFilter() {
  try { tagFilter = store.normalizeTagName(localStorage.getItem(TAG_FILTER_KEY) || ''); }
  catch { tagFilter = ''; }
}
function setTagFilter(name) {
  tagFilter = store.normalizeTagName(name || '');
  try {
    if (tagFilter) localStorage.setItem(TAG_FILTER_KEY, tagFilter);
    else localStorage.removeItem(TAG_FILTER_KEY);
  } catch {}
  render();
}
function renderTagBar() {
  const bar = $('#tag-bar');
  const catalog = store.getTagCatalog();
  const used = catalog.filter((t) => t.count > 0 || t.name === tagFilter);
  const show = used.length > 0 || catalog.length > 0 || !!tagFilter;
  bar.hidden = !show;
  dumpEl.placeholder = tagFilter
    ? `Adding to #${tagFilter}`
    : 'Buy milk tomorrow. Call mum Friday. Dentist at 3pm next Tuesday.';
  if (!show) { bar.replaceChildren(); return; }
  const chips = el('div', { class: 'tag-chips', role: 'toolbar', 'aria-label': 'Filter by tag' });
  chips.append(el('button', {
    type: 'button',
    class: 'tag-chip' + (tagFilter ? '' : ' on'),
    'aria-pressed': tagFilter ? 'false' : 'true',
    text: 'All',
    onclick: () => setTagFilter(''),
  }));
  for (const tag of used) {
    const on = tagFilter === tag.name;
    chips.append(el('button', {
      type: 'button',
      class: chipClass(tag.name, on ? 'on' : ''),
      'aria-pressed': on ? 'true' : 'false',
      'aria-label': `Filter by #${tag.name}, ${plural(tag.count, 'task')}`,
      onclick: () => setTagFilter(on ? '' : tag.name),
    }, `#${tag.name}`, el('span', { class: 'tag-count', text: String(tag.count) })));
  }
  chips.append(el('button', {
    type: 'button',
    class: 'tag-chip manage',
    'aria-haspopup': 'dialog',
    onclick: () => openTags(),
  }, gearIcon(), el('span', { text: 'Manage' })));
  const parts = [chips];
  if (tagFilter) {
    parts.push(el('p', { class: 'tag-filter' },
      el('span', { text: `Filtered by #${tagFilter}` }),
      el('button', { type: 'button', 'aria-label': 'Clear tag filter', text: '×', onclick: () => setTagFilter('') }),
    ));
  }
  bar.replaceChildren(...parts);
}
function taskTagRow(t) {
  if (!t.tags || !t.tags.length) return null;
  return el('div', { class: 'task-tags' }, t.tags.map((name) => el('button', {
    type: 'button',
    class: chipClass(name, 'mini'),
    text: '#' + name,
    'aria-label': `Filter by #${name}`,
    onclick: (e) => {
      e.stopPropagation();
      setTagFilter(tagFilter === name ? '' : name);
    },
  })));
}
function renderEditorTags() {
  const box = $('#editor-tags');
  if (!box) return;
  box.replaceChildren(...editorTags.map((name) => el('span', { class: chipClass(name, 'mini') },
    el('span', { text: '#' + name }),
    el('button', {
      type: 'button',
      class: 'tag-x',
      'aria-label': `Remove #${name}`,
      text: '×',
      onclick: () => {
        editorTags = editorTags.filter((n) => n !== name);
        renderEditorTags();
      },
    }),
  )));
  const list = $('#editor-tag-suggestions');
  const have = new Set(editorTags);
  list.replaceChildren(...store.getTagCatalog()
    .filter((t) => !have.has(t.name))
    .map((t) => el('option', { value: t.name })));
}
function addEditorTag() {
  const input = $('#editor-tag-input');
  const name = store.normalizeTagName(input.value);
  if (!name) {
    if (input.value.trim()) toast('Tags need a letter, and can use numbers, - or _.');
    input.focus();
    return;
  }
  if (!editorTags.includes(name)) editorTags = store.normalizeTags([...editorTags, name]);
  input.value = '';
  renderEditorTags();
  input.focus();
}
function fillPalette(box, selected, onPick, label) {
  box.setAttribute('role', 'radiogroup');
  box.setAttribute('aria-label', label);
  const choices = [['', 'Default'], ...store.TAG_COLORS.map((id) => [id, TAG_COLOR_LABELS[id] || id])];
  box.replaceChildren(...choices.map(([id, text]) => {
    const pressed = (selected || '') === id;
    return el('button', {
      type: 'button',
      class: 'swatch' + (id ? ' c-' + id : '') + (pressed ? ' on' : ''),
      role: 'radio',
      'aria-checked': pressed ? 'true' : 'false',
      'aria-label': text,
      title: text,
      onclick: () => onPick(id),
    });
  }));
}
function paintNewPalette() {
  fillPalette($('#new-tag-palette'), newTagColor, (id) => {
    newTagColor = id;
    paintNewPalette();
  }, 'Colour for the new tag');
}
function tagsOpen() { return $('#tags-dialog') && $('#tags-dialog').open; }
function renderTagManager() {
  const list = $('#tag-manager');
  const catalog = store.getTagCatalog();
  $('#tags-empty').hidden = catalog.length > 0;
  const keepFocus = renamingTag && document.activeElement && document.activeElement.classList.contains('tag-rename')
    ? document.activeElement.value : null;
  list.replaceChildren(...catalog.map((tag) => {
    const head = el('div', { class: 'tag-row-head' });
    if (renamingTag === tag.name) {
      const input = el('input', {
        type: 'text', class: 'tag-rename', value: keepFocus != null ? keepFocus : tag.name,
        'aria-label': `New name for #${tag.name}`, maxlength: '40',
      });
      const save = () => {
        const next = store.normalizeTagName(input.value);
        if (!next) { toast('Tags need a letter, and can use numbers, - or _.'); input.focus(); return; }
        if (next !== tag.name) {
          const result = store.renameTag(tag.name, next);
          if (tagFilter === tag.name) tagFilter = next;
          try { if (tagFilter) localStorage.setItem(TAG_FILTER_KEY, tagFilter); } catch {}
          toast(result.merged ? `Merged #${tag.name} into #${next}` : `Renamed #${tag.name} to #${next}`);
        }
        renamingTag = '';
        render();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renamingTag = ''; renderTagManager(); }
      });
      head.append(
        input,
        el('button', { type: 'button', class: 'save', text: 'Save', onclick: save }),
        el('button', { type: 'button', text: 'Cancel', onclick: () => { renamingTag = ''; renderTagManager(); } }),
      );
    } else {
      head.append(
        el('span', { class: chipClass(tag.name, 'mini'), text: `#${tag.name}` }),
        el('span', { class: 'tag-meta', text: plural(tag.count, 'task') }),
        el('button', { type: 'button', text: 'Rename', onclick: () => { renamingTag = tag.name; renderTagManager(); } }),
        el('button', { type: 'button', class: 'danger-text', text: 'Delete', onclick: () => removeManagedTag(tag) }),
      );
    }
    const colors = el('div', { class: 'palette' });
    fillPalette(colors, tag.color || '', (id) => store.setTagColor(tag.name, id), `Colour for #${tag.name}`);
    return el('li', { class: 'tag-row' }, head, colors);
  }));
  if (renamingTag) {
    const input = list.querySelector('.tag-rename');
    if (input) { input.focus(); if (keepFocus == null) input.select(); }
  }
}
function hideTagUndo() {
  const bar = $('#tags-undo');
  if (bar) bar.hidden = true;
}
function undoManagedTag(undo) {
  if (!undo || pendingTagUndo !== undo) return;
  pendingTagUndo = null;
  store.undoDeleteTag(undo);
  hideTagUndo();
  hideToast();
}
function removeManagedTag(tag) {
  const msg = tag.count
    ? `Delete #${tag.name}? It will be removed from ${plural(tag.count, 'task')}. The tasks stay.`
    : `Delete #${tag.name}?`;
  if (!window.confirm(msg)) return;
  const undo = store.deleteTag(tag.name);
  if (!undo) return;
  if (tagFilter === tag.name) {
    tagFilter = '';
    try { localStorage.removeItem(TAG_FILTER_KEY); } catch {}
  }
  pendingTagUndo = undo;
  const bar = $('#tags-undo');
  $('#tags-undo-msg').textContent = `Deleted #${tag.name}`;
  bar.hidden = false;
  toast(`Deleted #${tag.name}`, 'Undo', () => undoManagedTag(undo));
}
function openTags() {
  renamingTag = '';
  newTagColor = '';
  paintNewPalette();
  renderTagManager();
  const dlg = $('#tags-dialog');
  showDialog(dlg);
  const input = $('#new-tag-name');
  if (input) input.focus();
}
function closeTags() {
  renamingTag = '';
  const dlg = $('#tags-dialog');
  if (dlg.open) dlg.close();
}
function setupTags() {
  $('#tags-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#new-tag-name');
    const name = store.normalizeTagName(input.value);
    if (!name) {
      toast('Tags need a letter, and can use numbers, - or _.');
      input.focus();
      return;
    }
    const existed = store.getTagCatalog().some((t) => t.name === name);
    const color = newTagColor;
    store.addTag(name, color);
    input.value = '';
    newTagColor = '';
    paintNewPalette();
    if (existed && !color) toast(`#${name} is already there`);
    else if (existed) toast(`Updated the colour of #${name}`);
    input.focus();
  });
  $('#tags-close').addEventListener('click', () => closeTags());
  $('#tags-undo-btn').addEventListener('click', () => undoManagedTag(pendingTagUndo));
  $('#manage-tags').addEventListener('click', () => openTags());
  const dlg = $('#tags-dialog');
  bindEditorViewport(dlg, { scrollFocused: false });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeTags(); });
  bindBackdropDismiss(dlg, () => closeTags());
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const nodes = [...dlg.querySelectorAll('button, input')].filter((n) => !n.disabled && n.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

/* ---------- actions ---------- */
function startEdit(id, focus) {
  if ($('#editor').open) return;
  editing = { id, focus };
  render();
}

function restore(id) {
  const task = store.getTasks().find((t) => t.id === id);
  if (!task || !task.done) return;
  newIds = new Set([id]);
  store.updateTask(id, { done: false });
  toast('Moved back to your list', '', null, 2800);
}

function toggle(id, checked, li) {
  if (pending.has(id)) return;
  if (!checked) { restore(id); return; }
  pending.add(id);
  if (li) li.classList.add('completing');
  setTimeout(() => {
    pending.delete(id);
    const task = store.getTasks().find((t) => t.id === id);
    if (!task || task.done) return;
    store.updateTask(id, { done: true });
    toast('Task completed', 'Undo', () => restore(id), 6000);
  }, 650);
}

function remove(id, li) {
  if (pending.has(id)) return;
  pending.add(id);
  const go = () => {
    pending.delete(id);
    const removed = store.removeTasks([id]);
    toast('Task deleted', 'Undo', () => store.restoreTasks(removed));
  };
  if (li) { li.classList.add('removing'); setTimeout(go, 330); } else go();
}

function submit() {
  const text = dumpEl.value.trim();
  if (!text) { dumpEl.focus(); toast('Type or paste something first.'); return; }
  let items = [];
  try { items = parseTasks(text, new Date()); } catch (e) { console.error(e); }
  items = (items || []).filter((i) => i && i.title && i.title.trim());
  if (tagFilter) items = items.map((it) => ({ ...it, tags: [...(it.tags || []), tagFilter] }));
  if (!items.length) { toast('Couldn’t find any tasks in that.'); return; }
  const created = store.addTasks(items);
  newIds = new Set(created.map((t) => t.id));
  const draft = dumpEl.value;
  dumpEl.value = ''; store.setDraft(''); updateCount();
  render();
  const withDate = created.filter((t) => t.due).length;
  const ids = created.map((t) => t.id);
  toast(`Added ${plural(created.length, 'task')}${withDate ? ` · ${withDate} dated` : ''}`, 'Undo', () => {
    store.removeTasks(ids); dumpEl.value = draft; store.setDraft(draft); updateCount(); dumpEl.focus();
  }, 8000);
  const first = listsEl.querySelector('.task.new');
  if (first && !window.matchMedia('(min-width: 40rem)').matches) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function updateCount() {
  const v = dumpEl.value.trim();
  $('#dump-count').textContent = v ? `${v.split(/\n+/).filter(Boolean).length} line(s) ready · ${isMac ? '⌘' : 'Ctrl'}+Enter to add` : 'Separate tasks with a full stop.';
}

/* ---------- swipe (touch/pen only) ---------- */
function attachSwipe(li, body, t) {
  let sx = 0, sy = 0, dx = 0, id = null, locked = false, swallow = false;
  const THRESH = 90;
  body.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.button > 0 || editing || editor) return;
    id = e.pointerId; sx = e.clientX; sy = e.clientY; dx = 0; locked = false;
  });
  body.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!locked) {
      if (Math.abs(my) > 12 && Math.abs(my) > Math.abs(mx)) { id = null; return; }
      if (Math.abs(mx) < 12) return;
      locked = true; li.classList.add('dragging');
      try { body.setPointerCapture(id); } catch {}
    }
    dx = mx;
    body.style.transform = `translateX(${dx}px)`;
    li.classList.toggle('swipe-right', dx > 0);
    li.classList.toggle('swipe-left', dx < 0);
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    if (!locked) return;
    swallow = true; setTimeout(() => (swallow = false), 50);
    li.classList.remove('dragging');
    const final = dx; dx = 0; locked = false;
    if (Math.abs(final) >= THRESH && e.type === 'pointerup') {
      body.style.transform = `translateX(${final > 0 ? 110 : -110}%)`;
      setTimeout(() => {
        body.style.transform = '';
        li.classList.remove('swipe-right', 'swipe-left');
        if (final > 0) {
          if (t.done) restore(t.id);
          else { const cb = li.querySelector('input'); cb.checked = true; toggle(t.id, true, li); }
        } else remove(t.id, li);
      }, 180);
    } else {
      body.style.transform = '';
      li.classList.remove('swipe-right', 'swipe-left');
    }
  };
  body.addEventListener('pointerup', end);
  body.addEventListener('pointercancel', end);
  body.addEventListener('click', (e) => { if (swallow) { e.stopPropagation(); e.preventDefault(); } }, true);
}

/* ---------- wiring ---------- */
formEl.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
dumpEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
});
dumpEl.addEventListener('input', () => { store.setDraft(dumpEl.value); updateCount(); });
$('#example').addEventListener('click', () => {
  dumpEl.value = 'Buy milk tomorrow. Call mum Friday. Dentist at 3pm next Tuesday. Pay rent on the 1st.';
  store.setDraft(dumpEl.value); updateCount(); dumpEl.focus();
});

function tagFromSearch(raw) {
  const hash = /^#([a-z0-9_-]+)$/i.exec(raw);
  return hash ? store.normalizeTagName(hash[1]) : '';
}
searchEl.addEventListener('input', () => {
  const raw = searchEl.value.trim();
  const asTag = tagFromSearch(raw);
  if (asTag && store.getTagCatalog().some((t) => t.name === asTag)) {
    query = '';
    searchEl.value = '';
    setTagFilter(asTag);
    return;
  }
  query = raw;
  if (query) completedEl.open = true;
  render();
});
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const asTag = tagFromSearch(searchEl.value.trim());
    if (asTag) {
      e.preventDefault();
      query = '';
      searchEl.value = '';
      setTagFilter(asTag);
      return;
    }
  }
  if (e.key === 'Escape') { searchEl.value = ''; query = ''; render(); searchEl.blur(); }
});

$('#clear-completed').addEventListener('click', () => {
  const removed = store.clearCompleted();
  if (removed.length) toast(`Cleared ${plural(removed.length, 'completed task')}`, 'Undo', () => store.restoreTasks(removed));
});

$('#export').addEventListener('click', () => {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `braindump-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Backup downloaded');
});
const fileEl = $('#import-file');
$('#import').addEventListener('click', () => fileEl.click());
fileEl.addEventListener('change', async () => {
  const f = fileEl.files[0]; fileEl.value = '';
  if (!f) return;
  const before = store.snapshot();
  const beforeTags = store.getTagRegistry();
  try {
    const { added, merged } = store.importJSON(await f.text());
    const n = added + merged;
    let msg = 'Nothing new to import';
    if (added && merged) msg = `Imported ${plural(added, 'task')} and updated ${plural(merged, 'note')}`;
    else if (merged) msg = `Updated ${plural(merged, 'note')}`;
    else if (added) msg = `Imported ${plural(added, 'task')}`;
    toast(msg, n ? 'Undo' : '', n ? () => { store.replaceAll(before); store.replaceTagRegistry(beforeTags); } : null);
  } catch (err) { toast(err.message); }
});

document.addEventListener('keydown', (e) => {
  if (menuOpen() && e.key === 'Escape') { e.preventDefault(); closeMenu(true); return; }
  if ($('#editor').open) return;
  if ($('#tags-dialog') && $('#tags-dialog').open) return;
  const installDialog = $('#install-dialog');
  if (installDialog && installDialog.open) return;
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
  if (e.key === 'Escape' && !typing) { hideToast(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); searchEl.focus(); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); dumpEl.focus(); }
  else if ((e.key === 'z' || e.key === 'u') && !toastBtn.hidden && !toastEl.hidden) { toastBtn.click(); }
});

store.subscribe(render);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !editing && !editor && !tagsOpen()) render();
});
setInterval(() => {
  if (!document.hidden && !editing && !editor && !tagsOpen() && !pending.size) render();
}, 60000);

setupEditor();
setupMenu();
setupTags();
readTagFilter();
store.load();
dumpEl.value = store.getDraft();
updateCount();
render();
setupSync();

/* ---------- automatic sync (local list always works without it) ---------- */
function setupSync() {
  const PREF = 'braindump-todo:sync-enabled';
  const label = $('#account-label');
  const dot = $('#sync-dot');
  const live = $('#sync-live');
  const toggle = $('#sync-enabled');
  let client = null;
  let engine = null;
  let generation = 0;
  let retry = 0;
  let retryTimer = null;

  const labels = {
    off: 'Sync off',
    synced: 'Synced',
    syncing: 'Syncing',
    offline: 'Offline',
    error: 'Sync problem',
  };
  const liveText = {
    off: 'Sync is off on this device. Tasks stay here.',
    synced: 'Synced',
    syncing: 'Syncing',
    offline: 'Offline. Tasks stay on this device.',
    error: 'Sync problem. Tasks stay on this device and will retry.',
  };

  function syncWanted() { return localStorage.getItem(PREF) !== 'off'; }
  function onStatus(state) {
    label.textContent = labels[state] || labels.off;
    const detail = $('#menu-sync-detail');
    if (detail) detail.textContent = liveText[state] || '';
    dot.dataset.state = state;
    live.textContent = liveText[state] || '';
  }
  function later(fn, ms) {
    const timer = setTimeout(fn, ms);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function stop() {
    generation++;
    clearTimeout(retryTimer);
    if (engine) engine.stopSession();
    else onStatus('off');
    if (client) client.auth.signOut({ scope: 'local' }).catch(() => {});
  }

  async function start() {
    const gen = ++generation;
    clearTimeout(retryTimer);
    if (!syncWanted()) { stop(); return; }
    onStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'syncing');
    try {
      if (!client) client = await loadSupabaseClient();
      if (gen !== generation || !syncWanted()) return;
      if (!engine) engine = createSync(store, client, { onStatus });
      const session = await ensureOwnerSession(client);
      if (gen !== generation || !syncWanted()) {
        client.auth.signOut({ scope: 'local' }).catch(() => {});
        return;
      }
      retry = 0;
      await engine.useSession(session);
      if (gen !== generation || !syncWanted()) {
        engine.stopSession();
        client.auth.signOut({ scope: 'local' }).catch(() => {});
      }
    } catch (err) {
      if (gen !== generation || !syncWanted()) return;
      console.warn('Sync failed', err && err.message ? err.message : err);
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      onStatus(offline ? 'offline' : 'error');
      const delay = Math.min(30000, 1000 * 2 ** retry);
      retry++;
      retryTimer = later(() => { if (syncWanted()) start(); }, delay);
    }
  }

  toggle.checked = syncWanted();
  toggle.addEventListener('change', () => {
    localStorage.setItem(PREF, toggle.checked ? 'on' : 'off');
    if (toggle.checked) start();
    else stop();
  });
  window.addEventListener('online', () => { if (syncWanted()) start(); });

  if (syncWanted()) start();
  else onStatus('off');
}
