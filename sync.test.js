import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => { mem.clear(); },
};
globalThis.window = globalThis.window || globalThis;
if (typeof globalThis.window.addEventListener !== 'function') globalThis.window.addEventListener = () => {};

const store = await import('./store.js');
const sync = await import('./sync.js');

const task = (id, title, updatedAt, extra = {}) => ({
  id, title, due: null, time: null, note: '', done: false, createdAt: updatedAt, doneAt: null, updatedAt, ...extra,
});
const remote = (t, deleted = false) => ({
  id: t.id, data: t, deleted, updated_at: new Date(t.updatedAt).toISOString(),
});

const ownerSession = { user: { id: 'owner', email: sync.SYNC_EMAIL } };

function fakeAuth(script) {
  const calls = [];
  let stored = script.existing || null;
  const client = {
    calls,
    auth: {
      async getSession() {
        calls.push('getSession');
        return { data: { session: stored }, error: null };
      },
      async signInWithPassword(creds) {
        calls.push('signIn');
        assert.equal(creds.email, sync.SYNC_EMAIL);
        assert.equal(creds.password, sync.SYNC_PASSWORD);
        if (script.signInError && calls.filter((c) => c === 'signIn').length <= (script.failSignIns || 1)) {
          return { data: { session: null }, error: script.signInError };
        }
        stored = script.session || ownerSession;
        return { data: { session: stored }, error: null };
      },
      async signUp(creds) {
        calls.push('signUp');
        assert.equal(creds.email, sync.SYNC_EMAIL);
        assert.equal(creds.password, sync.SYNC_PASSWORD);
        if (script.signUpError) return { data: { session: null }, error: script.signUpError };
        stored = script.session || ownerSession;
        return { data: { session: stored }, error: null };
      },
      async signOut() {
        calls.push('signOut');
        stored = null;
        return { error: null };
      },
    },
  };
  return client;
}

test('the built-in account is a fixed email and password', () => {
  assert.equal(sync.SYNC_EMAIL, 'todo-owner@todo-app.example.com');
  assert.equal(sync.SYNC_PASSWORD, 'braindump-todo-owner-7kQ4mN2p');
  assert.equal(sync.isInvalidCredentials({ message: 'Invalid login credentials' }), true);
  assert.equal(sync.isInvalidCredentials({ message: 'Failed to fetch' }), false);
  assert.equal(sync.isAlreadyRegistered({ message: 'User already registered' }), true);
});

test('an existing owner session is reused without signing in again', async () => {
  const client = fakeAuth({ existing: ownerSession });
  const session = await sync.ensureOwnerSession(client);
  assert.equal(session, ownerSession);
  assert.deepEqual(client.calls, ['getSession']);
});

test('a different saved session is replaced, then the owner signs in', async () => {
  const client = fakeAuth({ existing: { user: { id: 'other', email: 'someone@example.com' } } });
  const session = await sync.ensureOwnerSession(client);
  assert.equal(session.user.email, sync.SYNC_EMAIL);
  assert.deepEqual(client.calls, ['getSession', 'signOut', 'signIn']);
});

test('invalid credentials signs the owner up once, and other errors do not', async () => {
  const created = fakeAuth({ signInError: { message: 'Invalid login credentials' } });
  const session = await sync.ensureOwnerSession(created);
  assert.equal(session.user.email, sync.SYNC_EMAIL);
  assert.deepEqual(created.calls, ['getSession', 'signIn', 'signUp']);

  const raced = fakeAuth({
    signInError: { message: 'Invalid login credentials' },
    signUpError: { message: 'User already registered' },
    failSignIns: 1,
  });
  const again = await sync.ensureOwnerSession(raced);
  assert.equal(again.user.email, sync.SYNC_EMAIL);
  assert.deepEqual(raced.calls, ['getSession', 'signIn', 'signUp', 'signIn']);

  const offline = fakeAuth({ signInError: { message: 'Failed to fetch' } });
  await assert.rejects(
    () => sync.ensureOwnerSession(offline),
    (err) => err && err.message === 'Failed to fetch',
  );
  assert.deepEqual(offline.calls, ['getSession', 'signIn']);
});

test('merge keeps every id and lets the newest updatedAt win', () => {
  const local = { tasks: [task('a', 'Laptop only', 10), task('both', 'Local title', 100)], tombstones: [] };
  const rows = [remote(task('b', 'Phone only', 20)), remote(task('both', 'Phone title', 150))];
  const merged = sync.mergeSync(local, rows, 1_000_000);
  const byId = Object.fromEntries(merged.tasks.map((t) => [t.id, t]));
  assert.equal(byId.a.title, 'Laptop only');
  assert.equal(byId.b.title, 'Phone only');
  assert.equal(byId.both.title, 'Phone title');
  assert.deepEqual(merged.toPush.map((r) => r.id), ['a']);
  assert.equal(merged.toPush[0].deleted, false);
});

