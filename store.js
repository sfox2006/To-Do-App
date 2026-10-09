// store.js — localStorage persistence with a versioned schema.
// The storage key stays braindump-todo:v1 so existing browsers keep their data.
// Shape on disk: { version: 4, tasks: [{id,title,due,time,note,tags,done,createdAt,doneAt,updatedAt}], tombstones: [{id,updatedAt,task}], tags: {updatedAt, items, tombstones} }
// v0 was a bare array, v1/v2 had no note, v3 had notes but no updatedAt.
// Tombstones are local soft-deletes so sync can propagate them. They are not shown in the list.
// The tag registry (name, colour, timestamps, deleted tombstones) lives in the same
// object and syncs as a special tasks-table row id "__tags__" (see sync.js).

export const SCHEMA_VERSION = 4;
export const TAGS_ROW_ID = '__tags__';
export const TAG_COLORS = ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'];
const KEY = 'braindump-todo:v1';
const DRAFT_KEY = 'braindump-todo:draft';
const NOTE_MAX = 4000;
const TAG_MAX = 40;

let state = { version: SCHEMA_VERSION, tasks: [], tombstones: [], tags: emptyRegistry() };
let generation = 0;
const listeners = new Set();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function emptyRegistry() {
  return { updatedAt: 0, items: [], tombstones: [] };
}

/** Lowercase, no '#', letters/digits/-/_ only, at least one letter. Spaces become hyphens. */
export function normalizeTagName(value) {
  if (typeof value !== 'string') return '';
  let name = value.trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-');
  name = name.replace(/[^a-z0-9_-]+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (name.length > TAG_MAX) name = name.slice(0, TAG_MAX).replace(/-+$/g, '');
  if (!name || !/[a-z]/.test(name)) return '';
  return name;
}

export function normalizeTags(value) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[,\s]+/) : []);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const name = normalizeTagName(item);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 20) break;
  }
  return out;
}

function normalizeColor(value) {
  return TAG_COLORS.includes(value) ? value : '';
}

function normalizeTagItem(item) {
  if (!item || typeof item !== 'object') return null;
  const name = normalizeTagName(item.name);
  if (!name) return null;
  const updatedAt = finiteMs(item.updatedAt);
  const createdAt = finiteMs(item.createdAt) || updatedAt;
  return { name, color: normalizeColor(item.color), createdAt, updatedAt };
}

function normalizeTagTomb(item) {
  if (!item || typeof item !== 'object') return null;
  const name = normalizeTagName(item.name);
  if (!name) return null;
  const updatedAt = finiteMs(item.updatedAt);
  if (!updatedAt) return null;
  return { name, updatedAt };
}

