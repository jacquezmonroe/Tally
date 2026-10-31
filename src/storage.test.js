import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStoredReminders,
  validateReminderRecord,
  parseQuietHours,
  parseReminderDefaults,
  describeNotice,
  createReminderStorage,
  normalizeTime,
  isValidDateKey,
  MAX_REMINDER_ID,
  CURRENT_SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  BACKUP_KEY_PREFIX,
  SETTINGS_BACKUP_KEY_PREFIX,
  QUARANTINE_KEY,
  NOTICE_KEY,
} from './storage.js';
import { DEFAULT_QUIET_HOURS, DEFAULT_REMINDER_DEFAULTS } from './settings.js';

// ---- helpers ----
const good = (over = {}) => ({ id: 1, name: 'Take vitamins', time: '09:00', takenDate: null, recurrence: { type: 'daily' }, ...over });
const json = value => JSON.stringify(value);
const KEYS = { reminders: 'tally-reminders', nextId: 'tally-next-id' };
const NOW = new Date('2026-10-31T14:30:00Z');

// An in-memory stand-in for Capacitor Preferences that records every write and
// can be told to fail. This is a MOCK: it proves our ordering and error
// handling, not iOS storage behavior.
function fakePrefs(initial = {}, { failSet = () => false, failGet = () => false } = {}) {
  const store = new Map(Object.entries(initial));
  const log = [];
  return {
    store,
    log,
    async get(key) { if (failGet(key)) throw new Error('get failed'); return store.has(key) ? store.get(key) : null; },
    async set(key, value) { log.push(['set', key]); if (failSet(key)) throw new Error('set failed'); store.set(key, value); },
    async remove(key) { log.push(['remove', key]); store.delete(key); },
  };
}
const storageFor = (prefs) => createReminderStorage({ prefs, keys: KEYS, now: () => NOW });
const writtenKeys = prefs => prefs.log.filter(([op]) => op === 'set').map(([, key]) => key);

// ---- empty and healthy data ----

test('nothing stored is an ordinary empty start', () => {
  for (const raw of [null, undefined, '']) {
    const r = parseStoredReminders(raw, null);
    assert.equal(r.status, 'empty');
    assert.deepEqual(r.reminders, []);
    assert.equal(r.nextId, 1);
    assert.equal(r.nextIdChanged, false);
  }
});

test('an empty list is valid', () => {
  const r = parseStoredReminders('[]', '1');
  assert.equal(r.status, 'ok');
  assert.equal(r.nextIdChanged, false);
});

test('healthy data loads unchanged and flags nothing', () => {
  const data = [good({ id: 1 }), good({ id: 2, name: 'B', recurrence: { type: 'daysOfWeek', daysOfWeek: [1, 3] } })];
  const r = parseStoredReminders(json(data), '3');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.quarantined, []);
  assert.deepEqual(r.repaired, []);
  assert.deepEqual(r.reminders.map(x => x.id), [1, 2]);
  assert.equal(r.nextId, 3);
  assert.equal(r.nextIdChanged, false);
});

test('a reminder saved before newer fields existed is fine and needs no repair', () => {
  const r = parseStoredReminders(json([{ id: 4, name: 'Old', time: '07:30' }]), '5');
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.reminders[0].recurrence, { type: 'daily' });
  assert.equal(r.reminders[0].currentStreak, 0);
  assert.equal(r.reminders[0].notes, '');
  assert.equal(r.reminders[0].takenDate, null);
});

test('unknown extra fields are preserved, and a hostile key cannot touch prototypes', () => {
  const r = parseStoredReminders('[{"id":1,"name":"A","time":"09:00","futureField":{"x":1},"__proto__":{"polluted":true}}]', '2');
  assert.deepEqual(r.reminders[0].futureField, { x: 1 });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(r.reminders[0]), Object.prototype);
});

// ---- whole-value corruption ----

test('invalid JSON is unreadable, never a crash', () => {
  for (const raw of ['{not json', '[1,2', 'undefined', '<html>oops</html>', '[{"id":1,', "{'a':1}"]) {
    const r = parseStoredReminders(raw, '5');
    assert.equal(r.status, 'unreadable', raw);
    assert.equal(r.reason, 'invalid_json');
    assert.deepEqual(r.reminders, []);
    assert.equal(r.nextId, 5); // the saved counter is kept so ids are never reused
  }
});

