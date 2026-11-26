// Tests the REAL add / edit / delete / snooze flows (reminderActions.js) wired to
// the REAL storage layer (storage.js) and the REAL notifier (notifications.js).
// Only the two edges are mocks: the plugin (fakePlugin) and the key-value store
// (fakePrefs). So these prove our flows and error handling end to end, not what
// a real iPhone does with an alert.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReminderActions, describeMissingField } from './reminderActions.js';
import { createReminderStorage } from './storage.js';
import { createNotifier, notificationId } from './notifications.js';
import { MAX_REMINDER_ID } from './storage.js';
import { fakePlugin, fakePrefs } from './notifications.fake.js';
import { isUpcoming, isPendingToday } from './due.js';

const KEYS = { reminders: 'tally-reminders', nextId: 'tally-next-id' };
const NOW = new Date(2026, 9, 31, 14, 0);
const DEFAULT_SETTINGS = { soundEnabled: true, quietHours: { enabled: false, start: '22:00', end: '07:00' } };

function setup({ reminders = [], nextId = 1, permission = 'granted', failSetKey = () => false } = {}) {
  const state = { reminders, nextId };
  const settings = { ...DEFAULT_SETTINGS };
  const prefs = fakePrefs({}, { failSet: key => failSetKey(key) });
  const storage = createReminderStorage({ prefs, keys: KEYS, now: () => NOW });
  const plugin = fakePlugin({ permission });
  const notifier = createNotifier({
    plugin, prefs, getReminders: () => state.reminders, getSettings: () => settings, getUserName: () => 'Jacquez', now: () => NOW, random: () => 0,
  });
  const actions = createReminderActions({ state, storage, notifier });
  const stored = () => JSON.parse(prefs.store.get(KEYS.reminders) || '[]');
  return { state, settings, prefs, storage, plugin, notifier, actions, stored };
}

const fields = (over = {}) => ({ name: 'Take vitamins', time: '09:00', recurrence: { type: 'daily' }, color: null, notes: '', ...over });
const weeklyFields = (days, over = {}) => fields({ recurrence: { type: 'daysOfWeek', daysOfWeek: days }, ...over });

// ---- add ----

test('add: saved, alert scheduled, ids and counter persisted', async () => {
  const t = setup();
  const r = await t.actions.add(fields());
  assert.equal(r.reminder.id, 1);
  assert.deepEqual(r.saved, { saved: true });
  assert.equal(r.alerts.ok, true);
  assert.deepEqual(t.plugin.pendingIds(), [notificationId(1, 0)]);
  assert.equal(t.stored()[0].name, 'Take vitamins');
  assert.equal(t.prefs.store.get(KEYS.nextId), '2');
});

test('add with a failing alert: the reminder IS saved, the failure is reported, nothing is lost', async () => {
  const t = setup();
  t.plugin.failSchedule = () => true;
  const r = await t.actions.add(fields({ name: 'Important' }));
  assert.equal(r.saved.saved, true, 'saving and alerting are separate outcomes');
  assert.equal(t.stored().length, 1);
  assert.equal(r.alerts.ok, false);
  assert.deepEqual(r.alerts.failed.map(f => [f.reminderId, f.reason]), [[1, 'schedule_failed']]);
  assert.equal(t.plugin.pending.size, 0);
});

test('RETRY after a failed add creates exactly one alert, never a duplicate', async () => {
  const t = setup();
  t.plugin.failSchedule = () => true;
  await t.actions.add(weeklyFields([1, 3]));
  t.plugin.failSchedule = () => false;
  const retry = await t.actions.syncAlerts();
  assert.equal(retry.ok, true);
  assert.deepEqual(t.plugin.pendingIds(), [notificationId(1, 2), notificationId(1, 4)]);
  await t.actions.syncAlerts();
  await t.actions.syncAlerts();
  assert.equal(t.plugin.pending.size, 2, 'pressing Retry again and again changes nothing');
  assert.equal(t.stored().length, 1, 'and the reminder was never duplicated');
});