/** Coerce a tag registry. A tombstone at least as new as the item hides that tag. */
export function normalizeTagRegistry(raw) {
  const byName = new Map();
  for (const item of (raw && (raw.items || raw.tags)) || []) {
    const next = normalizeTagItem(item);
    if (!next) continue;
    const prev = byName.get(next.name);
    if (!prev || next.updatedAt >= prev.updatedAt) byName.set(next.name, next);
  }
  const tombBy = new Map();
  for (const tomb of (raw && raw.tombstones) || []) {
    const next = normalizeTagTomb(tomb);
    if (!next) continue;
    const prev = tombBy.get(next.name);
    if (!prev || next.updatedAt >= prev.updatedAt) tombBy.set(next.name, next);
  }
  const items = [];
  for (const [name, item] of byName) {
    const tomb = tombBy.get(name);
    if (tomb && tomb.updatedAt >= item.updatedAt) continue;
    items.push(item);
  }
  const tombstones = [];
  for (const [name, tomb] of tombBy) {
    const item = byName.get(name);
    if (item && item.updatedAt > tomb.updatedAt) continue;
    tombstones.push(tomb);
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  tombstones.sort((a, b) => a.name.localeCompare(b.name));
  const updatedAt = Math.max(
    finiteMs(raw && raw.updatedAt),
    ...items.map((i) => i.updatedAt),
    ...tombstones.map((t) => t.updatedAt),
    0,
  );
  return { updatedAt, items, tombstones };
}

/**
 * Per-tag newest updatedAt wins. On a tie a live tag beats a tombstone, then the
 * first argument (local) wins. The registry updatedAt is the newest stamp inside.
 */
export function mergeTagRegistries(localRaw, remoteRaw) {
  const local = normalizeTagRegistry(localRaw);
  const remote = normalizeTagRegistry(remoteRaw);
  const localItems = new Map(local.items.map((i) => [i.name, i]));
  const remoteItems = new Map(remote.items.map((i) => [i.name, i]));
  const localTombs = new Map(local.tombstones.map((t) => [t.name, t]));
  const remoteTombs = new Map(remote.tombstones.map((t) => [t.name, t]));
  const names = new Set([
    ...localItems.keys(), ...remoteItems.keys(), ...localTombs.keys(), ...remoteTombs.keys(),
  ]);
  const items = [];
  const tombstones = [];
  for (const name of names) {
    const candidates = [];
    const li = localItems.get(name);
    const ri = remoteItems.get(name);
    const lt = localTombs.get(name);
    const rt = remoteTombs.get(name);
    if (li) candidates.push({ kind: 'item', item: li, updatedAt: li.updatedAt, local: true });
    if (ri) candidates.push({ kind: 'item', item: ri, updatedAt: ri.updatedAt, local: false });
    if (lt) candidates.push({ kind: 'tomb', item: lt, updatedAt: lt.updatedAt, local: true });
    if (rt) candidates.push({ kind: 'tomb', item: rt, updatedAt: rt.updatedAt, local: false });
    candidates.sort((a, b) => {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      if (a.kind !== b.kind) return a.kind === 'item' ? -1 : 1;
      if (a.local !== b.local) return a.local ? -1 : 1;
      return 0;
    });
    const winner = candidates[0];
    if (!winner) continue;
    if (winner.kind === 'item') items.push(winner.item);
    else tombstones.push({ name, updatedAt: winner.updatedAt });
  }
  return normalizeTagRegistry({
    updatedAt: Math.max(local.updatedAt, remote.updatedAt, 0),
    items,
    tombstones,
  });
}

function newerStamp(now, prev) {
  return now > prev ? now : (prev || 0) + 1;
}

/** Make sure names used by tasks exist in the registry. Does not commit. */
function ensureRegistered(names, now = Date.now()) {
  const wanted = normalizeTags(names);
  if (!wanted.length) return;
  const items = new Map(state.tags.items.map((i) => [i.name, { ...i }]));
  const tombs = new Map(state.tags.tombstones.map((t) => [t.name, { ...t }]));
  let changed = false;
  for (const name of wanted) {
    if (items.has(name)) continue;
    const tomb = tombs.get(name);
    const ts = newerStamp(now, tomb ? tomb.updatedAt : 0);
    items.set(name, { name, color: '', createdAt: ts, updatedAt: ts });
    tombs.delete(name);
    changed = true;
  }
  if (!changed) return;
  state.tags = normalizeTagRegistry({
    updatedAt: Math.max(state.tags.updatedAt, now),
    items: [...items.values()],
    tombstones: [...tombs.values()],
  });
}

function absorbTaskTags(registry, tasks) {
  const known = new Set([
    ...registry.items.map((i) => i.name),
    ...registry.tombstones.map((t) => t.name),
  ]);
  const extra = [];
  for (const t of tasks) {
    for (const name of t.tags || []) {
      if (known.has(name)) continue;
      known.add(name);
      const ts = finiteMs(t.updatedAt) || finiteMs(t.createdAt);
      extra.push({ name, color: '', createdAt: ts, updatedAt: ts });
    }
  }
  if (!extra.length) return registry;
  return normalizeTagRegistry({
    updatedAt: registry.updatedAt,
    items: [...registry.items, ...extra],
    tombstones: registry.tombstones,
  });
}

/** Optional multi-line note. Absent, non-strings, and blank notes become ''. */
function normalizeNote(value) {
  if (typeof value !== 'string') return '';
  const note = value.replace(/\r\n?/g, '\n').trim();
  if (!note) return '';
  return note.length > NOTE_MAX ? note.slice(0, NOTE_MAX).trim() : note;
}

/** Coerce any object into a valid task, or null if unusable. The tags row is never a task. */
function normalizeTask(t) {
  if (!t || typeof t !== 'object') return null;
  if (t.id === TAGS_ROW_ID || t.kind === 'tags') return null;
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
    tags: normalizeTags(t.tags),
    done, createdAt,
    doneAt: done ? (Number.isFinite(t.doneAt) ? t.doneAt : createdAt) : null,
    updatedAt: pickUpdatedAt(t, createdAt),
  };
}

