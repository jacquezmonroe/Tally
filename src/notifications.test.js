// Tests for the notification reconcile engine.
// Anything using fakePlugin is a MOCK of the iOS plugin (see notifications.fake.js):
// it proves our logic and error handling, not what a real iPhone does.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  notificationId,
  decodeNotificationId,
  soundFor,
  desiredNotifications,
  buildSnooze,
  planChanges,
  reconcile,
  cancelAllPending,
  ensureSchemeMigrated,
  createNotifier,
  SLOT_MAIN,
  SLOT_SNOOZE,
  SCHEME_KEY,
  SCHEME_VERSION,
} from './notifications.js';
import { MAX_REMINDER_ID } from './storage.js';
import { fakePlugin, fakePrefs } from './notifications.fake.js';

const NOW = new Date(2026, 9, 31, 14, 0); // Sat Oct 31 2026, 2:00 PM local
const TODAY = '2026-10-31';
const SETTINGS = { soundEnabled: true, quietHours: { enabled: false, start: '22:00', end: '07:00' } };
const rem = (id, extra = {}) => ({ id, name: `Task ${id}`, time: '09:00', takenDate: null, recurrence: { type: 'daily' }, ...extra });
const weekly = (id, days, extra = {}) => rem(id, { recurrence: { type: 'daysOfWeek', daysOfWeek: days }, ...extra });
const monthly = (id, day, extra = {}) => rem(id, { recurrence: { type: 'monthlyDate', dayOfMonth: day }, ...extra });
const once = (id, date, extra = {}) => rem(id, { recurrence: { type: 'once', date }, ...extra });
const desired = (reminders, over = {}) => desiredNotifications({ reminders, settings: SETTINGS, userName: 'Jacquez', now: NOW, random: () => 0, ...over });
const run = (plugin, reminders, over = {}) => reconcile({ plugin, reminders, settings: SETTINGS, userName: 'Jacquez', now: NOW, random: () => 0, ...over });

// ---- IDs ----

test('id = reminderId * 16 + slot, and decodes back', () => {
  assert.equal(notificationId(1, 0), 16);
  assert.equal(notificationId(1, 7), 23);
  assert.equal(notificationId(100, SLOT_SNOOZE), 1608);
  assert.deepEqual(decodeNotificationId(1608), { reminderId: 100, slot: SLOT_SNOOZE });
  for (const reminderId of [1, 2, 99, 100, 101, 12345, MAX_REMINDER_ID]) {
    for (let slot = 0; slot < 16; slot++) {
      assert.deepEqual(decodeNotificationId(notificationId(reminderId, slot)), { reminderId, slot });
    }
  }
});

test('the largest possible id is exactly the 32-bit limit', () => {
  assert.equal(notificationId(MAX_REMINDER_ID, 15), 2 ** 31 - 1);
  assert.throws(() => notificationId(MAX_REMINDER_ID + 1, 0), RangeError);
});

test('out-of-range inputs are rejected, not silently wrapped', () => {
  for (const reminderId of [0, -1, 1.5, NaN, '3', null, undefined, Number.MAX_SAFE_INTEGER]) assert.throws(() => notificationId(reminderId, 0), RangeError, String(reminderId));
  for (const slot of [-1, 16, 1.5, NaN]) assert.throws(() => notificationId(5, slot), RangeError, String(slot));
});

test('numbers that cannot be one of our ids do not decode', () => {
  for (const id of [0, 1, 15, -16, 1.5, NaN, 2 ** 31, 'x', null]) assert.equal(decodeNotificationId(id), null, String(id));
});