test('add when the reminder cannot be saved: it is NOT scheduled, and the failure is reported', async () => {
  const t = setup({ failSetKey: key => key === KEYS.reminders });
  const r = await t.actions.add(fields());
  assert.equal(r.saved.saved, false);
  assert.equal(r.saved.reason, 'write_failed');
  assert.equal(r.alerts, null);
  assert.equal(t.plugin.callCount('schedule'), 0, 'no alert for a reminder that was not saved');
});

test('add when notifications are denied: saved, with a clear per-reminder reason', async () => {
  const t = setup({ permission: 'denied' });
  const r = await t.actions.add(fields());
  assert.equal(r.saved.saved, true);
  assert.equal(r.alerts.permission, 'denied');
  assert.deepEqual(r.alerts.failed.map(f => f.reason), ['permission_denied']);
  assert.equal(t.plugin.callCount('schedule'), 0);
});

test('add in a plain browser (no plugin): saves normally and reports nothing', async () => {
  const t = setup();
  t.plugin.failPermission = true;
  const r = await t.actions.add(fields());
  assert.equal(r.saved.saved, true);
  assert.equal(r.alerts.permission, 'unavailable');
  assert.deepEqual(r.alerts.failed, []);
});

test('add refuses cleanly when the id space is used up, writing nothing', async () => {
  const t = setup({ nextId: MAX_REMINDER_ID + 1 });
  const r = await t.actions.add(fields());
  assert.equal(r.error, 'ids_exhausted');
  assert.equal(t.state.reminders.length, 0);
  assert.equal(t.plugin.callCount('schedule'), 0);
});

test('add at the very largest id works and its alerts stay within 32 bits', async () => {
  const t = setup({ nextId: MAX_REMINDER_ID });
  const r = await t.actions.add(weeklyFields([0, 1, 2, 3, 4, 5, 6]));
  assert.equal(r.alerts.ok, true);
  const ids = t.plugin.pendingIds();
  assert.equal(ids.length, 7);
  assert.ok(ids.every(id => id <= 2 ** 31 - 1));
  assert.equal(new Set(ids).size, 7);
});

test('REGRESSION: a weekly reminder and daily reminders #100 and #101 coexist, and removing the weekly one leaves theirs', async () => {
  const t = setup({ nextId: 1 });
  const weekly = await t.actions.add(weeklyFields([0, 1]));          // id 1 (old scheme: 100 and 101)
  t.state.nextId = 100;
  const d100 = await t.actions.add(fields({ name: 'Daily 100' }));
  const d101 = await t.actions.add(fields({ name: 'Daily 101' }));
  assert.deepEqual([weekly.reminder.id, d100.reminder.id, d101.reminder.id], [1, 100, 101]);
  assert.equal(t.plugin.pending.size, 4);
  await t.actions.remove(1);
  assert.deepEqual(t.plugin.pendingIds(), [notificationId(100, 0), notificationId(101, 0)]);
});

// ---- edit ----

test('edit time: the alert is rescheduled, the saved reminder updated', async () => {
  const t = setup();
  const { reminder } = await t.actions.add(fields());
  const r = await t.actions.update(reminder.id, fields({ time: '07:45' }));
  assert.equal(r.alerts.ok, true);
  assert.deepEqual(t.plugin.pending.get(String(notificationId(1, 0))).schedule.on, { hour: 7, minute: 45 });
  assert.equal(t.stored()[0].time, '07:45');
});

test('edit weekly -> daily leaves no weekday alert behind', async () => {
  const t = setup();
  const { reminder } = await t.actions.add(weeklyFields([1, 3, 5]));
  assert.equal(t.plugin.pending.size, 3);
  await t.actions.update(reminder.id, fields());
  assert.deepEqual(t.plugin.pendingIds(), [notificationId(1, 0)]);
});