function normalizeTombstone(t) {
  if (!t || typeof t !== 'object') return null;
  const id = typeof t.id === 'string' && t.id ? t.id : (t.task && typeof t.task.id === 'string' ? t.task.id : '');
  if (!id) return null;
  const task = t.task ? normalizeTask({ ...t.task, id, updatedAt: pickUpdatedAt(t.task, t.updatedAt) }) : null;
  const updatedAt = finiteMs(t.updatedAt) || (task ? task.updatedAt : 0);
  return { id, updatedAt, task };
}

/** Migrate any stored/imported payload to the current schema. */
export function migrate(raw) {
  let tasks;
  let tombs = [];
  if (Array.isArray(raw)) tasks = raw;            // v0: bare array
  else if (raw && Array.isArray(raw.tasks)) {     // v1–v4
    tasks = raw.tasks;
    if (Array.isArray(raw.tombstones)) tombs = raw.tombstones;
  } else return null;
  const normalized = tasks.map(normalizeTask).filter(Boolean);
  const tags = absorbTaskTags(normalizeTagRegistry(raw && !Array.isArray(raw) ? raw.tags : null), normalized);
  return {
    version: SCHEMA_VERSION,
    tasks: normalized,
    tombstones: tombs.map(normalizeTombstone).filter(Boolean),
    tags,
  };
}