test('a newer tombstone deletes, an older one does not, and a tie keeps the task', () => {
  const now = 10_000;
  const deleted = sync.mergeSync(
    { tasks: [task('x', 'Still here', 100)], tombstones: [] },
    [remote(task('x', 'Still here', 200), true)],
    now,
  );
  assert.equal(deleted.tasks.length, 0);
  assert.equal(deleted.tombstones[0].id, 'x');
  assert.equal(deleted.toPush.length, 0);

  const kept = sync.mergeSync(
    { tasks: [task('x', 'Edited later', 300)], tombstones: [] },
    [remote(task('x', 'Old', 200), true)],
    now,
  );
  assert.equal(kept.tasks[0].title, 'Edited later');
  assert.equal(kept.toPush.length, 1);
  assert.equal(kept.toPush[0].deleted, false);

  const tie = sync.mergeSync(
    { tasks: [task('x', 'Keep me', 200)], tombstones: [] },
    [remote(task('x', 'Keep me', 200), true)],
    now,
  );
  assert.equal(tie.tasks[0].title, 'Keep me');
  assert.equal(tie.toPush.length, 0);
});

test('local deletes are pushed, and ancient remote tombstones are not stored', () => {
  const now = Date.now();
  const local = sync.mergeSync(
    { tasks: [], tombstones: [{ id: 'gone', updatedAt: now - 1000, task: task('gone', 'Gone', now - 1000) }] },
    [],
    now,
  );
  assert.equal(local.tasks.length, 0);
  assert.equal(local.tombstones.length, 1);
  assert.equal(local.toPush[0].deleted, true);

  const ancient = now - sync.TOMBSTONE_TTL_MS - 1000;
  const dropped = sync.mergeSync(
    { tasks: [], tombstones: [] },
    [remote(task('old', 'Old', ancient), true)],
    now,
  );
  assert.equal(dropped.tasks.length, 0);
  assert.equal(dropped.tombstones.length, 0);
  assert.equal(dropped.toPush.length, 0);
});

test('a corrupt newer remote row does not wipe the local task', () => {
  const merged = sync.mergeSync(
    { tasks: [task('a', 'Safe', 10)], tombstones: [] },
    [{ id: 'a', data: { note: 'no title' }, deleted: false, updated_at: new Date(50).toISOString() }],
    1000,
  );
  assert.equal(merged.tasks[0].title, 'Safe');
});

test('rowsToPush skips rows the server already has', () => {
  const snap = {
    tasks: [task('a', 'A', 10), task('b', 'B', 30)],
    tombstones: [{ id: 'c', updatedAt: 40, task: task('c', 'C', 40) }],
  };
  const times = new Map([['a', 10], ['b', 20]]);
  const rows = sync.rowsToPush(snap, times, 'user-1');
  assert.deepEqual(rows.map((r) => r.id).sort(), ['b', 'c']);
  assert.equal(rows.every((r) => r.user_id === 'user-1'), true);
  assert.equal(rows.find((r) => r.id === 'c').deleted, true);
});

function fakeClient(remoteRows, pushed, { failPush = false } = {}) {
  return {
    from() {
      return {
        select: () => Promise.resolve({ data: remoteRows.map((r) => ({ ...r })), error: null }),
        upsert: (rows) => {
          if (failPush) return Promise.resolve({ error: { message: 'nope' } });
          pushed.push(...rows);
          return Promise.resolve({ error: null });
        },
      };
    },
    channel() { return this; },
    on() { return this; },
    subscribe() { return this; },
    removeChannel() {},
  };
}

test('signing in merges remote tasks and pushes local ones without dropping either', async () => {
  store.applySyncSnapshot({
    tasks: [task('a', 'From laptop', 10)],
    tombstones: [],
  });
  const pushed = [];
  const remoteRows = [remote(task('b', 'From phone', 20))];
  const statuses = [];
  const engine = sync.createSync(store, fakeClient(remoteRows, pushed), {
    onStatus: (s) => statuses.push(s),
    pushDelay: 0,
    pullDelay: 0,
  });
  try {
    await engine.useSession({ user: { id: 'user-1' } });
    const titles = store.getTasks().map((t) => t.title).sort();
    assert.deepEqual(titles, ['From laptop', 'From phone']);
    assert.equal(pushed.some((r) => r.id === 'a' && r.user_id === 'user-1' && r.deleted === false), true);
    assert.equal(pushed.some((r) => r.id === 'b'), false);
    assert.equal(statuses.at(-1), 'synced');
  } finally {
    engine.stop();
  }
});

test('a failed push leaves local tasks in place and reports an error', async () => {
  store.applySyncSnapshot({ tasks: [task('a', 'Keep me', 10)], tombstones: [] });
  const seen = [];
  const engine = sync.createSync(store, fakeClient([], [], { failPush: true }), {
    onStatus: (s) => seen.push(s),
    pushDelay: 0,
  });
  try {
    await engine.useSession({ user: { id: 'user-1' } });
    assert.equal(store.getTasks()[0].title, 'Keep me');
    assert.equal(seen.includes('error'), true);
  } finally {
    engine.stop();
  }
});