test('edit whose scheduling fails: the edit is saved, the failure reported, the old alert untouched', async () => {
  const t = setup();
  const { reminder } = await t.actions.add(fields());
  t.plugin.failSchedule = () => true;
  const r = await t.actions.update(reminder.id, fields({ time: '10:00' }));
  assert.equal(r.saved.saved, true);
  assert.equal(t.stored()[0].time, '10:00');
  assert.equal(r.alerts.ok, false);
  assert.deepEqual(t.plugin.pending.get(String(notificationId(1, 0))).schedule.on, { hour: 9, minute: 0 }, 'the previous alert is still there until a retry succeeds');
  t.plugin.failSchedule = () => false;
  assert.equal((await t.actions.syncAlerts()).ok, true);
  assert.deepEqual(t.plugin.pending.get(String(notificationId(1, 0))).schedule.on, { hour: 10, minute: 0 });
});

test('edit where an old alert cannot be removed: reported, then fixed by retry', async () => {
  const t = setup();
  const { reminder } = await t.actions.add(weeklyFields([1, 3]));
  t.plugin.failCancel = () => true;
  const r = await t.actions.update(reminder.id, fields());
  assert.equal(r.alerts.ok, false);
  assert.ok(r.alerts.failed.some(f => f.reason === 'cancel_failed'));
  t.plugin.failCancel = () => false;
  assert.equal((await t.actions.syncAlerts()).ok, true);
  assert.deepEqual(t.plugin.pendingIds(), [notificationId(1, 0)]);
});

test('edit an unknown reminder is a clean no-op', async () => {
  const t = setup();
  const r = await t.actions.update(404, fields());
  assert.equal(r.error, 'not_found');
  assert.equal(t.plugin.callCount('schedule'), 0);
});

test('edit importance and notes does not reschedule anything', async () => {
  const t = setup();
  const { reminder } = await t.actions.add(fields());
  t.plugin.resetCalls();
  const r = await t.actions.update(reminder.id, fields({ importance: 'high', notes: 'hello', color: 'coral' }));
  assert.equal(r.alerts.ok, true);
  assert.equal(t.plugin.callCount('schedule'), 0);
  assert.equal(t.stored()[0].importance, 'high');
});

// ---- delete ----

test('delete removes every alert for that reminder and only that reminder', async () => {
  const t = setup();
  const a = await t.actions.add(weeklyFields([0, 6]));
  const b = await t.actions.add(fields({ name: 'Keep' }));
  const r = await t.actions.remove(a.reminder.id);
  assert.equal(r.saved.saved, true);
  assert.deepEqual(t.plugin.pendingIds(), [notificationId(b.reminder.id, 0)]);
  assert.deepEqual(t.stored().map(x => x.name), ['Keep']);
});

test('delete with a failing cancel: deleted, the leftover alert is reported, retry removes it', async () => {
  const t = setup();
  const { reminder } = await t.actions.add(fields());
  t.plugin.failCancel = () => true;
  const r = await t.actions.remove(reminder.id);
  assert.equal(r.saved.saved, true);
  assert.equal(r.alerts.ok, false);
  assert.equal(r.alerts.failedCancels.length, 1);
  assert.equal(t.plugin.pending.size, 1, 'the orphan is still there and is known about');
  t.plugin.failCancel = () => false;
  assert.equal((await t.actions.syncAlerts()).ok, true);
  assert.equal(t.plugin.pending.size, 0);
});

test('delete of an unknown reminder is harmless', async () => {
  const t = setup();
  await t.actions.add(fields());
  const r = await t.actions.remove(999);
  assert.equal(r.reminder, null);
  assert.equal(t.plugin.pending.size, 1);
});

// ---- settings changes and snooze, through the same entry point ----