test('REGRESSION: the old scheme collided, the new one cannot', () => {
  const oldIds = r => (r.recurrence.type === 'daysOfWeek' ? r.recurrence.daysOfWeek.map(d => r.id * 100 + d) : [r.id]);
  const weeklyOne = weekly(1, [0, 1]);   // old ids 100, 101
  const dailyHundred = rem(100);         // old id 100
  const dailyHundredOne = rem(101);      // old id 101
  const oldAll = [...oldIds(weeklyOne), ...oldIds(dailyHundred), ...oldIds(dailyHundredOne)];
  assert.ok(new Set(oldAll).size < oldAll.length, 'the old scheme really did collide');

  const ids = desired([weeklyOne, dailyHundred, dailyHundredOne]).items.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('ids stay unique across every recurrence type, snooze included, at small, medium and huge reminder ids', () => {
  const reminders = [];
  const anchors = [1, 2, 7, 99, 100, 101, 1000, 99999, 1000000, 100000000, MAX_REMINDER_ID - 1, MAX_REMINDER_ID];
  for (const id of anchors) {
    reminders.push(rem(id), weekly(id + 0.5 === id ? id : id, [0, 1, 2, 3, 4, 5, 6]));
  }
  // one reminder of each type per distinct id (a reminder only has one recurrence)
  const mixed = [];
  anchors.forEach((id, i) => {
    const kind = i % 4;
    mixed.push(kind === 0 ? rem(id) : kind === 1 ? weekly(id, [0, 1, 2, 3, 4, 5, 6]) : kind === 2 ? monthly(id, 15) : once(id, '2026-12-25'));
  });
  for (let id = 1; id <= 400; id++) mixed.push(id % 3 === 0 ? weekly(id + 1000, [0, 6]) : id % 3 === 1 ? rem(id + 1000) : monthly(id + 1000, 31));
  const all = desired(mixed).items.map(i => i.id);
  mixed.forEach(r => all.push(buildSnooze({ reminder: r, settings: SETTINGS, userName: null, now: NOW }).id));
  assert.equal(new Set(all).size, all.length, 'no two alerts share an id');
  assert.ok(all.every(id => Number.isInteger(id) && id >= 0 && id <= 2 ** 31 - 1), 'every id fits in 32 bits');
});

test('a weekly reminder uses one slot per day, matching the plugin weekday numbers', () => {
  const items = desired([weekly(5, [1, 3, 5])]).items;
  assert.deepEqual(items.map(i => i.slot), [2, 4, 6]);
  assert.deepEqual(items.map(i => i.notification.schedule.on.weekday), [2, 4, 6]);
  assert.deepEqual(items.map(i => i.id), [5 * 16 + 2, 5 * 16 + 4, 5 * 16 + 6]);
});

// ---- what each alert contains ----

test('daily, monthly, one-time and weekly alerts get the right schedule', () => {
  const byType = Object.fromEntries(desired([rem(1), monthly(2, 31), once(3, '2026-12-25'), weekly(4, [6])]).items.map(i => [i.reminderId, i.notification]));
  assert.deepEqual(byType[1].schedule, { on: { hour: 9, minute: 0 }, allowWhileIdle: true });
  assert.deepEqual(byType[2].schedule, { on: { day: 31, hour: 9, minute: 0 }, allowWhileIdle: true });
  assert.deepEqual(byType[4].schedule, { on: { weekday: 7, hour: 9, minute: 0 }, allowWhileIdle: true });
  assert.equal(byType[3].schedule.at.getFullYear(), 2026);
  assert.equal(byType[3].schedule.at.getMonth(), 11);
  assert.equal(byType[3].schedule.at.getDate(), 25);
  assert.equal(byType[3].schedule.at.getHours(), 9);
});

test('every alert carries the title, badge, action button and its reminder id plus fingerprint', () => {
  for (const { notification, reminderId, fingerprint } of desired([rem(8), weekly(9, [2])]).items) {
    assert.equal(notification.title, 'Tickmark');
    assert.equal(notification.badge, 1);
    assert.equal(notification.actionTypeId, 'REMINDER');
    assert.deepEqual(notification.extra, { reminderId, fp: fingerprint });
    assert.match(notification.body, /Task/);
  }
});

test('sound: on by default, silent when sound is off, silent inside quiet hours but still scheduled', () => {
  const night = rem(1, { time: '23:30' });
  const day = rem(2, { time: '12:00' });
  const sound = settings => Object.fromEntries(desired([night, day], { settings }).items.map(i => [i.reminderId, 'sound' in i.notification]));
  assert.deepEqual(sound(SETTINGS), { 1: true, 2: true });
  assert.deepEqual(sound({ ...SETTINGS, soundEnabled: false }), { 1: false, 2: false });
  const quiet = { ...SETTINGS, quietHours: { enabled: true, start: '22:00', end: '07:00' } };
  assert.deepEqual(sound(quiet), { 1: false, 2: true });
  assert.equal(desired([night], { settings: quiet }).items.length, 1, 'quiet hours silence the alert, they never drop or delay it');
  assert.equal(soundFor(23, 30, quiet), null);
  assert.equal(soundFor(12, 0, quiet), 'default');
});

test('expired one-time reminders have no alert; unschedulable ones are reported, not thrown on', () => {
  const r = desired([once(1, '2026-10-30'), once(2, '2026-10-31', { time: '13:00' }), once(3, '2026-10-31', { time: '15:00' }), rem(4)]);
  assert.deepEqual(r.items.map(i => i.reminderId), [3, 4]);
  const bad = desired([rem(5, { time: 'nope' }), { ...rem(6), id: MAX_REMINDER_ID + 1 }, { ...rem(7), id: 0 }, rem(8)]);
  assert.deepEqual(bad.items.map(i => i.reminderId), [8]);
  assert.deepEqual(bad.problems.map(p => p.reason), ['unschedulable', 'unschedulable', 'unschedulable']);
});

test('the fingerprint ignores the random wording but notices anything that matters', () => {
  const fp = (reminder, over = {}) => desired([reminder], over).items[0].fingerprint;
  const base = rem(1);
  assert.equal(fp(base, { random: () => 0 }), fp(base, { random: () => 0.99 }), 'a different random greeting is not a change');
  assert.notEqual(fp(base), fp(rem(1, { name: 'Renamed' })));
  assert.notEqual(fp(base), fp(rem(1, { time: '09:01' })));
  assert.notEqual(fp(base), fp(weekly(1, [1])));
  assert.notEqual(fp(base), fp(base, { userName: 'Sam' }));
  assert.notEqual(fp(base), fp(base, { settings: { ...SETTINGS, soundEnabled: false } }));
  assert.equal(fp(base), fp(rem(1, { notes: 'unrelated', color: 'coral', importance: 'high' })), 'fields that do not affect the alert do not cause rescheduling');
});

test('snooze: one-time, minutes ahead, its own slot, same sound rules and button', () => {
  const s = buildSnooze({ reminder: rem(12), settings: SETTINGS, userName: null, now: NOW, minutes: 10 });
  assert.equal(s.id, 12 * 16 + 8);
  assert.equal(s.schedule.at.getTime(), NOW.getTime() + 10 * 60000);
  assert.equal(s.actionTypeId, 'REMINDER');
  assert.equal(s.sound, 'default');
  const quiet = { ...SETTINGS, quietHours: { enabled: true, start: '14:00', end: '15:00' } };
  assert.equal('sound' in buildSnooze({ reminder: rem(12), settings: quiet, userName: null, now: NOW }), false);
});

// ---- the diff ----

const pendingFrom = (items, over = {}) => items.map(i => ({ id: i.id, title: 'Tickmark', body: 'x', extra: { reminderId: i.reminderId, fp: i.fingerprint }, ...over }));

test('planChanges: unchanged stays, changed or missing is scheduled, extra is cancelled', () => {
  const reminders = [rem(1), rem(2), rem(3)];
  const { items } = desired(reminders);
  const pending = [
    ...pendingFrom([items[0]]),                                                   // matches: unchanged
    { id: items[1].id, title: 'Tickmark', body: 'x', extra: { reminderId: 2, fp: 'stale' } }, // out of date
    { id: 999 * 16, title: 'Tickmark', body: 'x', extra: { reminderId: 999 } },     // reminder no longer exists
  ];
  const plan = planChanges({ desired: items, pending, reminders, now: NOW });
  assert.deepEqual(plan.unchanged.map(i => i.reminderId), [1]);
  assert.deepEqual(plan.toSchedule.map(i => i.reminderId), [2, 3]);
  assert.deepEqual(plan.toCancel, [999 * 16]);
});

test('planChanges: an old-format alert with no fingerprint is rescheduled', () => {
  const { items } = desired([rem(1)]);
  const plan = planChanges({ desired: items, pending: [{ id: items[0].id, title: 'Tickmark', body: 'x', extra: { reminderId: 1 } }], reminders: [rem(1)], now: NOW });
  assert.equal(plan.toSchedule.length, 1);
});

test('planChanges: a snooze is kept only while it is still wanted', () => {
  const r = rem(4);
  const id = 4 * 16 + 8;
  const at = new Date(NOW.getTime() + 5 * 60000).toISOString();
  const keep = (reminders, schedule) => planChanges({ desired: [], pending: [{ id, title: 't', body: 'b', schedule, extra: { reminderId: 4, fp: 'snooze' } }], reminders, now: NOW });
  assert.deepEqual(keep([r], { at }).keptSnoozes, [id]);
  assert.deepEqual(keep([r], { at }).toCancel, []);
  assert.deepEqual(keep([], { at }).toCancel, [id], 'reminder deleted');
  assert.deepEqual(keep([{ ...r, takenDate: TODAY }], { at }).toCancel, [id], 'reminder done today');
  assert.deepEqual(keep([r], { at: new Date(NOW.getTime() - 60000).toISOString() }).toCancel, [id], 'snooze time already passed');
});

// ---- reconcile against the fake plugin (MOCK) ----

test('first run schedules everything; the pending set equals the desired set', async () => {
  const plugin = fakePlugin();
  const reminders = [rem(1), weekly(2, [1, 3, 5]), monthly(3, 15), once(4, '2026-12-25')];
  const result = await run(plugin, reminders);
  assert.equal(result.ok, true);
  assert.equal(result.permission, 'granted');
  assert.deepEqual(result.scheduled.sort(), [1, 2, 3, 4]);
  assert.deepEqual(plugin.pendingIds(), desired(reminders).items.map(i => i.id).sort((a, b) => a - b));
  assert.equal(plugin.registered, 1, 'the Mark Taken button is registered on every pass');
});

test('IDEMPOTENT: a second run changes nothing, even with different random wording', async () => {
  const plugin = fakePlugin();
  const reminders = [rem(1), weekly(2, [0, 6])];
  await run(plugin, reminders, { random: () => 0.1 });
  const before = JSON.stringify([...plugin.pending]);
  plugin.resetCalls();
  const again = await run(plugin, reminders, { random: () => 0.9 });
  assert.equal(again.ok, true);
  assert.deepEqual(again.scheduled, []);
  assert.deepEqual(again.cancelled, []);
  assert.equal(plugin.callCount('schedule'), 0);
  assert.equal(plugin.callCount('cancel'), 0);
  assert.equal(JSON.stringify([...plugin.pending]), before);
});

test('editing one reminder reschedules only that one', async () => {
  const plugin = fakePlugin();
  await run(plugin, [rem(1), rem(2), rem(3)]);
  plugin.resetCalls();
  const r = await run(plugin, [rem(1), rem(2, { time: '10:30' }), rem(3)]);
  assert.deepEqual(r.scheduled, [2]);
  assert.deepEqual(r.unchanged.sort(), [1, 3]);
  assert.deepEqual(plugin.pending.get(String(2 * 16)).schedule.on, { hour: 10, minute: 30 });
});

test('switching weekly to daily removes the weekday alerts: no orphans', async () => {
  const plugin = fakePlugin();
  await run(plugin, [weekly(5, [1, 3, 5])]);
  assert.equal(plugin.pending.size, 3);
  const r = await run(plugin, [rem(5)]);
  assert.deepEqual(plugin.pendingIds(), [5 * 16]);
  assert.deepEqual(r.cancelled.sort((a, b) => a - b), [5 * 16 + 2, 5 * 16 + 4, 5 * 16 + 6]);
});

test('removing one weekday only removes that weekday', async () => {
  const plugin = fakePlugin();
  await run(plugin, [weekly(5, [1, 3, 5])]);
  await run(plugin, [weekly(5, [1, 5])]);
  assert.deepEqual(plugin.pendingIds(), [5 * 16 + 2, 5 * 16 + 6]);
});

test('deleting a reminder removes all its alerts and leaves others alone', async () => {
  const plugin = fakePlugin();
  await run(plugin, [weekly(1, [0, 1, 2]), rem(100), rem(101)]);
  await run(plugin, [rem(100), rem(101)]);
  assert.deepEqual(plugin.pendingIds(), [100 * 16, 101 * 16], 'removing weekly #1 does not touch daily #100 or #101');
});

test('a one-time reminder that has passed is cleaned up', async () => {
  const plugin = fakePlugin();
  const r = once(1, '2026-10-31', { time: '15:00' });
  await run(plugin, [r], { now: NOW });
  assert.equal(plugin.pending.size, 1);
  const later = new Date(2026, 9, 31, 15, 30);
  await run(plugin, [r], { now: later });
  assert.equal(plugin.pending.size, 0);
});

test('SETTINGS CHANGE: turning sound off silences alerts that were already scheduled', async () => {
  const plugin = fakePlugin();
  const reminders = [rem(1), rem(2)];
  await run(plugin, reminders);
  assert.ok([...plugin.pending.values()].every(n => n.sound === 'default'));
  plugin.resetCalls();
  const r = await run(plugin, reminders, { settings: { ...SETTINGS, soundEnabled: false } });
  assert.deepEqual(r.scheduled.sort(), [1, 2], 'getPending hides sound, so the fingerprint is what noticed the change');
  assert.ok([...plugin.pending.values()].every(n => !('sound' in n)));
  const back = await run(plugin, reminders, { settings: SETTINGS });
  assert.ok([...plugin.pending.values()].every(n => n.sound === 'default'));
  assert.deepEqual(back.scheduled.sort(), [1, 2]);
});

test('SETTINGS CHANGE: quiet hours silence only alerts inside the window, and still deliver them', async () => {
  const plugin = fakePlugin();
  const reminders = [rem(1, { time: '23:00' }), rem(2, { time: '12:00' }), rem(3, { time: '06:30' })];
  await run(plugin, reminders);
  const quiet = { ...SETTINGS, quietHours: { enabled: true, start: '22:00', end: '07:00' } };
  const r = await run(plugin, reminders, { settings: quiet });
  assert.deepEqual(r.scheduled.sort(), [1, 3], 'only the two inside 22:00-07:00 changed');
  assert.deepEqual(r.unchanged, [2]);
  assert.equal(plugin.pending.size, 3, 'nothing was dropped');
  assert.equal('sound' in plugin.pending.get(String(1 * 16)), false);
  assert.equal(plugin.pending.get(String(2 * 16)).sound, 'default');
  const moved = await run(plugin, reminders, { settings: { ...quiet, quietHours: { enabled: true, start: '11:00', end: '13:00' } } });
  assert.deepEqual(moved.scheduled.sort(), [1, 2, 3], 'sound returns to the first and third; the middle one goes silent');
  assert.equal('sound' in plugin.pending.get(String(2 * 16)), false);
});

test('a name change updates alert wording', async () => {
  const plugin = fakePlugin();
  await run(plugin, [rem(1)], { userName: null });
  const r = await run(plugin, [rem(1)], { userName: 'Jacquez' });
  assert.deepEqual(r.scheduled, [1]);
});

test('snooze survives reconcile, then goes away when the reminder is done, deleted or the time passes', async () => {
  const plugin = fakePlugin();
  const reminders = [rem(1), rem(2)];
  await run(plugin, reminders);
  const notifier = createNotifier({ plugin, prefs: fakePrefs(), getReminders: () => reminders, getSettings: () => SETTINGS, getUserName: () => null, now: () => NOW, random: () => 0 });
  assert.deepEqual(await notifier.snooze(reminders[0]), { ok: true });
  assert.ok(plugin.pending.has(String(1 * 16 + 8)));
  await run(plugin, reminders);
  assert.ok(plugin.pending.has(String(1 * 16 + 8)), 'kept');

  await run(plugin, [{ ...reminders[0], takenDate: TODAY }, reminders[1]]);
  assert.equal(plugin.pending.has(String(1 * 16 + 8)), false, 'cancelled once the reminder is done today');

  await notifier.snooze(reminders[1]);
  await run(plugin, [reminders[0]]);
  assert.equal(plugin.pending.has(String(2 * 16 + 8)), false, 'cancelled with its deleted reminder');
});

// ---- permission ----

test('denied permission is a visible failure for every reminder, and nothing is scheduled', async () => {
  const plugin = fakePlugin({ permission: 'denied' });
  const r = await run(plugin, [rem(1), weekly(2, [1, 2]), once(3, '2026-10-01')]);
  assert.equal(r.permission, 'denied');
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed.map(f => [f.reminderId, f.reason]), [[1, 'permission_denied'], [2, 'permission_denied']], 'the expired one-time has nothing to alert about, so it is not listed');
  assert.equal(plugin.callCount('schedule'), 0);
  assert.equal(plugin.callCount('cancel'), 0);
});

test('"not asked yet" schedules nothing and is not reported as a failure', async () => {
  for (const permission of ['prompt', 'prompt-with-rationale']) {
    const plugin = fakePlugin({ permission });
    const r = await run(plugin, [rem(1)]);
    assert.equal(r.permission, 'prompt');
    assert.deepEqual(r.failed, []);
    assert.equal(plugin.callCount('schedule'), 0);
  }
});

test('with no plugin (a plain browser) there is nothing to do and nothing is reported', async () => {
  const plugin = fakePlugin();
  plugin.failPermission = true;
  const r = await run(plugin, [rem(1)]);
  assert.equal(r.permission, 'unavailable');
  assert.equal(r.ok, true);
  assert.deepEqual(r.failed, []);
});

test('granting permission later schedules everything on the next run', async () => {
  const plugin = fakePlugin({ permission: 'prompt' });
  await run(plugin, [rem(1), rem(2)]);
  assert.equal(plugin.pending.size, 0);
  plugin.permission = 'granted';
  const r = await run(plugin, [rem(1), rem(2)]);
  assert.equal(r.ok, true);
  assert.equal(plugin.pending.size, 2);
});

// ---- failures ----

test('a scheduling failure is reported per reminder; the others still succeed', async () => {
  const plugin = fakePlugin();
  plugin.failSchedule = n => n.extra.reminderId === 2;
  const r = await run(plugin, [rem(1), rem(2), rem(3)]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed.map(f => [f.reminderId, f.reason]), [[2, 'schedule_failed']]);
  assert.match(r.failed[0].message, /schedule failed/);
  assert.deepEqual(r.scheduled.sort(), [1, 3]);
  assert.deepEqual(plugin.pendingIds(), [16, 48]);
});

test('RETRY is safe: after the cause is fixed it completes with no duplicates', async () => {
  const plugin = fakePlugin();
  const reminders = [rem(1), weekly(2, [1, 2, 3]), rem(3)];
  plugin.failSchedule = n => n.extra.reminderId === 2;
  await run(plugin, reminders);
  plugin.failSchedule = () => false;
  const retry = await run(plugin, reminders);
  assert.equal(retry.ok, true);
  assert.deepEqual(retry.scheduled, [2], 'only the one that was missing is scheduled');
  assert.equal(plugin.pending.size, 5);
  const third = await run(plugin, reminders);
  assert.equal(plugin.pending.size, 5, 'running again adds nothing');
  assert.deepEqual(third.scheduled, []);
});

test('a failed schedule leaves any older alert for that reminder exactly as it was', async () => {
  const plugin = fakePlugin();
  await run(plugin, [rem(1)]);
  plugin.failSchedule = () => true;
  const r = await run(plugin, [rem(1, { time: '10:00' })]);
  assert.equal(r.ok, false);
  assert.deepEqual(plugin.pending.get('16').schedule.on, { hour: 9, minute: 0 });
});

test('a failed cancel is reported against the reminder and fixed by retry', async () => {
  const plugin = fakePlugin();
  await run(plugin, [weekly(5, [1, 3, 5])]);
  plugin.failCancel = () => true;
  const r = await run(plugin, [rem(5)]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed.map(f => [f.reminderId, f.reason]), [[5, 'cancel_failed']]);
  assert.equal(r.failedCancels.length, 3);
  assert.equal(plugin.pending.size, 4, 'the old weekday alerts are still there: the user is told');
  plugin.failCancel = () => false;
  const retry = await run(plugin, [rem(5)]);
  assert.equal(retry.ok, true);
  assert.deepEqual(plugin.pendingIds(), [5 * 16]);
});

test('if the pending list cannot be read, alerts are still scheduled and cleanup is flagged', async () => {
  const plugin = fakePlugin();
  plugin.failPending = true;
  const r = await run(plugin, [rem(1)]);
  assert.equal(r.cleanupSkipped, true);
  assert.deepEqual(r.scheduled, [1]);
  assert.equal(plugin.pending.size, 1);
});

test('a failure registering the Mark Taken button does not stop alerts', async () => {
  const plugin = fakePlugin();
  plugin.failRegister = true;
  const r = await run(plugin, [rem(1)]);
  assert.equal(r.ok, true);
  assert.equal(plugin.pending.size, 1);
});

test('a reminder with an id too large for the scheme is reported and the rest still work', async () => {
  const plugin = fakePlugin();
  const r = await run(plugin, [{ ...rem(1), id: MAX_REMINDER_ID + 5 }, rem(2)]);
  assert.deepEqual(r.failed.map(f => f.reason), ['unschedulable']);
  assert.deepEqual(plugin.pendingIds(), [32]);
});

test('reconcile never throws, whatever the plugin does', async () => {
  const hostile = {
    checkPermissions: async () => ({ display: 'granted' }),
    registerActionTypes: async () => { throw new Error('x'); },
    getPending: async () => ({ notifications: null }),
    schedule: async () => { throw new Error('y'); },
    cancel: async () => { throw new Error('z'); },
  };
  const r = await run(hostile, [rem(1)]);
  assert.equal(r.ok, false);
  const odd = { checkPermissions: async () => null, getPending: async () => { throw 1; }, schedule: async () => { throw null; } };
  await assert.doesNotReject(run(odd, [rem(1)]));
});

// ---- upgrade cleanup (MOCK) ----

const OLD_PENDING = [1, 100, 101, 201, 1000000005, 1000000100].map(id => ({ id, title: 'Tickmark', body: 'old', extra: { reminderId: 1 } }));
const seedOld = plugin => OLD_PENDING.forEach(n => plugin.pending.set(String(n.id), n));

test('UPGRADE: every old-scheme alert is removed, then reconcile leaves exactly the right ones', async () => {
  const plugin = fakePlugin();
  seedOld(plugin);
  const prefs = fakePrefs();
  const migrated = await ensureSchemeMigrated({ plugin, prefs });
  assert.deepEqual(migrated, { ran: true, ok: true, cancelled: 6 });
  assert.equal(plugin.pending.size, 0);
  assert.equal(prefs.store.get(SCHEME_KEY), String(SCHEME_VERSION));
  const reminders = [rem(1), weekly(2, [1, 2]), rem(100)];
  await run(plugin, reminders);
  assert.deepEqual(plugin.pendingIds(), desired(reminders).items.map(i => i.id).sort((a, b) => a - b), 'no duplicates, no orphans');
});

test('UPGRADE: it only runs once', async () => {
  const plugin = fakePlugin();
  const prefs = fakePrefs();
  await ensureSchemeMigrated({ plugin, prefs });
  seedOld(plugin);
  const second = await ensureSchemeMigrated({ plugin, prefs });
  assert.deepEqual(second, { ran: false, ok: true, cancelled: 0 });
  assert.equal(plugin.pending.size, 6, 'a later launch does not wipe alerts again');
});

test('UPGRADE: if removal fails the marker is NOT written, so the next launch tries again', async () => {
  const plugin = fakePlugin();
  seedOld(plugin);
  const prefs = fakePrefs();
  plugin.failCancel = () => true;
  const first = await ensureSchemeMigrated({ plugin, prefs });
  assert.equal(first.ok, false);
  assert.equal(prefs.store.has(SCHEME_KEY), false);
  plugin.failCancel = () => false;
  const second = await ensureSchemeMigrated({ plugin, prefs });
  assert.deepEqual(second, { ran: true, ok: true, cancelled: 6 });
  assert.equal(prefs.store.get(SCHEME_KEY), '2');
});

test('UPGRADE: an unreadable pending list or an unwritable marker is a retry, never a crash', async () => {
  const noList = fakePlugin();
  noList.failPending = true;
  assert.equal((await ensureSchemeMigrated({ plugin: noList, prefs: fakePrefs() })).ok, false);
  const badPrefs = fakePrefs({}, { failSet: () => true });
  const r = await ensureSchemeMigrated({ plugin: fakePlugin(), prefs: badPrefs });
  assert.equal(r.ok, false);
});

test('cancelAllPending on an empty phone is fine', async () => {
  assert.deepEqual(await cancelAllPending(fakePlugin()), { ok: true, cancelled: 0 });
});

// ---- one reconcile at a time ----

test('overlapping reconcile calls never overlap in the plugin and always end correct', async () => {
  const plugin = fakePlugin();
  let reminders = [rem(1)];
  const notifier = createNotifier({ plugin, prefs: fakePrefs(), getReminders: () => reminders, getSettings: () => SETTINGS, getUserName: () => null, now: () => NOW, random: () => 0 });
  const first = notifier.reconcile();
  reminders = [rem(1), rem(2)];
  const second = notifier.reconcile();
  reminders = [rem(1), rem(2), rem(3)];
  const third = notifier.reconcile();
  await Promise.all([first, second, third]);
  assert.equal(plugin.maxActive, 1, 'never two plugin calls at once');
  assert.deepEqual(plugin.pendingIds(), [16, 32, 48], 'the last run saw the latest data');
});

test('a burst of calls is folded into at most one follow-up run', async () => {
  const plugin = fakePlugin();
  const notifier = createNotifier({ plugin, prefs: fakePrefs(), getReminders: () => [rem(1)], getSettings: () => SETTINGS, getUserName: () => null, now: () => NOW, random: () => 0 });
  await Promise.all(Array.from({ length: 8 }, () => notifier.reconcile()));
  assert.ok(plugin.callCount('getPending') <= 2, `ran ${plugin.callCount('getPending')} times`);
});

// ---- snooze results ----

test('snooze reports why it could not be scheduled', async () => {
  const make = plugin => createNotifier({ plugin, prefs: fakePrefs(), getReminders: () => [rem(1)], getSettings: () => SETTINGS, getUserName: () => null, now: () => NOW });
  assert.deepEqual(await make(fakePlugin({ permission: 'denied' })).snooze(rem(1)), { ok: false, reason: 'permission_denied' });
  const unavailable = fakePlugin();
  unavailable.failPermission = true;
  assert.deepEqual(await make(unavailable).snooze(rem(1)), { ok: false, reason: 'unavailable' });
  const failing = fakePlugin();
  failing.failSchedule = () => true;
  const r = await make(failing).snooze(rem(1));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'schedule_failed');
});

// ---- no network, storage or UI in the engine ----

test('the engine touches no network or browser storage', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./notifications.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /localStorage/, /https?:\/\//, /document\./, /window\./]) assert.doesNotMatch(source, pattern);
});