test('valid JSON that is not a list is unreadable', () => {
  for (const raw of ['{"id":1}', '42', '"text"', 'null', 'true', '{"reminders":[]}']) {
    const r = parseStoredReminders(raw, '3');
    assert.equal(r.status, 'unreadable', raw);
    assert.equal(r.reason, 'not_a_list');
  }
});

// ---- record-level corruption ----

test('items that are not objects are set aside and the valid ones are kept', () => {
  const r = parseStoredReminders(json([null, good({ id: 2 }), 5, 'text', true, [], good({ id: 3, name: 'C' })]), '4');
  assert.equal(r.status, 'recovered');
  assert.deepEqual(r.reminders.map(x => x.id), [2, 3]);
  assert.equal(r.quarantined.length, 5);
  assert.ok(r.quarantined.every(q => q.reason === 'not_an_object'));
  assert.deepEqual(r.quarantined.map(q => q.index), [0, 2, 3, 4, 5]);
});

test('a missing or blank name sets the record aside', () => {
  for (const name of [undefined, null, '', '   ', 42, {}, ['x']]) {
    const v = validateReminderRecord(good({ name }));
    assert.deepEqual(v, { ok: false, reason: 'missing_name' }, String(name));
  }
});

test('bad times set the record aside; sloppy-but-real times are normalized', () => {
  for (const time of [undefined, null, '', 'abc', '25:00', '9:60', '24:00', '-1:00', '12', '12:5', 900, {}, '09:00:00 PM']) {
    assert.deepEqual(validateReminderRecord(good({ time })), { ok: false, reason: 'invalid_time' }, String(time));
  }
  assert.equal(normalizeTime('9:05'), '09:05');
  assert.equal(normalizeTime(' 23:59 '), '23:59');
  assert.equal(validateReminderRecord(good({ time: '9:05' })).record.time, '09:05');
});

test('unusable recurrences set the record aside', () => {
  const bad = [
    null, 'daily', 5, [], {}, { type: 'weekly' }, { type: 'daysOfWeek' }, { type: 'daysOfWeek', daysOfWeek: [] },
    { type: 'daysOfWeek', daysOfWeek: [7] }, { type: 'daysOfWeek', daysOfWeek: [-1] }, { type: 'daysOfWeek', daysOfWeek: ['1'] },
    { type: 'daysOfWeek', daysOfWeek: 'Mon' }, { type: 'monthlyDate' }, { type: 'monthlyDate', dayOfMonth: 0 },
    { type: 'monthlyDate', dayOfMonth: 32 }, { type: 'monthlyDate', dayOfMonth: 1.5 }, { type: 'once' },
    { type: 'once', date: 'tomorrow' }, { type: 'once', date: '2026-02-30' }, { type: 'once', date: '2026-13-01' }, { type: 'once', date: 20261031 },
  ];
  for (const recurrence of bad) {
    assert.deepEqual(validateReminderRecord(good({ recurrence })), { ok: false, reason: 'invalid_recurrence' }, JSON.stringify(recurrence));
  }
});

test('valid recurrences are kept and tidied', () => {
  assert.deepEqual(validateReminderRecord(good({ recurrence: { type: 'daysOfWeek', daysOfWeek: [3, 1, 3] } })).record.recurrence, { type: 'daysOfWeek', daysOfWeek: [1, 3] });
  assert.deepEqual(validateReminderRecord(good({ recurrence: { type: 'monthlyDate', dayOfMonth: 31 } })).record.recurrence, { type: 'monthlyDate', dayOfMonth: 31 });
  assert.deepEqual(validateReminderRecord(good({ recurrence: { type: 'once', date: '2026-02-28' } })).record.recurrence, { type: 'once', date: '2026-02-28' });
  assert.deepEqual(validateReminderRecord(good({ recurrence: undefined })).record.recurrence, { type: 'daily' });
});

test('date helper agrees with the calendar', () => {
  assert.equal(isValidDateKey('2024-02-29'), true);
  assert.equal(isValidDateKey('2026-02-29'), false);
  assert.equal(isValidDateKey('2026-04-31'), false);
  assert.equal(isValidDateKey('2026-4-3'), false);
  assert.equal(isValidDateKey(null), false);
});