test('SETTINGS: changing sound or quiet hours and syncing reschedules the alerts already on the phone', async () => {
  const t = setup();
  await t.actions.add(fields({ time: '23:30' }));
  assert.equal(t.plugin.pending.get(String(notificationId(1, 0))).sound, 'default');
  t.settings.soundEnabled = false;
  assert.deepEqual((await t.actions.syncAlerts()).scheduled, [1]);
  assert.equal('sound' in t.plugin.pending.get(String(notificationId(1, 0))), false);
  t.settings.soundEnabled = true;
  assert.deepEqual((await t.actions.syncAlerts()).scheduled, [1]);
  assert.equal(t.plugin.pending.get(String(notificationId(1, 0))).sound, 'default', 'sound back on');
  t.settings.quietHours = { enabled: true, start: '22:00', end: '07:00' };
  assert.deepEqual((await t.actions.syncAlerts()).scheduled, [1]);
  assert.equal('sound' in t.plugin.pending.get(String(notificationId(1, 0))), false, 'quiet hours: still scheduled, now silent');
  assert.deepEqual((await t.actions.syncAlerts()).scheduled, [], 'and a further sync with nothing changed does nothing');
});

test('snooze through the action: scheduled, kept by later syncs, dropped when the reminder is deleted', async () => {
  const t = setup();
  const { reminder } = await t.actions.add(fields());
  assert.deepEqual(await t.actions.snooze(reminder.id, 10), { ok: true });
  assert.ok(t.plugin.pending.has(String(notificationId(1, 8))));
  await t.actions.syncAlerts();
  assert.ok(t.plugin.pending.has(String(notificationId(1, 8))));
  await t.actions.remove(reminder.id);
  assert.equal(t.plugin.pending.size, 0);
});

test('snooze reports a clear reason when denied or the reminder is gone', async () => {
  const denied = setup({ permission: 'denied' });
  const { reminder } = await denied.actions.add(fields());
  assert.deepEqual(await denied.actions.snooze(reminder.id), { ok: false, reason: 'permission_denied' });
  assert.deepEqual(await denied.actions.snooze(999), { ok: false, reason: 'not_found' });
});

// ---- the full life of a reminder, with failures at every stage ----

test('lifecycle: add, edit, fail, retry, delete: the phone and the saved data always agree at the end', async () => {
  const t = setup();
  const a = await t.actions.add(weeklyFields([1, 2, 3]));
  const b = await t.actions.add(fields({ name: 'B', time: '08:00' }));
  t.plugin.failSchedule = n => n.extra.reminderId === a.reminder.id;
  await t.actions.update(a.reminder.id, weeklyFields([4, 5], { time: '10:00' }));
  t.plugin.failSchedule = () => false;
  assert.equal((await t.actions.syncAlerts()).ok, true);
  await t.actions.remove(b.reminder.id);
  assert.deepEqual(t.plugin.pendingIds(), [notificationId(1, 5), notificationId(1, 6)]);
  assert.deepEqual(t.stored().map(r => r.name), ['Take vitamins']);
});

// ---- Editing into a one-time reminder ----
// A one-time reminder counts as finished once it has any takenDate, so a
// takenDate carried over from its old schedule must not make it look done.

test('update: a reminder taken today, changed to a one-time reminder on a later day, is upcoming and alerts', async () => {
  const today = '2026-10-31';
  const t = setup({ reminders: [{ id: 1, ...fields(), takenDate: today, currentStreak: 3, longestStreak: 3, lastCompletedDate: today }], nextId: 2 });
  const r = await t.actions.update(1, fields({ recurrence: { type: 'once', date: '2026-11-05' } }));
  assert.equal(r.reminder.takenDate, null);
  assert.ok(isUpcoming(r.reminder, NOW));
  assert.ok(isPendingToday(r.reminder, new Date(2026, 10, 5, 8, 0)));
  assert.equal(t.plugin.pendingIds().length, 1);
});

test('update: a reminder taken today, changed to a one-time reminder for today, stays done (no second dose)', async () => {
  const today = '2026-10-31';
  const t = setup({ reminders: [{ id: 1, ...fields(), takenDate: today }], nextId: 2 });
  const r = await t.actions.update(1, fields({ recurrence: { type: 'once', date: today } }));
  assert.equal(r.reminder.takenDate, today);
});

test('update: editing a recurring reminder taken today keeps it taken today', async () => {
  const today = '2026-10-31';
  const t = setup({ reminders: [{ id: 1, ...fields(), takenDate: today }], nextId: 2 });
  const r = await t.actions.update(1, weeklyFields([6], { time: '10:00' }));
  assert.equal(r.reminder.takenDate, today);
});