function finiteMs(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

/** Existing updatedAt wins. Older lists fall back to the later of createdAt and doneAt. */
function pickUpdatedAt(t, createdAt) {
  const explicit = finiteMs(t && t.updatedAt);
  if (explicit) return explicit;
  const doneAt = finiteMs(t && t.doneAt);
  return Math.max(finiteMs(createdAt), doneAt);
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { console.warn('Could not save', e); }
}
function emit() { listeners.forEach((fn) => fn(state.tasks)); }
function commit() { generation++; persist(); emit(); }

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
export function getTasks() { return state.tasks.filter((t) => t.id !== TAGS_ROW_ID); }
export function getGeneration() { return generation; }

export function getTagRegistry() {
  return {
    updatedAt: state.tags.updatedAt,
    items: state.tags.items.map((i) => ({ ...i })),
    tombstones: state.tags.tombstones.map((t) => ({ ...t })),
  };
}

/** Every known tag plus how many tasks use it. Unused tags (count 0) are included. */
export function getTagCatalog() {
  const counts = new Map();
  for (const t of state.tasks) {
    for (const name of t.tags || []) counts.set(name, (counts.get(name) || 0) + 1);
  }
  const byName = new Map(state.tags.items.map((i) => [i.name, i]));
  for (const name of counts.keys()) {
    if (!byName.has(name)) byName.set(name, { name, color: '', createdAt: 0, updatedAt: 0 });
  }
  return [...byName.values()]
    .map((item) => ({ ...item, count: counts.get(item.name) || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function addTag(name, color = '') {
  const tag = normalizeTagName(name);
  if (!tag) return null;
  const now = Date.now();
  const existing = state.tags.items.find((i) => i.name === tag);
  const c = normalizeColor(color);
  if (existing && (!c || existing.color === c)) return { ...existing };
  const items = state.tags.items.filter((i) => i.name !== tag);
  const tombs = state.tags.tombstones.filter((t) => t.name !== tag);
  const prevTomb = state.tags.tombstones.find((t) => t.name === tag);
  const ts = newerStamp(now, Math.max(existing ? existing.updatedAt : 0, prevTomb ? prevTomb.updatedAt : 0));
  const item = existing
    ? { ...existing, color: c || existing.color, updatedAt: ts }
    : { name: tag, color: c, createdAt: ts, updatedAt: ts };
  items.push(item);
  state.tags = normalizeTagRegistry({ updatedAt: ts, items, tombstones: tombs });
  commit();
  return { ...item };
}

export function setTagColor(name, color) {
  const tag = normalizeTagName(name);
  if (!tag) return null;
  const c = normalizeColor(color);
  const now = Date.now();
  const existing = state.tags.items.find((i) => i.name === tag);
  if (existing && existing.color === c) return { ...existing };
  const items = state.tags.items.filter((i) => i.name !== tag);
  const tombs = state.tags.tombstones.filter((t) => t.name !== tag);
  const prevTomb = state.tags.tombstones.find((t) => t.name === tag);
  const ts = newerStamp(now, Math.max(existing ? existing.updatedAt : 0, prevTomb ? prevTomb.updatedAt : 0));
  const item = {
    name: tag,
    color: c,
    createdAt: existing ? existing.createdAt : ts,
    updatedAt: ts,
  };
  items.push(item);
  state.tags = normalizeTagRegistry({ updatedAt: ts, items, tombstones: tombs });
  commit();
  return { ...item };
}

export function replaceTagRegistry(raw) {
  state.tags = normalizeTagRegistry(raw);
  commit();
}

/**
 * Rename a tag on every task. If the new name already exists, tasks are merged
 * onto it and the old name is tombstoned. updatedAt moves forward on each task.
 */
export function renameTag(from, to) {
  const oldName = normalizeTagName(from);
  const newName = normalizeTagName(to);
  if (!oldName || !newName) return { renamed: 0, merged: false, from: oldName, to: newName };
  if (oldName === newName) return { renamed: 0, merged: false, from: oldName, to: newName };
  const now = Date.now();
  let renamed = 0;
  state.tasks = state.tasks.map((t) => {
    if (!(t.tags || []).includes(oldName)) return t;
    renamed++;
    const tags = normalizeTags(t.tags.map((n) => (n === oldName ? newName : n)));
    return { ...t, tags, updatedAt: newerStamp(now, t.updatedAt) };
  });
  const items = new Map(state.tags.items.map((i) => [i.name, { ...i }]));
  const tombs = new Map(state.tags.tombstones.map((t) => [t.name, { ...t }]));
  const old = items.get(oldName);
  const existing = items.get(newName);
  const ts = newerStamp(now, Math.max(old ? old.updatedAt : 0, existing ? existing.updatedAt : 0, tombs.get(oldName) ? tombs.get(oldName).updatedAt : 0, tombs.get(newName) ? tombs.get(newName).updatedAt : 0));
  if (!existing) {
    items.set(newName, {
      name: newName,
      color: old ? old.color : '',
      createdAt: old ? old.createdAt : ts,
      updatedAt: ts,
    });
  }
  items.delete(oldName);
  tombs.set(oldName, { name: oldName, updatedAt: ts });
  tombs.delete(newName);
  state.tags = normalizeTagRegistry({ updatedAt: ts, items: [...items.values()], tombstones: [...tombs.values()] });
  commit();
  return { renamed, merged: !!existing, from: oldName, to: newName };
}

/**
 * Remove a tag from every task. Tasks themselves stay. Returns an undo payload.
 */
export function deleteTag(name) {
  const tag = normalizeTagName(name);
  if (!tag) return null;
  const item = state.tags.items.find((i) => i.name === tag) || null;
  const onTasks = state.tasks.some((t) => (t.tags || []).includes(tag));
  if (!item && !onTasks) return null;
  const now = Date.now();
  const tasks = [];
  state.tasks = state.tasks.map((t) => {
    if (!(t.tags || []).includes(tag)) return t;
    tasks.push({ id: t.id, tags: t.tags.slice() });
    return {
      ...t,
      tags: t.tags.filter((n) => n !== tag),
      updatedAt: newerStamp(now, t.updatedAt),
    };
  });
  const ts = newerStamp(now, item ? item.updatedAt : 0);
  const items = state.tags.items.filter((i) => i.name !== tag);
  const tombs = state.tags.tombstones.filter((t) => t.name !== tag);
  tombs.push({ name: tag, updatedAt: ts });
  state.tags = normalizeTagRegistry({ updatedAt: ts, items, tombstones: tombs });
  commit();
  return { name: tag, item: item ? { ...item } : null, tasks };
}

/** Put a deleted tag, and the task lists it was on, back. */
export function undoDeleteTag(undo) {
  if (!undo || !undo.name) return;
  const now = Date.now();
  const byId = new Map((undo.tasks || []).map((t) => [t.id, t.tags]));
  state.tasks = state.tasks.map((t) => {
    const prev = byId.get(t.id);
    if (!prev) return t;
    return { ...t, tags: normalizeTags(prev), updatedAt: newerStamp(now, t.updatedAt) };
  });
  const items = state.tags.items.filter((i) => i.name !== undo.name);
  const tombs = state.tags.tombstones.filter((t) => t.name !== undo.name);
  const prev = undo.item;
  const ts = newerStamp(now, Math.max(prev ? prev.updatedAt : 0, state.tags.updatedAt));
  items.push(prev
    ? { ...prev, name: undo.name, updatedAt: ts }
    : { name: undo.name, color: '', createdAt: ts, updatedAt: ts });
  state.tags = normalizeTagRegistry({ updatedAt: ts, items, tombstones: tombs });
  commit();
}

export function getSyncSnapshot() {
  return {
    tasks: state.tasks.map((t) => ({ ...t, tags: [...(t.tags || [])] })),
    tombstones: state.tombstones.map((t) => ({ id: t.id, updatedAt: t.updatedAt, task: t.task ? { ...t.task } : null })),
    tags: getTagRegistry(),
  };
}

/** Replace tasks and tombstones exactly, without bumping updatedAt. Used by sync. */
export function applySyncSnapshot({ tasks, tombstones, tags }) {
  state = {
    version: SCHEMA_VERSION,
    tasks: (tasks || []).map(normalizeTask).filter(Boolean),
    tombstones: (tombstones || []).map(normalizeTombstone).filter(Boolean),
    tags: tags === undefined ? state.tags : normalizeTagRegistry(tags),
  };
  commit();
}

/** Drop tombstones older than cutoff (ms). Local only; call after a successful push. */
export function purgeOldTombstones(cutoff) {
  const next = state.tombstones.filter((t) => t.updatedAt >= cutoff);
  if (next.length === state.tombstones.length) return;
  state = { ...state, tombstones: next };
  commit();
}

/** Add parsed tasks [{title,due,time}]; returns the created tasks. */
export function addTasks(items) {
  const now = Date.now();
  const created = items
    .map((it, i) => normalizeTask({ ...it, id: uid(), done: false, createdAt: now + i, updatedAt: now + i }))
    .filter(Boolean);
  if (created.length) {
    const ids = new Set(created.map((t) => t.id));
    state.tombstones = state.tombstones.filter((t) => !ids.has(t.id));
    state.tasks = [...state.tasks, ...created];
    ensureRegistered(created.flatMap((t) => t.tags), now);
    commit();
  }
  return created;
}

export function updateTask(id, patch) {
  let changed = false;
  state.tasks = state.tasks.map((t) => {
    if (t.id !== id) return t;
    changed = true;
    const now = Date.now();
    // Always newer than the previous save, so an un-complete wins newest-wins sync
    // even when it happens in the same millisecond as marking the task done.
    const updatedAt = now > t.updatedAt ? now : t.updatedAt + 1;
    const merged = { ...t, ...patch, updatedAt };
    if ('done' in patch) merged.doneAt = patch.done ? now : null;
    return normalizeTask(merged) || t;
  });
  if (changed) {
    if (patch && patch.tags) ensureRegistered(patch.tags);
    commit();
  }
}

export function removeTasks(ids) {
  const set = new Set(ids);
  const removed = state.tasks.filter((t) => set.has(t.id));
  if (!removed.length) return removed;
  const now = Date.now();
  const tombs = new Map(state.tombstones.map((t) => [t.id, t]));
  for (const t of removed) tombs.set(t.id, { id: t.id, updatedAt: now, task: { ...t, updatedAt: now } });
  state.tasks = state.tasks.filter((t) => !set.has(t.id));
  state.tombstones = [...tombs.values()];
  commit();
  return removed;
}

/** Re-insert previously removed tasks (undo). */
export function restoreTasks(tasks) {
  const now = Date.now();
  const have = new Set(state.tasks.map((t) => t.id));
  const back = (Array.isArray(tasks) ? tasks : [])
    .map((t) => normalizeTask({ ...t, updatedAt: now }))
    .filter(Boolean)
    .filter((t) => !have.has(t.id));
  if (!back.length) return;
  const ids = new Set(back.map((t) => t.id));
  state.tombstones = state.tombstones.filter((t) => !ids.has(t.id));
  state.tasks = [...state.tasks, ...back];
  ensureRegistered(back.flatMap((t) => t.tags), now);
  commit();
}

export function clearCompleted() { return removeTasks(state.tasks.filter((t) => t.done).map((t) => t.id)); }

export function snapshot() { return JSON.parse(JSON.stringify(state.tasks)); }
export function replaceAll(tasks) {
  const now = Date.now();
  const next = (tasks || []).map((t) => normalizeTask({ ...t, updatedAt: now })).filter(Boolean);
  const nextIds = new Set(next.map((t) => t.id));
  const tombs = new Map(state.tombstones.map((t) => [t.id, t]));
  for (const t of state.tasks) {
    if (!nextIds.has(t.id)) tombs.set(t.id, { id: t.id, updatedAt: now, task: { ...t, updatedAt: now } });
  }
  for (const id of nextIds) tombs.delete(id);
  state = { version: SCHEMA_VERSION, tasks: next, tombstones: [...tombs.values()], tags: state.tags };
  commit();
}

export function exportJSON() {
  return JSON.stringify({
    app: 'braindump-todo',
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    tasks: state.tasks,
    tags: getTagRegistry(),
  }, null, 2);
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
  const tombs = new Map(state.tombstones.map((t) => [t.id, t]));
  let added = 0;
  let merged = 0;
  const now = Date.now();
  for (const t of data.tasks) {
    const cur = byId.get(t.id);
    if (!cur) {
      const stamped = normalizeTask({ ...t, updatedAt: now + added });
      if (!stamped) continue;
      next.push(stamped);
      byId.set(t.id, stamped);
      tombs.delete(t.id);
      added++;
    } else if (t.note && !cur.note) {
      const updated = normalizeTask({ ...cur, note: t.note, updatedAt: now }) || cur;
      next = next.map((x) => (x.id === cur.id ? updated : x));
      byId.set(cur.id, updated);
      merged++;
    }
  }
  const beforeTags = JSON.stringify(state.tags);
  state.tasks = next;
  state.tombstones = [...tombs.values()];
  state.tags = mergeTagRegistries(state.tags, data.tags);
  ensureRegistered(state.tasks.flatMap((t) => t.tags), now);
  if (added || merged || JSON.stringify(state.tags) !== beforeTags) commit();
  return { added, merged };
}

export function getDraft() { try { return localStorage.getItem(DRAFT_KEY) || ''; } catch { return ''; } }
export function setDraft(v) { try { v ? localStorage.setItem(DRAFT_KEY, v) : localStorage.removeItem(DRAFT_KEY); } catch {} }

// Keep multiple tabs in sync.
window.addEventListener('storage', (e) => {
  if (e.key === KEY) { load(); emit(); }
});
