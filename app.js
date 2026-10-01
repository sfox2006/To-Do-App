import { parseTasks, bucketFor } from './parser.js';
import * as store from './store.js';
import { createSync, loadSupabaseClient, deriveCredentials, explainAuthError } from './sync.js';

const $ = (s) => document.querySelector(s);
const dumpEl = $('#dump'), formEl = $('#dump-form'), listsEl = $('#lists');
const searchEl = $('#search'), completedEl = $('#completed'), completedList = $('#completed-list');
const emptyEl = $('#empty');

const GROUPS = [
  ['overdue', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'],
  ['this-week', 'This week'], ['next-week', 'Next week'], ['later', 'Later'], ['no-date', 'No date'],
];

let query = '';
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
  if (!query) return true;
  const q = query.toLowerCase();
  const note = (t.note || '').toLowerCase();
  return t.title.toLowerCase().includes(q)
    || (note && (note.includes(q) || note.replace(/\s+/g, ' ').includes(q)))
    || (t.due && (t.due.includes(q) || fmtWhen(t).toLowerCase().includes(q)));
}

function render() {
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
  completedEl.hidden = !done.length && !all.some((t) => t.done);
  $('#completed-count').textContent = String(all.filter((t) => t.done).length);
  $('#clear-completed').hidden = !all.some((t) => t.done);

  const openAll = all.filter((t) => !t.done).length;
  if (!visible.length) {
    emptyEl.hidden = false;
    emptyEl.textContent = query ? `No tasks match “${query}”.` : 'Nothing to do yet. Dump your thoughts above ☝️';
  } else if (!open.length && !query) {
    emptyEl.hidden = false; emptyEl.textContent = openAll ? '' : 'All clear! 🎉 Nothing left to do.';
  } else emptyEl.hidden = true;
  $('#search-status').textContent = query ? `${plural(visible.length, 'task')} found` : '';

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
      when,
      notePreview(t)),
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
  render();
  const dlg = $('#editor');
  if (!dlg.open) dlg.showModal();
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
  editor = null;
  const dlg = $('#editor');
  if (dlg.open) dlg.close();
  store.updateTask(id, { title, due, time, note });
  const back = document.querySelector(`[data-id="${CSS.escape(id)}"] .title`);
  if (back) back.focus();
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
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeEditor(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeEditor(); });
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

/* ---------- actions ---------- */
function startEdit(id, focus) {
  if ($('#editor').open) return;
  editing = { id, focus };
  render();
}

function toggle(id, checked, li) {
  if (pending.has(id)) return;
  if (!checked) return store.updateTask(id, { done: false });
  pending.add(id);
  li.classList.add('completing');
  setTimeout(() => { pending.delete(id); store.updateTask(id, { done: true }); }, 650);
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
  $('#dump-count').textContent = v ? `${v.split(/\n+/).filter(Boolean).length} line(s) ready · ${isMac ? '⌘' : 'Ctrl'}+Enter to add` : 'Separate tasks with commas, new lines or “and then”.';
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
          if (t.done) store.updateTask(t.id, { done: false });
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
  dumpEl.value = 'buy milk tomorrow, call mum Friday, dentist at 3pm next Tuesday\npay rent on the 1st\nbook flights, water the plants today';
  store.setDraft(dumpEl.value); updateCount(); dumpEl.focus();
});

searchEl.addEventListener('input', () => {
  query = searchEl.value.trim();
  if (query) completedEl.open = true;
  render();
});
searchEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchEl.value = ''; query = ''; render(); searchEl.blur(); } });

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
  try {
    const { added, merged } = store.importJSON(await f.text());
    const n = added + merged;
    let msg = 'Nothing new to import';
    if (added && merged) msg = `Imported ${plural(added, 'task')} and updated ${plural(merged, 'note')}`;
    else if (merged) msg = `Updated ${plural(merged, 'note')}`;
    else if (added) msg = `Imported ${plural(added, 'task')}`;
    toast(msg, n ? 'Undo' : '', n ? () => store.replaceAll(before) : null);
  } catch (err) { toast(err.message); }
});

document.addEventListener('keydown', (e) => {
  if ($('#editor').open || $('#sync-dialog').open) return;
  if (!$('#account-menu').hidden && e.key === 'Escape') {
    $('#account-menu').hidden = true;
    $('#account-btn').setAttribute('aria-expanded', 'false');
    $('#account-btn').focus();
    return;
  }
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
  if (e.key === 'Escape' && !typing) { hideToast(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); searchEl.focus(); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); dumpEl.focus(); }
  else if ((e.key === 'z' || e.key === 'u') && !toastBtn.hidden && !toastEl.hidden) { toastBtn.click(); }
});

store.subscribe(render);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !editing && !editor) render(); });
setInterval(() => { if (!document.hidden && !editing && !editor && !pending.size) render(); }, 60000);

