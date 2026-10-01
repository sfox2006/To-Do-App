// store.js — localStorage persistence with a versioned schema.
// The storage key stays braindump-todo:v1 so existing browsers keep their data.
// Shape on disk: { version: 3, tasks: [{id,title,due,time,note,done,createdAt,doneAt}] }
// v0 was a bare array, v1/v2 were the same tasks without `note`. Missing notes become ''.

export const SCHEMA_VERSION = 3;
const KEY = 'braindump-todo:v1';
const DRAFT_KEY = 'braindump-todo:draft';
const NOTE_MAX = 4000;

let state = { version: SCHEMA_VERSION, tasks: [] };
const listeners = new Set();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** Optional multi-line note. Absent, non-strings, and blank notes become ''. */
function normalizeNote(value) {
  if (typeof value !== 'string') return '';
  const note = value.replace(/\r\n?/g, '\n').trim();
  if (!note) return '';
  return note.length > NOTE_MAX ? note.slice(0, NOTE_MAX).trim() : note;
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
    title, due, time,
    note: normalizeNote(t.note ?? t.notes),
    done, createdAt,
    doneAt: done ? (Number.isFinite(t.doneAt) ? t.doneAt : createdAt) : null,
  };
}

/** Migrate any stored/imported payload to the current schema. */
export function migrate(raw) {
  let tasks;
  if (Array.isArray(raw)) tasks = raw;            // v0: bare array
  else if (raw && Array.isArray(raw.tasks)) tasks = raw.tasks; // v1/v2/v3
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
    if (s) {
      const parsed = JSON.parse(s);
      const next = migrate(parsed);
      if (next) {
        state = next;
        const prevVersion = parsed && !Array.isArray(parsed) ? parsed.version : 0;
        if (prevVersion !== SCHEMA_VERSION) persist();
      }
    }
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
  const back = (Array.isArray(tasks) ? tasks : []).map(normalizeTask).filter(Boolean).filter((t) => !have.has(t.id));
  if (back.length) { state.tasks = [...state.tasks, ...back]; commit(); }
}

export function clearCompleted() { return removeTasks(state.tasks.filter((t) => t.done).map((t) => t.id)); }

export function snapshot() { return JSON.parse(JSON.stringify(state.tasks)); }
export function replaceAll(tasks) { state.tasks = tasks.map(normalizeTask).filter(Boolean); commit(); }

export function exportJSON() {
  return JSON.stringify({ app: 'braindump-todo', version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), tasks: state.tasks }, null, 2);
}

/**
 * Merge a backup into current tasks by id. Notes travel with each task.
 * A new id is added whole. An existing id keeps the local task; if it has no
 * note and the backup does, the note is filled in (local notes are never overwritten).
 * Returns { added, merged }. Throws on invalid data.
 */
export function importJSON(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  const data = migrate(raw);
  if (!data) throw new Error('That file does not look like a backup.');
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  let next = state.tasks.slice();
  let added = 0;
  let merged = 0;
  for (const t of data.tasks) {
    const cur = byId.get(t.id);
    if (!cur) {
      next.push(t);
      byId.set(t.id, t);
      added++;
    } else if (t.note && !cur.note) {
      const updated = normalizeTask({ ...cur, note: t.note }) || cur;
      next = next.map((x) => (x.id === cur.id ? updated : x));
      byId.set(cur.id, updated);
      merged++;
    }
  }
  if (added || merged) { state.tasks = next; commit(); }
  return { added, merged };
}

export function getDraft() { try { return localStorage.getItem(DRAFT_KEY) || ''; } catch { return ''; } }
export function setDraft(v) { try { v ? localStorage.setItem(DRAFT_KEY, v) : localStorage.removeItem(DRAFT_KEY); } catch {} }

// Keep multiple tabs in sync.
window.addEventListener('storage', (e) => {
  if (e.key === KEY) { load(); emit(); }
});