test('update: moving a completed one-time reminder to a new later date makes it pending again', async () => {
  const t = setup({ reminders: [{ id: 1, ...fields({ recurrence: { type: 'once', date: '2026-10-30' } }), takenDate: '2026-10-30' }], nextId: 2 });
  const r = await t.actions.update(1, fields({ recurrence: { type: 'once', date: '2026-11-02' } }));
  assert.equal(r.reminder.takenDate, null);
});

// ---- A change that couldn't be saved is undone in memory ----
// Otherwise the next, unrelated save quietly saves (and schedules) the change
// the user was told had failed.
function failingSetup(options) {
  let fail = false;
  const t = setup({ ...options, failSetKey: key => fail && key === KEYS.reminders });
  return { ...t, failNext: (v = true) => { fail = v; } };
}

test('add that fails to save: not kept in memory, and not saved by the next change', async () => {
  const t = failingSetup({ reminders: [{ id: 1, ...fields({ name: 'Existing' }) }], nextId: 2 });
  t.failNext();
  const r = await t.actions.add(fields({ name: 'Failed one' }));
  assert.equal(r.saved.saved, false);
  assert.deepEqual(t.state.reminders.map(x => x.name), ['Existing']);
  assert.equal(t.state.nextId, 2);
  t.failNext(false);
  await t.actions.update(1, fields({ name: 'Existing', time: '10:00' }));
  assert.deepEqual(t.stored().map(x => x.name), ['Existing']);
  assert.equal(t.plugin.pendingIds().length, 1);
});

test('edit that fails to save: the reminder goes back to how it was', async () => {
  const t = failingSetup({ reminders: [{ id: 1, ...fields(), takenDate: null }], nextId: 2 });
  t.failNext();
  const r = await t.actions.update(1, fields({ name: 'Changed', time: '21:00', recurrence: { type: 'once', date: '2026-11-05' } }));
  assert.equal(r.saved.saved, false);
  assert.deepEqual([t.state.reminders[0].name, t.state.reminders[0].time, t.state.reminders[0].recurrence.type], ['Take vitamins', '09:00', 'daily']);
  t.failNext(false);
  await t.actions.syncAlerts();
  assert.equal(t.plugin.pending.get(String(notificationId(1, 0))).schedule.on.hour, 9);
});

test('delete that fails to save: the reminder is still there (and keeps its alert)', async () => {
  const t = failingSetup({ reminders: [{ id: 1, ...fields() }], nextId: 2 });
  await t.actions.syncAlerts();
  t.failNext();
  const r = await t.actions.remove(1);
  assert.equal(r.saved.saved, false);
  assert.deepEqual(t.state.reminders.map(x => x.id), [1]);
  assert.equal(t.plugin.pendingIds().length, 1);
});

// ---- Add / Save with something missing ----
// The form used to do nothing at all (no save, no message). It now says what
// is missing; null means everything needed is there.
test('missing field: names exactly what is missing, first problem first', () => {
  const ok = { name: 'Pill', time: '09:00', recurrenceType: 'daily', recurrence: { type: 'daily' } };
  assert.equal(describeMissingField(ok), null);
  assert.equal(describeMissingField({ ...ok, name: '   ' }), 'Give the reminder a name.');
  assert.equal(describeMissingField({ ...ok, time: '' }), 'Pick a time.');
  assert.equal(describeMissingField({ ...ok, recurrenceType: 'daysOfWeek', recurrence: null }), 'Pick at least one day.');
  assert.equal(describeMissingField({ ...ok, recurrenceType: 'monthlyDate', recurrence: null }), 'Pick a day of the month from 1 to 31.');
  assert.equal(describeMissingField({ ...ok, recurrenceType: 'once', recurrence: null }), 'Pick a date.');
  assert.equal(describeMissingField({ name: '', time: '', recurrenceType: 'once', recurrence: null }), 'Give the reminder a name.');
});