setupEditor();
store.load();
dumpEl.value = store.getDraft();
updateCount();
render();
setupSync();

/* ---------- optional sync (local list always works without it) ---------- */
function setupSync() {
  const btn = $('#account-btn');
  const label = $('#account-label');
  const dot = $('#sync-dot');
  const menu = $('#account-menu');
  const menuStatus = $('#account-menu-status');
  const live = $('#sync-live');
  const dlg = $('#sync-dialog');
  const msg = $('#sync-msg');
  const phrase = $('#passphrase');
  const phrase2 = $('#passphrase2');
  let client = null;
  let engine = null;
  let signedIn = false;
  let busy = false;

  const labels = {
    off: 'Sync',
    synced: 'Synced',
    syncing: 'Syncing',
    offline: 'Offline',
    error: 'Sync problem',
  };
  const liveText = {
    off: '',
    synced: 'Synced',
    syncing: 'Syncing',
    offline: 'Offline. Tasks stay on this device.',
    error: 'Sync problem. Tasks stay on this device and will retry.',
  };

  function closeMenu() {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
  function showMsg(text, info) {
    msg.hidden = !text;
    msg.textContent = text || '';
    msg.classList.toggle('info', !!info);
  }
  function closeDialog() {
    phrase.value = '';
    phrase2.value = '';
    showMsg('');
    if (dlg.open) dlg.close();
    btn.focus();
  }
  function onStatus(state) {
    signedIn = state !== 'off';
    label.textContent = labels[state] || labels.off;
    dot.dataset.state = state;
    menuStatus.textContent = liveText[state] || labels[state] || '';
    live.textContent = liveText[state] || '';
    btn.setAttribute('aria-haspopup', signedIn ? 'menu' : 'dialog');
    btn.setAttribute('aria-controls', signedIn ? 'account-menu' : 'sync-dialog');
    if (!signedIn) closeMenu();
  }

  btn.addEventListener('click', () => {
    if (signedIn) {
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) $('#disconnect').focus();
      return;
    }
    closeMenu();
    if (!dlg.open) dlg.showModal();
    if (!client) showMsg('Sync needs a connection the first time on this device. Your tasks still work offline.', true);
    phrase.focus();
  });
  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (!btn.contains(e.target) && !menu.contains(e.target)) closeMenu();
  });
  $('#disconnect').addEventListener('click', async () => {
    closeMenu();
    try { if (client) await client.auth.signOut({ scope: 'local' }); }
    catch (err) { console.warn(err); }
    if (engine) engine.stopSession();
    else onStatus('off');
  });

  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(); });
  $('#sync-cancel').addEventListener('click', () => closeDialog());
  $('#sync-form').addEventListener('submit', (e) => e.preventDefault());
  $('#show-passphrase').addEventListener('change', (e) => {
    const type = e.target.checked ? 'text' : 'password';
    phrase.type = type;
    phrase2.type = type;
  });

  function setBusy(on) {
    busy = on;
    $('#sync-create').disabled = on;
    $('#sync-connect').disabled = on;
  }
  async function run(intent) {
    if (busy) return;
    if (!client || !engine) {
      showMsg('Sync needs a connection the first time on this device. Your tasks still work offline.', true);
      return;
    }
    const value = phrase.value;
    if (value.length < 12) { showMsg('Use at least 12 characters. Four or more random words is best.'); return; }
    if (intent === 'signup' && value !== phrase2.value) { showMsg('The two passphrases do not match.'); return; }
    setBusy(true);
    showMsg('Setting up sync…', true);
    try {
      const creds = await deriveCredentials(value);
      const auth = intent === 'signup'
        ? await client.auth.signUp({ email: creds.email, password: creds.password })
        : await client.auth.signInWithPassword({ email: creds.email, password: creds.password });
      const session = auth.data && auth.data.session;
      if (auth.error || !session) {
        showMsg(explainAuthError(auth.error, { intent, session }));
        return;
      }
      closeDialog();
      await engine.useSession(session);
    } catch (err) {
      showMsg(err && err.code === 'short' ? err.message : explainAuthError(err, { intent }));
    } finally {
      setBusy(false);
    }
  }
  $('#sync-create').addEventListener('click', () => run('signup'));
  $('#sync-connect').addEventListener('click', () => run('signin'));

  onStatus('off');
  loadSupabaseClient().then(async (supabase) => {
    client = supabase;
    engine = createSync(store, client, { onStatus });
    try {
      const { data, error } = await client.auth.getSession();
      if (!error && data.session) await engine.useSession(data.session);
    } catch (err) {
      console.warn(err);
    }
  }).catch((err) => {
    console.warn('Sync library unavailable', err && err.message ? err.message : err);
  });
}
