import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REMINDER_ACTION_TYPE_ID,
  MARK_TAKEN_ACTION_ID,
  reminderActionTypes,
  classifyNotificationAction,
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
