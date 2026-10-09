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

test('the tags row syncs by name and is never returned as a task', () => {
  const local = {
    tasks: [task('a', 'A', 10, { tags: ['work'] })],
    tombstones: [],
    tags: {
      updatedAt: 50,
      items: [{ name: 'work', color: 'blue', createdAt: 50, updatedAt: 50 }],
      tombstones: [],
    },
  };
  const remoteTags = {
    id: '__tags__',
    deleted: false,
    updated_at: new Date(40).toISOString(),
    data: {
      kind: 'tags',
      updatedAt: 40,
      tags: [{ name: 'home', color: 'red', createdAt: 40, updatedAt: 40 }],
      tombstones: [],
    },
  };
  const merged = sync.mergeSync(local, [remoteTags, remote(task('b', 'B', 20))], 1000);
  assert.equal(merged.tasks.some((t) => t.id === '__tags__'), false);
  assert.deepEqual(merged.tasks.map((t) => t.id).sort(), ['a', 'b']);
  assert.deepEqual(merged.tags.items.map((t) => t.name), ['home', 'work']);
  const row = merged.toPush.find((r) => r.id === '__tags__');
  assert.equal(row.data.kind, 'tags');
  assert.equal(row.data.title, undefined);
  assert.deepEqual(row.data.tags.map((t) => t.name), ['home', 'work']);
});

test('a newer colour wins, and a newer tombstone drops the tag', () => {
  const local = {
    tasks: [],
    tombstones: [],
    tags: {
      updatedAt: 100,
      items: [{ name: 'work', color: 'blue', createdAt: 10, updatedAt: 100 }],
      tombstones: [{ name: 'old', updatedAt: 80 }],
    },
  };
  const remoteTags = {
    id: '__tags__',
    deleted: false,
    updated_at: new Date(90).toISOString(),
    data: {
      kind: 'tags',
      updatedAt: 90,
      tags: [
        { name: 'work', color: 'red', createdAt: 10, updatedAt: 90 },
        { name: 'old', color: 'pink', createdAt: 20, updatedAt: 20 },
      ],
      tombstones: [],
    },
  };
  const merged = sync.mergeSync(local, [remoteTags], 1000);
  const work = merged.tags.items.find((t) => t.name === 'work');
  assert.equal(work.color, 'blue');
  assert.equal(merged.tags.items.some((t) => t.name === 'old'), false);
  assert.equal(merged.tags.tombstones.some((t) => t.name === 'old'), true);
  assert.equal(merged.tasks.length, 0);
  assert.equal(merged.toPush.some((r) => r.id === '__tags__'), true);
});

test('rowsToPush sends a newer tags row and skips one the server already has', () => {
  const snap = {
    tasks: [task('a', 'A', 10)],
    tombstones: [],
    tags: {
      updatedAt: 50,
      items: [{ name: 'work', color: '', createdAt: 50, updatedAt: 50 }],
      tombstones: [],
    },
  };
  const fresh = sync.rowsToPush(snap, new Map(), 'user-1');
  assert.equal(fresh.some((r) => r.id === '__tags__' && r.data.kind === 'tags'), true);
  const held = sync.rowsToPush(snap, new Map([['__tags__', 50], ['a', 10]]), 'user-1');
  assert.deepEqual(held, []);
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

test('a pulled tags row is stored and is not shown as a task', async () => {
  store.applySyncSnapshot({ tasks: [task('a', 'From laptop', 10)], tombstones: [], tags: { updatedAt: 0, items: [], tombstones: [] } });
  const pushed = [];
  const remoteRows = [
    remote(task('b', 'From phone', 20)),
    {
      id: '__tags__',
      deleted: false,
      updated_at: new Date(30).toISOString(),
      data: {
        kind: 'tags',
        updatedAt: 30,
        tags: [{ name: 'work', color: 'green', createdAt: 30, updatedAt: 30 }],
        tombstones: [],
      },
    },
  ];
  const engine = sync.createSync(store, fakeClient(remoteRows, pushed), { pushDelay: 0, pullDelay: 0 });
  try {
    await engine.useSession({ user: { id: 'user-1' } });
    assert.deepEqual(store.getTasks().map((t) => t.title).sort(), ['From laptop', 'From phone']);
    assert.equal(store.getTasks().some((t) => t.id === '__tags__'), false);
    assert.equal(store.getTagCatalog().find((t) => t.name === 'work').color, 'green');
    assert.equal(pushed.some((r) => r.id === '__tags__'), false);
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
