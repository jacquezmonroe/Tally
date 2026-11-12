import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAlerts, alertBannerText, alertBadgeText } from './alertStatus.js';

const rems = [{ id: 1 }, { id: 2 }, { id: 3 }];
const result = (over = {}) => ({ permission: 'granted', ok: true, failed: [], failedCancels: [], ...over });

test('no result, a browser, or all-good shows nothing', () => {
  for (const r of [null, result({ permission: 'unavailable' }), result()]) {
    const s = summarizeAlerts(r, rems);
    assert.equal(s.kind, 'none');
    assert.equal(alertBannerText(s), '');
  }
});

test('"not asked yet" is left to the Enable banner', () => {
  assert.equal(summarizeAlerts(result({ permission: 'prompt', ok: false }), rems).kind, 'prompt');
});

test('denied: guidance text names the Settings path, and every affected reminder gets the "off" badge', () => {
  const s = summarizeAlerts(result({ permission: 'denied', ok: false, failed: [1, 2].map(reminderId => ({ reminderId, reason: 'permission_denied' })) }), rems);
  assert.equal(s.kind, 'denied');
  assert.match(alertBannerText(s), /Settings → Notifications → Tickmark/);
  assert.deepEqual([...s.badges.keys()], [1, 2]);
  assert.equal(alertBadgeText(s.badges.get(1)), 'Alerts are off');
});

test('failures: counts reminders, singular and plural, with a different badge', () => {
  const one = summarizeAlerts(result({ ok: false, failed: [{ reminderId: 2, reason: 'schedule_failed' }] }), rems);
  assert.equal(alertBannerText(one), '1 reminder is saved but its alert could not be scheduled.');
  assert.equal(alertBadgeText(one.badges.get(2)), 'Alert not scheduled');
  const two = summarizeAlerts(result({ ok: false, failed: [{ reminderId: 1, reason: 'schedule_failed' }, { reminderId: 3, reason: 'cancel_failed' }] }), rems);
  assert.equal(alertBannerText(two), '2 reminders are saved but their alerts could not be scheduled.');
});

test('a reminder that no longer exists is not counted or badged', () => {
  const s = summarizeAlerts(result({ ok: false, failed: [{ reminderId: 99, reason: 'schedule_failed' }] }), rems);
  assert.equal(s.kind, 'none');
});

test('leftover alerts that could not be removed get their own message', () => {
  const s = summarizeAlerts(result({ ok: false, failedCancels: [1600] }), rems);
  assert.equal(s.kind, 'failed');
  assert.equal(s.count, 0);
  assert.match(alertBannerText(s), /could not be removed/);
});

test('one reminder with two failures is counted once', () => {
  const s = summarizeAlerts(result({ ok: false, failed: [{ reminderId: 1, reason: 'schedule_failed' }, { reminderId: 1, reason: 'cancel_failed' }] }), rems);
  assert.equal(s.count, 1);
});
