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
const KEY = 'braindump-todo:v1';

test.beforeEach(() => {
  localStorage.clear();
  store.replaceAll([]);
  store.replaceTagRegistry(null);
});

test('migrate turns a v0 array and a v2 backup into notes-capable tasks', () => {
  const v0 = store.migrate([{ id: 'a', title: 'Old task', createdAt: 1 }]);
  assert.equal(v0.version, 4);
  assert.equal(v0.tasks[0].note, '');
  assert.equal(v0.tasks[0].title, 'Old task');

  const v2 = store.migrate({
    version: 2,
    tasks: [{ id: 'b', text: '  call mum ', due: '2026-10-02', time: '09:30', done: false, createdAt: 2 }],
  });
  assert.deepEqual(v2.tasks[0], {
    id: 'b', title: 'call mum', due: '2026-10-02', time: '09:30', note: '', tags: [], done: false, createdAt: 2, doneAt: null, updatedAt: 2,
  });
  assert.equal(store.migrate({ nope: true }), null);
});

test('notes are trimmed, multi-line, and capped; a time without a date is dropped', () => {
  const [task] = store.migrate({
    version: 1,
    tasks: [{
      id: 'n',
      title: 'Shop',
      time: '15:00',
      notes: '  oat milk\r\nfrom the corner  ',
      createdAt: 3,
    }],
  }).tasks;
  assert.equal(task.due, null);
  assert.equal(task.time, null);
  assert.equal(task.note, 'oat milk\nfrom the corner');

  const long = store.migrate({ version: 3, tasks: [{ id: 'l', title: 'Long', note: 'x'.repeat(4001) + '   ' }] }).tasks[0];
  assert.equal(long.note.length <= 4000, true);
  assert.equal(store.migrate({ version: 3, tasks: [{ id: 'e', title: 'Empty', note: '   \n  ' }] }).tasks[0].note, '');
  assert.equal(store.migrate({ version: 3, tasks: [{ title: '   ', note: 'orphan note' }] }).tasks.length, 0);
});

test('load migrates an existing v2 list in place and keeps the storage key', () => {
  localStorage.setItem(KEY, JSON.stringify({
    version: 2,
    tasks: [{ id: 'z', title: 'Legacy', due: '2026-10-01', done: true, createdAt: 5, doneAt: 6 }],
  }));
  const tasks = store.load();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].note, '');
  assert.equal(tasks[0].doneAt, 6);
  assert.equal(tasks[0].updatedAt, 6);
  const saved = JSON.parse(localStorage.getItem(KEY));
  assert.equal(saved.version, 4);
  assert.equal(saved.tasks[0].note, '');
  assert.equal(saved.tasks[0].title, 'Legacy');
});

test('updating a title keeps the note, and export/import round-trips it', () => {
  const [t] = store.addTasks([{ title: 'Milk', due: '2026-10-02', time: '09:00' }]);
  assert.equal(t.note, '');
  store.updateTask(t.id, { note: 'oat milk\nfrom the corner' });
  store.updateTask(t.id, { title: 'Oat milk' });
  const cur = store.getTasks()[0];
  assert.equal(cur.title, 'Oat milk');
  assert.equal(cur.note, 'oat milk\nfrom the corner');
  assert.equal(cur.due, '2026-10-02');
  assert.equal(cur.time, '09:00');

  const exported = JSON.parse(store.exportJSON());
  assert.equal(exported.version, 4);
  assert.equal(exported.app, 'braindump-todo');
  assert.equal(exported.tasks[0].note, 'oat milk\nfrom the corner');

  store.replaceAll([]);
  assert.deepEqual(store.importJSON(JSON.stringify(exported)), { added: 1, merged: 0 });
  assert.equal(store.getTasks()[0].note, 'oat milk\nfrom the corner');
  assert.deepEqual(store.importJSON(JSON.stringify(exported)), { added: 0, merged: 0 });
  assert.equal(store.getTasks().length, 1);
});

test('merge-by-id adds new tasks with notes and only fills a missing note', () => {
  store.replaceAll([{ id: 'keep', title: 'Stay', note: 'local note', createdAt: 1 }]);
  const result = store.importJSON(JSON.stringify({
    version: 2,
    tasks: [
      { id: 'keep', title: 'Overwrite?', note: 'backup note' },
      { id: 'blank', title: 'Needs a note', createdAt: 2 },
      { id: 'fresh', title: 'New', note: '  brought over  ', createdAt: 3 },
    ],
  }));
  assert.deepEqual(result, { added: 2, merged: 0 });
  const byId = Object.fromEntries(store.getTasks().map((t) => [t.id, t]));
  assert.equal(byId.keep.note, 'local note');
  assert.equal(byId.keep.title, 'Stay');
  assert.equal(byId.blank.note, '');
  assert.equal(byId.fresh.note, 'brought over');

  assert.deepEqual(
    store.importJSON(JSON.stringify({ version: 3, tasks: [{ id: 'blank', title: 'Needs a note', note: 'filled in' }] })),
    { added: 0, merged: 1 },
  );
  assert.equal(store.getTasks().find((t) => t.id === 'blank').note, 'filled in');
  assert.deepEqual(
    store.importJSON(JSON.stringify({ version: 3, tasks: [{ id: 'blank', title: 'Needs a note', note: 'do not clobber' }] })),
    { added: 0, merged: 0 },
  );
  assert.equal(store.getTasks().find((t) => t.id === 'blank').note, 'filled in');
});