test('bad or duplicate ids keep the reminder and give it a fresh, unused id', () => {
  const badIds = [undefined, null, 0, -1, 1.5, '7', NaN, MAX_REMINDER_ID + 1, Number.MAX_SAFE_INTEGER, 2 ** 40];
  for (const id of badIds) {
    const r = parseStoredReminders(json([good({ id: 5, name: 'Keeper' }), { ...good({ name: 'Needs id' }), id }]), '6');
    assert.equal(r.reminders.length, 2, String(id));
    const [a, b] = r.reminders;
    assert.equal(a.id, 5);
    assert.ok(Number.isSafeInteger(b.id) && b.id >= 1 && b.id <= MAX_REMINDER_ID && b.id !== 5, String(id));
    assert.deepEqual(r.repaired, [{ id: b.id, fields: ['id'] }]);
    assert.equal(r.status, 'recovered');
  }
});

test('duplicate ids: both reminders are kept, the second gets a new id', () => {
  const r = parseStoredReminders(json([good({ id: 3, name: 'First' }), good({ id: 3, name: 'Second' }), good({ id: 3, name: 'Third' })]), '4');
  assert.deepEqual(r.reminders.map(x => x.name), ['First', 'Second', 'Third']);
  assert.equal(new Set(r.reminders.map(x => x.id)).size, 3);
  assert.equal(r.reminders[0].id, 3);
  assert.ok(r.nextId > Math.max(...r.reminders.map(x => x.id)));
});

test('a fresh id never collides with a set-aside record or the saved counter', () => {
  const r = parseStoredReminders(json([good({ id: 10 }), { ...good({ id: 99 }), time: 'bad' }, { ...good({ id: undefined }), name: 'No id' }]), '50');
  const fresh = r.reminders.find(x => x.name === 'No id').id;
  assert.ok(fresh > 99, 'above the set-aside record id so a restore cannot collide');
  assert.ok(r.nextId > fresh && r.nextId >= 50);
});

test('corrupt optional fields are repaired and reported, the reminder is kept', () => {
  const cases = [
    [{ takenDate: 'yesterday' }, 'takenDate'], [{ takenDate: 20261031 }, 'takenDate'], [{ takenDate: '2026-02-30' }, 'takenDate'],
    [{ lastCompletedDate: 'x' }, 'lastCompletedDate'],
    [{ currentStreak: -1 }, 'currentStreak'], [{ currentStreak: 'many' }, 'currentStreak'], [{ currentStreak: 1.5 }, 'currentStreak'], [{ currentStreak: null }, 'currentStreak'],
    [{ longestStreak: NaN }, 'longestStreak'],
    [{ notes: 42 }, 'notes'], [{ notes: {} }, 'notes'],
    [{ importance: 'urgent' }, 'importance'],
    [{ subtasks: 'nope' }, 'subtasks'], [{ subtasks: { a: 1 } }, 'subtasks'],
    [{ subtasks: [{ id: 1, title: 'ok' }, null, { id: 1, title: 'dup' }, { id: 2, title: '' }] }, 'subtasks'],
  ];
  for (const [over, field] of cases) {
    const v = validateReminderRecord(good(over));
    assert.equal(v.ok, true, JSON.stringify(over));
    assert.ok(v.repairs.includes(field), `${JSON.stringify(over)} -> ${v.repairs}`);
  }
  const fixed = validateReminderRecord(good({ currentStreak: -1, takenDate: 'x', notes: 5, importance: 'urgent', subtasks: 'nope' })).record;
  assert.equal(fixed.currentStreak, 0);
  assert.equal(fixed.takenDate, null);
  assert.equal(fixed.notes, '');
  assert.equal('importance' in fixed, false);
  assert.equal('subtasks' in fixed, false);
});

test('good steps survive; only the bad ones are dropped', () => {
  const v = validateReminderRecord(good({ subtasks: [{ id: 1, title: 'Keep', done: true }, { id: 2, title: 'Also keep' }, 'junk'] }));
  assert.deepEqual(v.record.subtasks, [{ id: 1, title: 'Keep', done: true }, { id: 2, title: 'Also keep', done: false }]);
  assert.deepEqual(v.repairs, ['subtasks']);
});

