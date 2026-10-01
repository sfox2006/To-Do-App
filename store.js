// store.js — localStorage persistence with a versioned schema.
// Shape on disk: { version: 2, tasks: [{id,title,due,time,done,createdAt,doneAt}] }

export const SCHEMA_VERSION = 2;
const KEY = 'braindump-todo:v1';
const DRAFT_KEY = 'braindump-todo:draft';

let state = { version: SCHEMA_VERSION, tasks: [] };
const listeners = new Set();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** Coerce any object into a valid task, or null if unusable. */
function normalizeTask(t) {
  if (!t || typeof t !== 'object') return null;
  const title = String(t.title ?? t.text ?? '').trim();
  if (!title) return null;
  const due = typeof t.due === 'string' && ISO_DATE.test(t.due) ? t.due : null;
  const time = due && typeof t.time === 'string' && HHMM.test(t.time) ? t.time : null;
  const done = !!t.done;
  const createdAt = Number.isFinite(t.createdAt) ? t.createdAt : Date.now();
  return {
    id: typeof t.id === 'string' && t.id ? t.id : uid(),
    title, due, time, done, createdAt,
    doneAt: done ? (Number.isFinite(t.doneAt) ? t.doneAt : createdAt) : null,
  };
}

/** Migrate any stored/imported payload to the current schema. */
export function migrate(raw) {
  let tasks;
  if (Array.isArray(raw)) tasks = raw;            // v0: bare array
  else if (raw && Array.isArray(raw.tasks)) tasks = raw.tasks; // v1/v2
  else return null;
  return { version: SCHEMA_VERSION, tasks: tasks.map(normalizeTask).filter(Boolean) };
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { console.warn('Could not save', e); }
}
function emit() { listeners.forEach((fn) => fn(state.tasks)); }
function commit() { persist(); emit(); }

export function load() {
  try {
    const s = localStorage.getItem(KEY);
    if (s) state = migrate(JSON.parse(s)) || state;
  } catch (e) { console.warn('Corrupt data, starting fresh', e); }
  return state.tasks;
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getTasks() { return state.tasks; }

/** Add parsed tasks [{title,due,time}]; returns the created tasks. */
export function addTasks(items) {
  const now = Date.now();
  const created = items
    .map((it, i) => normalizeTask({ ...it, id: uid(), done: false, createdAt: now + i }))
    .filter(Boolean);
  if (created.length) { state.tasks = [...state.tasks, ...created]; commit(); }
  return created;
}

export function updateTask(id, patch) {
  state.tasks = state.tasks.map((t) => {
    if (t.id !== id) return t;
    const merged = { ...t, ...patch };
    if ('done' in patch) merged.doneAt = patch.done ? Date.now() : null;
    return normalizeTask(merged) || t;
  });
  commit();
}

export function removeTasks(ids) {
  const set = new Set(ids);
  const removed = state.tasks.filter((t) => set.has(t.id));
  state.tasks = state.tasks.filter((t) => !set.has(t.id));
  if (removed.length) commit();
  return removed;
}

/** Re-insert previously removed tasks (undo). */
export function restoreTasks(tasks) {
  const have = new Set(state.tasks.map((t) => t.id));
  const back = tasks.filter((t) => !have.has(t.id));
  if (back.length) { state.tasks = [...state.tasks, ...back]; commit(); }
}

export function clearCompleted() { return removeTasks(state.tasks.filter((t) => t.done).map((t) => t.id)); }

export function snapshot() { return JSON.parse(JSON.stringify(state.tasks)); }
export function replaceAll(tasks) { state.tasks = tasks.map(normalizeTask).filter(Boolean); commit(); }

export function exportJSON() {
  return JSON.stringify({ app: 'braindump-todo', version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), tasks: state.tasks }, null, 2);
}

/** Merge a backup into current tasks (by id). Returns number added. Throws on invalid data. */
export function importJSON(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  const data = migrate(raw);
  if (!data) throw new Error('That file does not look like a backup.');
  const have = new Set(state.tasks.map((t) => t.id));
  const fresh = data.tasks.filter((t) => !have.has(t.id));
  if (fresh.length) { state.tasks = [...state.tasks, ...fresh]; commit(); }
  return fresh.length;
}

export function getDraft() { try { return localStorage.getItem(DRAFT_KEY) || ''; } catch { return ''; } }
export function setDraft(v) { try { v ? localStorage.setItem(DRAFT_KEY, v) : localStorage.removeItem(DRAFT_KEY); } catch {} }

// Keep multiple tabs in sync.
window.addEventListener('storage', (e) => {
  if (e.key === KEY) { load(); emit(); }
});