test('old JSON without notes still imports, and bad files throw', () => {
  assert.deepEqual(store.importJSON(JSON.stringify([{ id: 'old', title: 'From v0' }])), { added: 1, merged: 0 });
  assert.equal(store.getTasks()[0].note, '');
  assert.throws(() => store.importJSON('not json'), /not valid JSON/);
  assert.throws(() => store.importJSON(JSON.stringify({ hello: 'nope' })), /does not look like a backup/);
});

test('marking a task not done keeps its details and is newer for sync', () => {
  const [t] = store.addTasks([{ title: 'Call mum', due: '2026-10-02', time: '09:30' }]);
  store.updateTask(t.id, { note: 'bring the form', done: true });
  const done = store.getTasks().find((x) => x.id === t.id);
  assert.equal(done.done, true);
  assert.ok(done.doneAt);
  store.updateTask(t.id, { done: false });
  const back = store.getTasks().find((x) => x.id === t.id);
  assert.equal(back.done, false);
  assert.equal(back.doneAt, null);
  assert.equal(back.title, 'Call mum');
  assert.equal(back.due, '2026-10-02');
  assert.equal(back.time, '09:30');
  assert.equal(back.note, 'bring the form');
  assert.ok(back.updatedAt > done.updatedAt);
});

test('tags are lowercase, unique, and need a letter', () => {
  assert.equal(store.normalizeTagName('#Work'), 'work');
  assert.equal(store.normalizeTagName('uni admin'), 'uni-admin');
  assert.equal(store.normalizeTagName('#1'), '');
  assert.equal(store.normalizeTagName('123'), '');
  const [t] = store.addTasks([{ title: 'A', tags: ['#Work', 'WORK', '1', 'uni-admin', ''] }]);
  assert.deepEqual(t.tags, ['work', 'uni-admin']);
  assert.deepEqual(store.getTagCatalog().map((tag) => tag.name), ['uni-admin', 'work']);
});

test('rename retags every task, merges an existing name, and bumps updatedAt', () => {
  const [a] = store.addTasks([{ title: 'A', tags: ['work'] }]);
  const [b] = store.addTasks([{ title: 'B', tags: ['home', 'work'] }]);
  store.setTagColor('work', 'blue');
  const before = store.getTasks().find((t) => t.id === a.id).updatedAt;
  const result = store.renameTag('Work', 'home');
  assert.equal(result.merged, true);
  assert.equal(result.renamed, 2);
  const tasks = Object.fromEntries(store.getTasks().map((t) => [t.id, t]));
  assert.deepEqual(tasks[a.id].tags, ['home']);
  assert.deepEqual(tasks[b.id].tags, ['home']);
  assert.ok(tasks[a.id].updatedAt > before);
  assert.equal(store.getTagCatalog().some((tag) => tag.name === 'work'), false);
  assert.equal(store.getTagCatalog().find((tag) => tag.name === 'home').color, '');
});

test('rename keeps the colour when the new name is new', () => {
  store.addTasks([{ title: 'A', tags: ['work'] }]);
  store.setTagColor('work', 'teal');
  const result = store.renameTag('work', 'office');
  assert.equal(result.merged, false);
  assert.equal(store.getTasks()[0].tags[0], 'office');
  assert.equal(store.getTagCatalog().find((tag) => tag.name === 'office').color, 'teal');
});

test('deleteTag removes the tag from tasks, keeps the tasks, and undo restores it', () => {
  const [a] = store.addTasks([{ title: 'Keep me', due: '2026-10-02', tags: ['work'] }]);
  const before = store.getTasks()[0].updatedAt;
  const undo = store.deleteTag('work');
  const gone = store.getTasks()[0];
  assert.equal(gone.title, 'Keep me');
  assert.equal(gone.due, '2026-10-02');
  assert.deepEqual(gone.tags, []);
  assert.ok(gone.updatedAt > before);
  assert.equal(store.getTagCatalog().some((tag) => tag.name === 'work'), false);
  store.undoDeleteTag(undo);
  const back = store.getTasks().find((t) => t.id === a.id);
  assert.deepEqual(back.tags, ['work']);
  assert.ok(back.updatedAt > gone.updatedAt);
  assert.equal(store.getTagCatalog().some((tag) => tag.name === 'work'), true);
});

test('colours round-trip in the registry and a __tags__ row is never a task', () => {
  store.addTag('home', 'pink');
  store.addTasks([{ title: 'A', tags: ['home'] }]);
  const saved = JSON.parse(localStorage.getItem(KEY));
  assert.equal(saved.tags.items.find((tag) => tag.name === 'home').color, 'pink');
  const exported = JSON.parse(store.exportJSON());
  assert.equal(exported.tags.items[0].color, 'pink');

  store.replaceAll([]);
  store.replaceTagRegistry(null);
  store.importJSON(JSON.stringify(exported));
  assert.equal(store.getTasks()[0].tags[0], 'home');
  assert.equal(store.getTagCatalog().find((tag) => tag.name === 'home').color, 'pink');

  const migrated = store.migrate({
    version: 4,
    tasks: [
      { id: '__tags__', title: 'Do not show', kind: 'tags' },
      { id: 'real', title: 'Real' },
    ],
  });
  assert.deepEqual(migrated.tasks.map((t) => t.id), ['real']);
});

test('undo restore keeps the note', () => {
  const [t] = store.addTasks([{ title: 'Temp' }]);
  store.updateTask(t.id, { note: 'remember this' });
  const removed = store.removeTasks([t.id]);
  assert.equal(store.getTasks().length, 0);
  assert.equal(store.getSyncSnapshot().tombstones.some((tomb) => tomb.id === t.id), true);
  store.restoreTasks(removed);
  assert.equal(store.getTasks()[0].note, 'remember this');
  assert.equal(store.getSyncSnapshot().tombstones.some((tomb) => tomb.id === t.id), false);
});