test('an unknown reminder color quietly means "no color", as it always has', () => {
  const v = validateReminderRecord(good({ color: 'chartreuse' }));
  assert.equal(v.record.color, null);
  assert.deepEqual(v.repairs, []);
});

// ---- the next-id counter ----

test('the next id is always above every id seen, whatever the saved counter says', () => {
  const data = json([good({ id: 7 }), good({ id: 20, name: 'B' })]);
  for (const counter of [null, undefined, '', 'abc', '0', '-3', '1.5', 'NaN', '3', '5']) {
    const r = parseStoredReminders(data, counter);
    assert.equal(r.nextId, 21, String(counter));
  }
  assert.equal(parseStoredReminders(data, '500').nextId, 500);   // a larger saved counter is respected (ids are never reused)
  assert.equal(parseStoredReminders(data, '21').nextIdChanged, false);
  assert.equal(parseStoredReminders(data, 'abc').nextIdChanged, true);
});

test('a counter that is far larger than needed is kept, and one that is too small is corrected', () => {
  assert.equal(parseStoredReminders(json([good({ id: 2 })]), '100').nextIdChanged, false);
  assert.equal(parseStoredReminders(json([good({ id: 2 })]), '1').nextIdChanged, true);
});

// ---- idempotence and scale ----

test('repairing is stable: loading the repaired output again finds nothing wrong', () => {
  const messy = json([null, good({ id: 2 }), good({ id: 2, name: 'dup' }), good({ id: 3, time: '9:05', currentStreak: -4 }), { name: 'no time' }]);
  const first = parseStoredReminders(messy, 'x');
  const second = parseStoredReminders(json(first.reminders), String(first.nextId));
  assert.equal(second.status, 'ok');
  assert.deepEqual(second.reminders, first.reminders);
  assert.equal(second.nextIdChanged, false);
});

test('5,000 reminders with a few bad ones load quickly', () => {
  const list = Array.from({ length: 5000 }, (_, i) => good({ id: i + 1, name: `Task ${i}` }));
  list[10] = null; list[2500] = { id: 2501, name: 'x', time: 'bad' };
  const started = performance.now();
  const r = parseStoredReminders(json(list), '5001');
  assert.ok(performance.now() - started < 500);
  assert.equal(r.reminders.length, 4998);
  assert.equal(r.quarantined.length, 2);
});

test('parsing never throws on hostile input', () => {
  const inputs = ['[' + '['.repeat(500) + ']'.repeat(500) + ']', '{"__proto__":{"a":1}}', '[{"id":{"valueOf":1}}]', 'x'.repeat(10000), '\u0000', '[1e999]'];
  for (const raw of inputs) assert.doesNotThrow(() => parseStoredReminders(raw, '1'), raw.slice(0, 20));
});

// ---- settings ----

test('quiet hours: absent, valid, partial and broken values', () => {
  assert.deepEqual(parseQuietHours(null), { value: DEFAULT_QUIET_HOURS, reset: false });
  assert.deepEqual(parseQuietHours(json({ enabled: true, start: '21:30', end: '6:15' })), { value: { enabled: true, start: '21:30', end: '06:15' }, reset: false });
  assert.deepEqual(parseQuietHours(json({ enabled: true })), { value: { ...DEFAULT_QUIET_HOURS, enabled: true }, reset: false });
  for (const raw of ['{not json', '[1]', '"x"', 'null', json({ enabled: 'yes' }), json({ start: '25:00' }), json({ end: 7 })]) {
    const r = parseQuietHours(raw);
    assert.equal(r.reset, true, raw);
    assert.ok(typeof r.value.enabled === 'boolean' && normalizeTime(r.value.start) && normalizeTime(r.value.end), raw);
  }
});

test('reminder defaults: absent, valid and broken values', () => {
  assert.deepEqual(parseReminderDefaults(undefined), { value: DEFAULT_REMINDER_DEFAULTS, reset: false });
  assert.deepEqual(parseReminderDefaults(json({ gracePeriodHours: 48, soundEnabled: false, defaultColor: 'violet' })).value,
    { gracePeriodHours: 48, soundEnabled: false, defaultColor: 'violet' });
  for (const raw of ['oops', '7', json({ gracePeriodHours: 5 }), json({ soundEnabled: 'on' })]) {
    assert.equal(parseReminderDefaults(raw).reset, true, raw);
  }
  assert.equal(parseReminderDefaults(json({ defaultColor: 'nope' })).value.defaultColor, null);
});

