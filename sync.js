// Automatic cross-device sync for the single owner. The list stays local-first:
// a failure never clears tasks, and the app works with sync switched off.
import { migrate } from './store.js';

export const SUPABASE_URL = 'https://ymqknizwlyzmemsizdls.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_TgJumUd6xOE6GKRX9dkLzg_fPNd3KrH';
export const SUPABASE_MODULE = 'https://esm.sh/@supabase/supabase-js@2.49.4/es2022/supabase-js.bundle.mjs';
export const SYNC_EMAIL = 'todo-owner@todo-app.example.com';
export const SYNC_PASSWORD = 'braindump-todo-owner-7kQ4mN2p';
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function toMillis(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

export function isInvalidCredentials(error) {
  const msg = (error && error.message) || '';
  return /invalid login|invalid credentials|invalid email or password|user not found/i.test(msg);
}

export function isAlreadyRegistered(error) {
  const msg = (error && error.message) || '';
  return /already registered|already been registered|already exists|user already/i.test(msg);
}

/**
 * Use the built-in owner account. An existing session for that email is reused.
 * A missing account (sign-in says invalid credentials) is created once, then signed in.
 */
export async function ensureOwnerSession(client) {
  const creds = { email: SYNC_EMAIL, password: SYNC_PASSWORD };
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  const current = data && data.session;
  const email = current && current.user && current.user.email;
  if (current && email === SYNC_EMAIL) return current;
  if (current) await client.auth.signOut({ scope: 'local' });

  const signed = await client.auth.signInWithPassword(creds);
  if (signed.data && signed.data.session) return signed.data.session;
  if (signed.error && !isInvalidCredentials(signed.error)) throw signed.error;

  const created = await client.auth.signUp(creds);
  if (created.data && created.data.session) return created.data.session;
  if (created.error && !isAlreadyRegistered(created.error)) throw created.error;

  const again = await client.auth.signInWithPassword(creds);
  if (again.data && again.data.session) return again.data.session;
  throw again.error || created.error || signed.error || new Error('Could not start sync');
}

function coerceTask(id, updatedAt, data) {
  if (!data || typeof data !== 'object') return null;
  const migrated = migrate({ version: 4, tasks: [{ ...data, id, updatedAt }] });
  return migrated && migrated.tasks[0] ? migrated.tasks[0] : null;
}

function rowFrom(id, updatedAt, deleted, task) {
  const data = task ? { ...task, id, updatedAt } : { id, updatedAt };
  return { id, data, deleted: !!deleted, updated_at: new Date(updatedAt).toISOString() };
}

/**
 * Union by id. The newer updatedAt wins. On a tie, a live task beats a tombstone
 * so a task is not deleted when the clocks cannot say which side is newer.
 * Local-only and locally newer rows are returned in toPush.
 */
export function mergeSync(local, remoteRows, now = Date.now()) {
  const localMap = new Map();
  for (const t of (local && local.tasks) || []) {
    if (!t || typeof t.id !== 'string' || !t.id) continue;
    localMap.set(t.id, { deleted: false, updatedAt: toMillis(t.updatedAt), task: t });
  }
  for (const tomb of (local && local.tombstones) || []) {
    if (!tomb || typeof tomb.id !== 'string' || !tomb.id) continue;
    const updatedAt = toMillis(tomb.updatedAt);
    const prev = localMap.get(tomb.id);
    if (!prev || updatedAt >= prev.updatedAt) {
      localMap.set(tomb.id, { deleted: true, updatedAt, task: tomb.task || null });
    }
  }

  const remoteMap = new Map();
  for (const row of remoteRows || []) {
    if (!row || typeof row.id !== 'string' || !row.id) continue;
    const updatedAt = toMillis(row.updated_at) || toMillis(row.data && row.data.updatedAt);
    remoteMap.set(row.id, {
      deleted: !!row.deleted,
      updatedAt,
      task: row.data && typeof row.data === 'object' ? row.data : null,
    });
  }

  const tasks = [];
  const tombstones = [];
  const toPush = [];
  for (const id of new Set([...localMap.keys(), ...remoteMap.keys()])) {
    const L = localMap.get(id);
    const R = remoteMap.get(id);
    let winner;
    let source;
    if (L && !R) { winner = L; source = 'local'; }
    else if (R && !L) { winner = R; source = 'remote'; }
    else if (R.updatedAt > L.updatedAt) { winner = R; source = 'remote'; }
    else if (L.updatedAt > R.updatedAt) { winner = L; source = 'local'; }
    else if (L.deleted !== R.deleted) {
      winner = L.deleted ? R : L;
      source = winner === L ? 'local' : 'remote';
    } else {
      winner = L;
      source = 'local';
    }

    const push = source === 'local' && (!R || L.updatedAt > R.updatedAt);
    if (winner.deleted) {
      const task = coerceTask(id, winner.updatedAt, winner.task);
      const keep = source === 'local' || (now - winner.updatedAt < TOMBSTONE_TTL_MS);
      if (keep) tombstones.push({ id, updatedAt: winner.updatedAt, task });
      if (push) toPush.push(rowFrom(id, winner.updatedAt, true, task));
    } else {
      let task = coerceTask(id, winner.updatedAt, winner.task);
      if (!task) {
        const other = source === 'local' ? R : L;
        if (other && !other.deleted) task = coerceTask(id, other.updatedAt, other.task);
      }
      if (!task) continue;
      tasks.push(task);
      if (push) toPush.push(rowFrom(id, task.updatedAt, false, task));
    }
  }
  return { tasks, tombstones, toPush };
}

/** Rows the server does not already have at this updatedAt. */
export function rowsToPush(snapshot, remoteTimes, userId) {
  const times = remoteTimes || new Map();
  const rows = [];
  const consider = (id, updatedAt, deleted, task) => {
    const known = times.has(id) ? times.get(id) : null;
    if (known == null || updatedAt > known) rows.push({ ...rowFrom(id, updatedAt, deleted, task), user_id: userId });
  };
  for (const t of (snapshot && snapshot.tasks) || []) consider(t.id, toMillis(t.updatedAt), false, t);
  for (const tomb of (snapshot && snapshot.tombstones) || []) consider(tomb.id, toMillis(tomb.updatedAt), true, tomb.task);
  return rows;
}

export async function pullTasks(client) {
  const { data, error } = await client.from('tasks').select('id,data,deleted,updated_at');
  if (error) throw error;
  return data || [];
}

export async function pushTasks(client, rows) {
  if (!rows.length) return;
  const { error } = await client.from('tasks').upsert(rows, { onConflict: 'user_id,id' });
  if (error) throw error;
}

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function later(fn, ms) {
  const timer = setTimeout(fn, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

/**
 * Pull, merge, and push. Local edits are debounced. Remote failures are retried
 * and never replace the on-device list with an empty one.
 */
export function createSync(store, client, { onStatus, pushDelay = 700, pullDelay = 300 } = {}) {
  let session = null;
  let channel = null;
  let applying = false;
  let stopped = false;
  let retry = 0;
  let pushTimer = null;
  let pullTimer = null;
  let retryTimer = null;
  const remoteTimes = new Map();
  const unsub = store.subscribe(() => schedulePush());

  function setStatus(state) { if (onStatus) onStatus(state); }

  function clearTimers() {
    clearTimeout(pushTimer);
    clearTimeout(pullTimer);
    clearTimeout(retryTimer);
  }

  async function pushRows(rows) {
    const payload = rows.map((r) => (r.user_id ? r : { ...r, user_id: session.user.id }));
    setStatus('syncing');
    await pushTasks(client, payload);
    for (const r of payload) remoteTimes.set(r.id, toMillis(r.updated_at));
    retry = 0;
    applying = true;
    try { store.purgeOldTombstones(Date.now() - TOMBSTONE_TTL_MS); }
    finally { applying = false; }
    if (session) setStatus('synced');
  }

  function plan(rows) {
    const gen = store.getGeneration();
    let merged = mergeSync(store.getSyncSnapshot(), rows);
    if (store.getGeneration() !== gen) merged = mergeSync(store.getSyncSnapshot(), rows);
    return merged;
  }

  async function pull() {
    if (!session || stopped) return;
    if (!isOnline()) { setStatus('offline'); return; }
    setStatus('syncing');
    const rows = await pullTasks(client);
    if (stopped || !session) return;
    const merged = plan(rows);
    applying = true;
    try { store.applySyncSnapshot({ tasks: merged.tasks, tombstones: merged.tombstones }); }
    finally { applying = false; }
    remoteTimes.clear();
    for (const row of rows) {
      if (row && typeof row.id === 'string') remoteTimes.set(row.id, toMillis(row.updated_at) || toMillis(row.data && row.data.updatedAt));
    }
    if (merged.toPush.length) await pushRows(merged.toPush);
    else {
      applying = true;
      try { store.purgeOldTombstones(Date.now() - TOMBSTONE_TTL_MS); }
      finally { applying = false; }
      if (session) setStatus('synced');
    }
  }

  function fail(err) {
    console.warn('Sync failed', err && err.message ? err.message : err);
    setStatus('error');
    clearTimeout(retryTimer);
    const delay = Math.min(30000, 1000 * 2 ** retry);
    retry++;
    retryTimer = later(() => {
      if (session && !stopped) pull().catch(fail);
    }, delay);
  }

  function schedulePush() {
    if (!session || applying || stopped) return;
    clearTimeout(pushTimer);
    pushTimer = later(async () => {
      if (!session || stopped) return;
      if (!isOnline()) { setStatus('offline'); return; }
      try {
        const rows = rowsToPush(store.getSyncSnapshot(), remoteTimes, session.user.id);
        if (!rows.length) { setStatus('synced'); return; }
        await pushRows(rows);
      } catch (err) { fail(err); }
    }, pushDelay);
  }

  function schedulePull() {
    if (!session || stopped) return;
    clearTimeout(pullTimer);
    pullTimer = later(() => { pull().catch(fail); }, pullDelay);
  }

  function listen() {
    if (!client.channel || !session) return;
    if (channel && client.removeChannel) client.removeChannel(channel);
    const userId = session.user.id;
    channel = client.channel('tasks-sync-' + userId);
    channel.on('postgres_changes', {
      event: '*', schema: 'public', table: 'tasks', filter: `user_id=eq.${userId}`,
    }, () => schedulePull());
    channel.subscribe();
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => { if (session) schedulePull(); });
    window.addEventListener('offline', () => { if (session) setStatus('offline'); });
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && session) schedulePull();
    });
  }

  return {
    async useSession(sess) {
      session = sess;
      stopped = false;
      retry = 0;
      try { await pull(); }
      catch (err) { fail(err); }
      listen();
    },
    stopSession() {
      session = null;
      clearTimers();
      if (channel && client.removeChannel) client.removeChannel(channel);
      channel = null;
      setStatus('off');
    },
    pull: schedulePull,
    stop() {
      stopped = true;
      this.stopSession();
      unsub();
    },
  };
}

export async function loadSupabaseClient() {
  const { createClient } = await import(SUPABASE_MODULE);
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
}
