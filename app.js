import { parseTasks, bucketFor } from './parser.js';
import * as store from './store.js';

const $ = (s) => document.querySelector(s);
const dumpEl = $('#dump'), formEl = $('#dump-form'), listsEl = $('#lists');
const searchEl = $('#search'), completedEl = $('#completed'), completedList = $('#completed-list');
const emptyEl = $('#empty');

const GROUPS = [
  ['overdue', 'Overdue'], ['today', 'Today'], ['tomorrow', 'Tomorrow'],
  ['this-week', 'This week'], ['next-week', 'Next week'], ['later', 'Later'], ['no-date', 'No date'],
];

let query = '';
let editing = null;          // { id, focus: 'title'|'date' }
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
function matches(t) {
  if (!query) return true;
  const q = query.toLowerCase();
  return t.title.toLowerCase().includes(q) || (t.due && (t.due.includes(q) || fmtWhen(t).toLowerCase().includes(q)));
}

function render() {
  const all = store.getTasks();
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
  if (editing) {
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
      el('button', { type: 'button', class: 'title', 'aria-label': `Edit task: ${t.title}`, onclick: () => startEdit(t.id, 'title') },
        el('span', { class: 'title-text', text: t.title })),
      when),
    el('button', { type: 'button', class: 'del', 'aria-label': `Delete: ${t.title}`, title: 'Delete', text: '✕', onclick: () => remove(t.id, li) }));
  const li = el('li', { class: cls.join(' '), 'data-id': t.id },
    el('div', { class: 'swipe-bg', 'aria-hidden': 'true' }, el('span', { class: 'l', text: t.done ? '↺ Undo done' : '✓ Done' }), el('span', { class: 'r', text: 'Delete 🗑' })),
    body);
  attachSwipe(li, body, t);
  return li;
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

/* ---------- actions ---------- */
function startEdit(id, focus) { editing = { id, focus }; render(); }

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
    if (e.pointerType === 'mouse' || e.button > 0 || editing) return;
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
    const n = store.importJSON(await f.text());
    toast(n ? `Imported ${plural(n, 'task')}` : 'Nothing new to import', n ? 'Undo' : '', n ? () => store.replaceAll(before) : null);
  } catch (err) { toast(err.message); }
});

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
  if (e.key === 'Escape' && !typing) { hideToast(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); searchEl.focus(); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); dumpEl.focus(); }
  else if ((e.key === 'z' || e.key === 'u') && !toastBtn.hidden && !toastEl.hidden) { toastBtn.click(); }
});

store.subscribe(render);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !editing) render(); });
setInterval(() => { if (!document.hidden && !editing && !pending.size) render(); }, 60000);

store.load();
dumpEl.value = store.getDraft();
updateCount();
render();