// ---- notices ----

test('notice wording is honest about what happened', () => {
  assert.match(describeNotice({ recovered: 3, quarantined: 2 }), /Recovered 3 reminders and set aside 2 that couldn't be read\. Your original data was saved first\./);
  assert.match(describeNotice({ recovered: 1, quarantined: 0, repaired: 1 }), /^Recovered 1 reminder\./);
  assert.match(describeNotice({ unreadable: true }), /started with an empty list.*original data was saved first/);
  assert.match(describeNotice({ kind: 'recovery_failed' }), /won't save changes/);
  assert.match(describeNotice({ settingsReset: ['x'] }), /setting was invalid/);
  assert.equal(describeNotice(null), '');
});

// ---- the store, end to end against the fake storage ----

test('healthy data: nothing but the one-time version marker is ever written', async () => {
  const prefs = fakePrefs({ [KEYS.reminders]: json([good()]), [KEYS.nextId]: '2' });
  const first = await storageFor(prefs).load();
  assert.equal(first.reminders.length, 1);
  assert.equal(first.notice, null);
  assert.deepEqual(writtenKeys(prefs), [SCHEMA_VERSION_KEY]);
  assert.equal(prefs.store.get(SCHEMA_VERSION_KEY), String(CURRENT_SCHEMA_VERSION));

  prefs.log.length = 0;
  await storageFor(prefs).load();
  assert.deepEqual(prefs.log, [], 'a second launch writes nothing at all');
});

test('a fresh install writes only the version marker', async () => {
  const prefs = fakePrefs();
  const r = await storageFor(prefs).load();
  assert.deepEqual(r.reminders, []);
  assert.equal(r.nextId, 1);
  assert.deepEqual(writtenKeys(prefs), [SCHEMA_VERSION_KEY]);
});

test('damaged data: the exact original is saved FIRST, then the repair', async () => {
  const original = '  [null, {"id":2,"name":"Keep","time":"09:00"}, {"id":3}]  \n';
  const prefs = fakePrefs({ [KEYS.reminders]: original, [KEYS.nextId]: '4' });
  const r = await storageFor(prefs).load();
  const keys = writtenKeys(prefs);
  assert.ok(keys[0].startsWith(BACKUP_KEY_PREFIX), 'the very first write is the backup');
  assert.equal(prefs.store.get(keys[0]), original, 'byte-for-byte the original');
  assert.ok(keys.indexOf(KEYS.reminders) > 0, 'the main key is only rewritten after the backup');
  assert.equal(JSON.parse(prefs.store.get(KEYS.reminders)).length, 1);
  assert.deepEqual(r.reminders.map(x => x.id), [2]);
  assert.equal(r.notice.quarantined, 2);
  assert.equal(r.notice.recovered, 1);
  assert.equal(r.notice.backupKey, keys[0]);
  assert.equal(r.saveAllowed, true);
});

test('set-aside records are kept in their own list, not deleted', async () => {
  const bad = { id: 9, name: 'Mystery', time: 'soon' };
  const prefs = fakePrefs({ [KEYS.reminders]: json([good(), bad]) });
  await storageFor(prefs).load();
  const quarantine = JSON.parse(prefs.store.get(QUARANTINE_KEY));
  assert.equal(quarantine.length, 1);
  assert.deepEqual(quarantine[0].record, bad);
  assert.equal(quarantine[0].reason, 'invalid_time');
});

test('a second recovery adds to the quarantine and never overwrites an earlier backup', async () => {
  const prefs = fakePrefs({ [KEYS.reminders]: json([good(), { id: 8, name: 'A', time: 'x' }]) });
  await storageFor(prefs).load();
  prefs.store.set(KEYS.reminders, json([good(), { id: 9, name: 'B', time: 'y' }]));
  await storageFor(prefs).load(); // same fixed clock => same timestamp: the key must be made unique
  const backups = [...prefs.store.keys()].filter(k => k.startsWith(BACKUP_KEY_PREFIX));
  assert.equal(backups.length, 2);
  assert.equal(new Set(backups).size, 2);
  assert.equal(JSON.parse(prefs.store.get(QUARANTINE_KEY)).length, 2);
});

test('an unreadable quarantine list is moved aside, never overwritten', async () => {
  const prefs = fakePrefs({ [KEYS.reminders]: json([good(), { id: 8, name: 'A', time: 'x' }]), [QUARANTINE_KEY]: '{corrupt' });
  await storageFor(prefs).load();
  const aside = [...prefs.store.entries()].find(([k]) => k.startsWith(`${QUARANTINE_KEY}-unreadable-`));
  assert.ok(aside);
  assert.equal(aside[1], '{corrupt');
  assert.equal(JSON.parse(prefs.store.get(QUARANTINE_KEY)).length, 1);
});

test('whole-value corruption: original backed up, app starts empty, ids are not reused', async () => {
  const prefs = fakePrefs({ [KEYS.reminders]: '{oops', [KEYS.nextId]: '12' });
  const r = await storageFor(prefs).load();
  const backup = [...prefs.store.entries()].find(([k]) => k.startsWith(BACKUP_KEY_PREFIX));
  assert.equal(backup[1], '{oops');
  assert.deepEqual(r.reminders, []);
  assert.equal(r.nextId, 12);
  assert.equal(r.notice.unreadable, true);
  assert.equal(prefs.store.get(KEYS.reminders), '[]');
});

test('if the backup cannot be written, NOTHING else is written and saving is switched off', async () => {
  const original = '[null, {"id":1,"name":"A","time":"09:00"}]';
  const prefs = fakePrefs({ [KEYS.reminders]: original }, { failSet: key => key.startsWith(BACKUP_KEY_PREFIX) });
  const storage = storageFor(prefs);
  const r = await storage.load();
  assert.equal(prefs.store.get(KEYS.reminders), original, 'the original is untouched');
  assert.equal(r.saveAllowed, false);
  assert.equal(r.notice.kind, 'recovery_failed');
  assert.equal(r.reminders.length, 1, 'the good reminder is still usable in memory');
  const attempt = await storage.saveReminders(r.reminders);
  assert.deepEqual(attempt, { saved: false, reason: 'blocked' });
  assert.equal(prefs.store.get(KEYS.reminders), original, 'a blocked save cannot overwrite');
});

test('if the repaired list cannot be written, the original stays and saving is switched off', async () => {
  const original = '[null, {"id":1,"name":"A","time":"09:00"}]';
  const prefs = fakePrefs({ [KEYS.reminders]: original }, { failSet: key => key === KEYS.reminders });
  const storage = storageFor(prefs);
  const r = await storage.load();
  assert.equal(r.saveAllowed, false);
  assert.equal(prefs.store.get(KEYS.reminders), original);
  assert.ok([...prefs.store.keys()].some(k => k.startsWith(BACKUP_KEY_PREFIX)), 'the backup exists');
  assert.equal((await storage.saveNextId(5)).saved, false);
});

test('if storage cannot even be read, nothing is touched and saving is off', async () => {
  const prefs = fakePrefs({ [KEYS.reminders]: json([good()]) }, { failGet: key => key === KEYS.reminders });
  const storage = storageFor(prefs);
  const r = await storage.load();
  assert.deepEqual(r.reminders, []);
  assert.equal(r.saveAllowed, false);
  assert.equal(r.notice.kind, 'storage_unreadable');
  assert.deepEqual(prefs.log, []);
  assert.equal((await storage.saveReminders([])).reason, 'blocked');
});

test('normal saves work, and a failing write is reported rather than thrown', async () => {
  const prefs = fakePrefs({ [KEYS.reminders]: json([good()]), [KEYS.nextId]: '2' });
  const storage = storageFor(prefs);
  await storage.load();
  assert.deepEqual(await storage.saveReminders([good({ id: 1 }), good({ id: 2 })]), { saved: true });
  assert.equal(JSON.parse(prefs.store.get(KEYS.reminders)).length, 2);
  const failing = fakePrefs({}, { failSet: key => key === KEYS.reminders });
  const result = await storageFor(failing).saveReminders([]);
  assert.equal(result.saved, false);
  assert.equal(result.reason, 'write_failed');
});

test('a counter fix on otherwise healthy data is written quietly, without a notice', async () => {
  const prefs = fakePrefs({ [KEYS.reminders]: json([good({ id: 6 })]), [KEYS.nextId]: 'abc' });
  const r = await storageFor(prefs).load();
  assert.equal(prefs.store.get(KEYS.nextId), '7');
  assert.equal(r.notice, null);
  assert.ok(!writtenKeys(prefs).some(k => k.startsWith(BACKUP_KEY_PREFIX)));
});

test('the notice stays until dismissed, across launches', async () => {
  const prefs = fakePrefs({ [KEYS.reminders]: json([null, good()]) });
  const first = await storageFor(prefs).load();
  assert.ok(first.notice);
  const second = await storageFor(prefs).load(); // the data is clean now, but the user has not seen the message yet
  assert.equal(second.notice.quarantined, 1);
  await storageFor(prefs).dismissNotice();
  assert.equal((await storageFor(prefs).load()).notice, null);
});

test('a newer schema version marker is never lowered', async () => {
  const prefs = fakePrefs({ [KEYS.reminders]: json([null, good()]), [SCHEMA_VERSION_KEY]: '5' });
  await storageFor(prefs).load();
  assert.equal(prefs.store.get(SCHEMA_VERSION_KEY), '5');
});

test('existing storage keys are never renamed: only known keys are ever written', async () => {
  const prefs = fakePrefs({ [KEYS.reminders]: json([null, good(), { id: 3, name: 'x', time: 'bad' }]), [KEYS.nextId]: 'junk', [QUARANTINE_KEY]: '{x' });
  await storageFor(prefs).load();
  const allowed = k => [KEYS.reminders, KEYS.nextId, SCHEMA_VERSION_KEY, QUARANTINE_KEY, NOTICE_KEY].includes(k)
    || k.startsWith(BACKUP_KEY_PREFIX) || k.startsWith(`${QUARANTINE_KEY}-unreadable-`);
  for (const key of writtenKeys(prefs)) assert.ok(allowed(key), key);
});

test('settings: an unusable value is backed up, reset in memory, rewritten with defaults, and reported once', async () => {
  const prefs = fakePrefs({ 'tally-quiet-hours': '{broken' });
  const storage = storageFor(prefs);
  const first = await storage.loadSetting('tally-quiet-hours', parseQuietHours);
  assert.equal(first.reset, true);
  assert.deepEqual(first.value, DEFAULT_QUIET_HOURS);
  const backup = [...prefs.store.entries()].find(([k]) => k.startsWith(SETTINGS_BACKUP_KEY_PREFIX));
  assert.equal(backup[1], '{broken');
  assert.deepEqual((await storage.getNotice()).settingsReset, ['tally-quiet-hours']);

  const second = await storage.loadSetting('tally-quiet-hours', parseQuietHours);
  assert.equal(second.reset, false, 'the defaults were written back, so this does not repeat every launch');
  assert.equal([...prefs.store.keys()].filter(k => k.startsWith(SETTINGS_BACKUP_KEY_PREFIX)).length, 1);
});

test('settings: a missing or valid value writes nothing', async () => {
  const prefs = fakePrefs({ 'tally-reminder-defaults': json({ gracePeriodHours: 12, soundEnabled: true, defaultColor: null }) });
  const storage = storageFor(prefs);
  assert.equal((await storage.loadSetting('tally-reminder-defaults', parseReminderDefaults)).value.gracePeriodHours, 12);
  assert.equal((await storage.loadSetting('tally-quiet-hours', parseQuietHours)).reset, false);
  assert.deepEqual(prefs.log, []);
});

test('end to end: load, add, save, reload keeps everything', async () => {
  const prefs = fakePrefs({ [KEYS.reminders]: json([good({ id: 1 })]), [KEYS.nextId]: '2' });
  const storage = storageFor(prefs);
  const loaded = await storage.load();
  const added = [...loaded.reminders, good({ id: loaded.nextId, name: 'New one' })];
  await storage.saveReminders(added);
  await storage.saveNextId(loaded.nextId + 1);
  const again = await storageFor(prefs).load();
  assert.deepEqual(again.reminders.map(r => r.name), ['Take vitamins', 'New one']);
  assert.equal(again.nextId, 3);
  assert.equal(again.notice, null);
});
