import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REMINDER_ACTION_TYPE_ID,
  MARK_TAKEN_ACTION_ID,
  reminderActionTypes,
  classifyNotificationAction,
  resolveMarkTaken,
  creditPastDay,
} from './notificationActions.js';

const event = (actionId, ...rest) => ({ actionId, notification: { id: 7, extra: rest.length ? rest[0] : { reminderId: 7 } } });

test('one action type with one "Mark Taken" button that does not open the app', () => {
  const types = reminderActionTypes();
  assert.equal(types.length, 1);
  assert.equal(types[0].id, REMINDER_ACTION_TYPE_ID);
  assert.equal(types[0].actions.length, 1);
  const [action] = types[0].actions;
  assert.equal(action.id, MARK_TAKEN_ACTION_ID);
  assert.equal(action.title, 'Mark Taken');
  assert.equal(action.foreground, false);   // runs in the background
  assert.equal(action.destructive, false);
  assert.ok(!('requiresAuthentication' in action)); // works from the lock screen, no unlock needed
});

test('the Mark Taken button routes to mark_taken with the reminder id', () => {
  assert.deepEqual(classifyNotificationAction(event('MARK_TAKEN')), { kind: 'mark_taken', reminderId: 7 });
});

test('tapping the notification itself still just opens and highlights', () => {
  assert.deepEqual(classifyNotificationAction(event('tap')), { kind: 'open', reminderId: 7 });
});

test('dismissing or any unknown button does nothing', () => {
  for (const id of ['dismiss', 'SOMETHING_ELSE', '', undefined, null, 42]) {
    assert.equal(classifyNotificationAction(event(id)).kind, 'ignore', String(id));
  }
});

test('a notification with no usable reminder id is ignored, even for Mark Taken', () => {
  for (const extra of [undefined, null, {}, { reminderId: null }, { reminderId: 'abc' }, { reminderId: 1.5 }, { reminderId: {} }, { reminderId: -0.1 }]) {
    assert.deepEqual(classifyNotificationAction(event('MARK_TAKEN', extra)), { kind: 'ignore', reminderId: null });
  }
});

test('a numeric string id (as some bridges deliver it) is accepted', () => {
  assert.deepEqual(classifyNotificationAction(event('MARK_TAKEN', { reminderId: '12' })), { kind: 'mark_taken', reminderId: 12 });
});

test('malformed events never throw', () => {
  for (const bad of [null, undefined, {}, [], 'x', 5, { actionId: 'MARK_TAKEN' }, { notification: null }, { actionId: 'MARK_TAKEN', notification: { extra: 'nope' } }]) {
    assert.equal(classifyNotificationAction(bad).kind, 'ignore');
  }
});

// ---- Which day a "Mark Taken" press counts for ----
// The press can be handled later than it happened (iOS holds it until the app's
// JavaScript runs), so the day is the reminder's latest scheduled time at or
// before "now", never simply today.

const pill = (over = {}) => ({
  id: 1, name: 'Pill', time: '09:00', recurrence: { type: 'daily' },
  takenDate: null, currentStreak: 0, longestStreak: 0, lastCompletedDate: null, ...over,
});

test('Mark Taken: pressed for Monday\'s alert but handled Tuesday before Tuesday\'s time credits Monday, not Tuesday', () => {
  const tuesday7am = new Date(2026, 10, 24, 7, 0);
  assert.deepEqual(resolveMarkTaken(pill(), tuesday7am), { kind: 'credit_past', day: '2026-11-23' });
});

test('Mark Taken: handled after today\'s time completes today', () => {
  assert.deepEqual(resolveMarkTaken(pill(), new Date(2026, 10, 24, 9, 30)), { kind: 'complete_today' });
});

test('Mark Taken: a weekly reminder handled on a day it does not apply credits its last day instead of being dropped', () => {
  const mondays = pill({ recurrence: { type: 'daysOfWeek', daysOfWeek: [1] } });
  assert.deepEqual(resolveMarkTaken(mondays, new Date(2026, 10, 25, 12, 0)), { kind: 'credit_past', day: '2026-11-23' });
});

test('Mark Taken: a snoozed late-night alert pressed after midnight credits the evening before', () => {
  const late = pill({ time: '23:55' });
  assert.deepEqual(resolveMarkTaken(late, new Date(2026, 10, 25, 0, 6)), { kind: 'credit_past', day: '2026-11-24' });
});

test('Mark Taken: already taken (double press) is ignored, for today and for a past day', () => {
  assert.deepEqual(resolveMarkTaken(pill({ takenDate: '2026-11-24' }), new Date(2026, 10, 24, 10, 0)), { kind: 'ignore' });
  assert.deepEqual(resolveMarkTaken(pill({ takenDate: '2026-11-24', lastCompletedDate: '2026-11-24' }), new Date(2026, 10, 25, 7, 0)), { kind: 'ignore' });
});

test('Mark Taken: a deleted reminder is ignored', () => {
  assert.deepEqual(resolveMarkTaken(undefined, new Date()), { kind: 'ignore' });
});

test('Mark Taken: one-time reminders keep the old rule (today or overdue, once only)', () => {
  const now = new Date(2026, 10, 25, 12, 0);
  assert.deepEqual(resolveMarkTaken(pill({ recurrence: { type: 'once', date: '2026-11-25' } }), now), { kind: 'complete_today' });
  assert.deepEqual(resolveMarkTaken(pill({ recurrence: { type: 'once', date: '2026-11-20' } }), now), { kind: 'complete_today' });
  assert.deepEqual(resolveMarkTaken(pill({ recurrence: { type: 'once', date: '2026-11-20' }, takenDate: '2026-11-21' }), now), { kind: 'ignore' });
  assert.deepEqual(resolveMarkTaken(pill({ recurrence: { type: 'once', date: '2026-12-01' } }), now), { kind: 'ignore' });
});

test('creditPastDay: records the past day and extends the streak, without touching today', () => {
  const r = pill({ lastCompletedDate: '2026-11-22', currentStreak: 3, longestStreak: 3 });
  const out = creditPastDay(r, '2026-11-23', 1);
  assert.equal(out.takenDate, '2026-11-23');
  assert.equal(out.lastCompletedDate, '2026-11-23');
  assert.equal(out.currentStreak, 4);
});

test('creditPastDay: never overwrites a later takenDate (today\'s dose stays taken)', () => {
  const r = pill({ takenDate: '2026-11-25', lastCompletedDate: '2026-11-22', currentStreak: 3, longestStreak: 3 });
  assert.equal(creditPastDay(r, '2026-11-24', 1).takenDate, '2026-11-25');
});
