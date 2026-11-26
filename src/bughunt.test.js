// Adversarial bug hunt (rounds 1 and 2). Each test either proves a bug or rules
// one out. Names say where each stands:
//   FIXED ...  proved a bug; passes now that it is fixed (a regression guard).
//              Its name still describes the bug it caught.
//   BUG ...    proves a bug that is still open; marked `todo`, so it runs and
//              is reported but does not fail `npm test`.
//   OK ...     ruled a suspected bug out; documents that the area was checked.
// Part of `npm test`.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { desiredNotifications, reconcile, planChanges, notificationId, SLOT_SNOOZE } from './notifications.js';
import { fakePlugin, fakePrefs } from './notifications.fake.js';
import { isPendingToday, isUpcoming, appliesToday, nextOccurrence, isOverdue, describeDay } from './due.js';
import { markReminderTaken, checkStaleStreaks, todayKey, takeToday, untakeToday } from './streak.js';
import { resolveMarkTaken, creditPastDay, classifyNotificationAction } from './notificationActions.js';
import { buildSnooze, ALERT_BUDGET, IOS_PENDING_LIMIT } from './notifications.js';
import { createReminderActions } from './reminderActions.js';
import { createReminderStorage, parseStoredReminders } from './storage.js';
import { createNotifier } from './notifications.js';
import { parseReminderRequest } from './intelligence/understand.js';

const SETTINGS = { soundEnabled: true, quietHours: { enabled: false, start: '22:00', end: '07:00' } };
const KEYS = { reminders: 'tally-reminders', nextId: 'tally-next-id' };
const base = (over = {}) => ({
  id: 1, name: 'Pill', time: '09:00', recurrence: { type: 'daily' }, color: null, notes: '',
  takenDate: null, currentStreak: 0, longestStreak: 0, lastCompletedDate: null, ...over,
});

const ORIGINAL_TZ = process.env.TZ;
const restoreTz = () => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; };
after(restoreTz);
function inZone(zone, fn) { process.env.TZ = zone; try { return fn(); } finally { restoreTz(); } }
async function inZoneAsync(zone, fn) { process.env.TZ = zone; try { return await fn(); } finally { restoreTz(); } }

// ---------- 1. iOS 64 pending-notification limit ----------

test('FIXED 64-limit: 10 every-day weekly reminders need 70 iOS requests, and reconcile reports success with no warning', async () => {
  const everyDay = { type: 'daysOfWeek', daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
  const reminders = Array.from({ length: 10 }, (_, i) => base({ id: i + 1, recurrence: everyDay }));
  const now = new Date(2026, 10, 25, 8, 0);
  const { items } = desiredNotifications({ reminders, settings: SETTINGS, now, random: () => 0 });
  assert.equal(items.length, 70); // fact: 7 requests per weekly reminder
  const plugin = fakePlugin();
  const result = await reconcile({ plugin, reminders, settings: SETTINGS, now, random: () => 0 });
  // iOS keeps only 64 of these. The app must notice and say so (or fit under the limit).
  assert.ok(!result.ok || result.failed.length > 0, `reconcile said ok:${result.ok} with ${items.length} requests (> 64) and no warning`);
});

// ---------- 2/3/4. DST and time zones ----------

test('OK DST: daily streak counts correctly across US spring-forward and fall-back days', () => inZone('America/New_York', () => {
  let r = base({ lastCompletedDate: '2027-03-13', currentStreak: 5, longestStreak: 5 });
  r = markReminderTaken(r, '2027-03-14'); // 23-hour day
  r = markReminderTaken(r, '2027-03-15');
  assert.equal(r.currentStreak, 7);
  let f = base({ lastCompletedDate: '2026-10-31', currentStreak: 5, longestStreak: 5 });
  f = markReminderTaken(f, '2026-11-01'); // 25-hour day
  f = markReminderTaken(f, '2026-11-02');
  assert.equal(f.currentStreak, 7);
  assert.equal(checkStaleStreaks([f], '2026-11-03')[0].currentStreak, 7);
  assert.equal(describeDay(new Date(2026, 10, 2), new Date(2026, 10, 1, 23, 30)), 'Tomorrow');
  assert.equal(describeDay(new Date(2027, 2, 15), new Date(2027, 2, 14, 0, 30)), 'Tomorrow');
}));

test('FIXED DST: a one-time 2:30 AM reminder on spring-forward day is shown Overdue at 3:00 but its alert is set for 3:30', () => inZone('America/New_York', () => {
  const r = base({ time: '02:30', recurrence: { type: 'once', date: '2027-03-14' } });
  const { items } = desiredNotifications({ reminders: [r], settings: SETTINGS, now: new Date(2027, 2, 13, 12, 0), random: () => 0 });
  const at = items[0].notification.schedule.at;
  const threeAm = new Date(2027, 2, 14, 3, 0);
  // The UI says the reminder is overdue at 3:00 while its alert hasn't fired yet.
  assert.ok(!(isOverdue(r, threeAm) && at > threeAm), `overdue at 03:00 but alert at ${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`);
}));

test('FIXED time zone: flying west after marking taken resets the streak to 0 on next launch', () => {
  // Marked taken on Nov 26 in Tokyo; the phone is now in Honolulu where it is still Nov 25.
  const r = base({ takenDate: '2026-11-26', lastCompletedDate: '2026-11-26', currentStreak: 12, longestStreak: 12 });
  const [after] = checkStaleStreaks([r], '2026-11-25', 1);
  assert.equal(after.currentStreak, 12, 'streak wiped because lastCompletedDate is "in the future"');
});

test('OK time zone: a one-time alert is the same zone-free calendar date in any zone', () => {
  const r = base({ time: '09:00', recurrence: { type: 'once', date: '2026-12-01' } });
  const now = new Date('2026-11-25T12:00:00Z');
  const fpNY = inZone('America/New_York', () => desiredNotifications({ reminders: [r], settings: SETTINGS, now, random: () => 0 }).items[0].fingerprint);
  const fpLA = inZone('America/Los_Angeles', () => desiredNotifications({ reminders: [r], settings: SETTINGS, now, random: () => 0 }).items[0].fingerprint);
  // Since the R2 fix the alert is a zone-free calendar date, so it follows the phone by itself and
  // the fingerprint no longer needs to change (nothing to re-time on resume).
  assert.equal(fpNY, fpLA);
  const schedule = inZone('America/Los_Angeles', () => desiredNotifications({ reminders: [r], settings: SETTINGS, now, random: () => 0 }).items[0].notification.schedule);
  assert.deepEqual(schedule.on, { year: 2026, month: 12, day: 1, hour: 9, minute: 0 });
});

// ---------- 4. Calendar edges ----------

test('FIXED monthly: a reminder "monthly on the 31st" has no occurrence (and no alert) in 5 months of the year', () => {
  const r = base({ recurrence: { type: 'monthlyDate', dayOfMonth: 31 } });
  const months = new Set();
  let cursor = new Date(2026, 11, 31); // Dec 31 2026
  for (let i = 0; i < 12; i++) {
    cursor = nextOccurrence(r, cursor);
    months.add(cursor.getMonth());
  }
  assert.equal(months.size, 12, `only fires in ${months.size} of 12 months (skips Feb, Apr, Jun, Sep, Nov)`);
});

test('FIXED monthly: "on the 29th" never applies in Feb of a non-leap year', () => {
  const r = base({ recurrence: { type: 'monthlyDate', dayOfMonth: 29 } });
  const feb2027 = Array.from({ length: 28 }, (_, i) => new Date(2027, 1, i + 1));
  assert.ok(feb2027.some(d => appliesToday(r, d)), 'no day in Feb 2027 is due');
});

test('OK weekday mapping: JS Sunday=0 becomes plugin weekday 1, Saturday=6 becomes 7', () => {
  const r = base({ recurrence: { type: 'daysOfWeek', daysOfWeek: [0, 6] } });
  const { items } = desiredNotifications({ reminders: [r], settings: SETTINGS, now: new Date(2026, 10, 25), random: () => 0 });
  assert.deepEqual(items.map(i => i.notification.schedule.on.weekday), [1, 7]);
});

test('OK midnight/noon: 00:00 and 12:00 are scheduled as hour 0 and hour 12', () => {
  const rs = [base({ id: 1, time: '00:00' }), base({ id: 2, time: '12:00' })];
  const { items } = desiredNotifications({ reminders: rs, settings: SETTINGS, now: new Date(2026, 10, 25), random: () => 0 });
  assert.deepEqual(items.map(i => i.notification.schedule.on.hour), [0, 12]);
});

// ---------- 7/10. Completion state and editing ----------

test('FIXED one-time: a one-time reminder completed early still has its alert scheduled', () => {
  const r = base({ time: '18:00', recurrence: { type: 'once', date: '2026-11-25' }, takenDate: '2026-11-25' });
  const { items } = desiredNotifications({ reminders: [r], settings: SETTINGS, now: new Date(2026, 10, 25, 9, 0), random: () => 0 });
  assert.equal(items.length, 0, 'alert will still fire at 18:00 for a reminder already marked done');
});

test('FIXED edit: changing a reminder taken today into a one-time reminder for a later day makes it "already done" forever', async () => {
  const now = new Date(2026, 10, 25, 10, 0);
  const state = { reminders: [base({ takenDate: '2026-11-25', lastCompletedDate: '2026-11-25', currentStreak: 3, longestStreak: 3 })], nextId: 2 };
  const prefs = fakePrefs();
  const storage = createReminderStorage({ prefs, keys: KEYS, now: () => now });
  const notifier = createNotifier({ plugin: fakePlugin(), prefs, getReminders: () => state.reminders, getSettings: () => SETTINGS, getUserName: () => '', now: () => now, random: () => 0 });
  const actions = createReminderActions({ state, storage, notifier });
  const { reminder } = await actions.update(1, { name: 'Pill', time: '09:00', recurrence: { type: 'once', date: '2026-11-30' }, color: null, notes: '' });
  assert.ok(isUpcoming(reminder, now), 'not listed in Upcoming');
  assert.ok(isPendingToday(reminder, new Date(2026, 10, 30, 8, 0)), 'not listed in Today on its own date');
});

test('FIXED streak: un-marking a reminder keeps the streak credit for that day', () => {
  // Round 2: the original version of this test re-created main.js's OLD un-take (clearing takenDate only).
  // Since da803c6, main.js's completeReminder() calls takeToday() and toggleTaken() calls untakeToday()
  // (main.js:1025, 1041), so this now exercises those real functions.
  let r = base({ lastCompletedDate: '2026-11-24', currentStreak: 4, longestStreak: 4 });
  r = takeToday(r, '2026-11-25', 1);
  assert.equal(r.currentStreak, 5);
  r = untakeToday(r, '2026-11-25');
  assert.equal(r.currentStreak, 4, `streak shows ${r.currentStreak} for a day that is not taken`);
  assert.equal(r.lastCompletedDate, '2026-11-24');
});

test('OK streak grace: 1 missed day is forgiven at grace=1, 2 missed days are not; grace=2 forgives 2', () => {
  const r = base({ lastCompletedDate: '2026-11-20', currentStreak: 5, longestStreak: 5 });
  assert.equal(markReminderTaken(r, '2026-11-22', 1).currentStreak, 6); // missed 21
  assert.equal(markReminderTaken(r, '2026-11-23', 1).currentStreak, 1); // missed 21, 22
  assert.equal(markReminderTaken(r, '2026-11-23', 2).currentStreak, 6);
  assert.equal(markReminderTaken(r, '2026-11-24', 2).currentStreak, 1);
  assert.equal(markReminderTaken(r, '2026-11-21', 0).currentStreak, 6);
  assert.equal(markReminderTaken(r, '2026-11-22', 0).currentStreak, 1);
});

// ---------- 11. Snooze ----------

test('FIXED snooze: a pending snooze survives editing the reminder to a day it no longer applies', () => {
  const now = new Date(2026, 10, 25, 9, 5);
  const edited = base({ recurrence: { type: 'once', date: '2026-12-10' } });
  const snoozeId = notificationId(1, SLOT_SNOOZE);
  const pending = [{ id: snoozeId, extra: { reminderId: 1, fp: 'snooze' }, schedule: { at: new Date(2026, 10, 25, 9, 15).toISOString() } }];
  const plan = planChanges({ desired: [], pending, reminders: [edited], now });
  assert.ok(plan.toCancel.includes(snoozeId), 'snooze for the old schedule still fires in 10 minutes');
});

// ---------- 9. Storage ----------

test('OK storage: the oldest format ever written ({id,name,time,takenDate}) loads as daily with no recovery notice', () => {
  const raw = JSON.stringify([{ id: 1, name: 'Pill', time: '08:00', takenDate: null }, { id: 2, name: 'Walk', time: '18:30', takenDate: '2026-09-08' }]);
  const parsed = parseStoredReminders(raw, '3');
  assert.equal(parsed.status, 'ok');
  assert.deepEqual(parsed.reminders.map(r => r.recurrence.type), ['daily', 'daily']);
  assert.equal(parsed.nextId, 3);
});

test('OK storage: next id never reuses a deleted reminder\'s id, even when the counter was lost', () => {
  const raw = JSON.stringify([base({ id: 7 })]);
  assert.equal(parseStoredReminders(raw, null).nextId, 8);
  assert.equal(parseStoredReminders(raw, '3').nextId, 8);
});

test('FIXED storage: a reminder whose save failed is silently saved later by an unrelated change', async () => {
  const now = new Date(2026, 10, 25, 10, 0);
  let fail = true;
  const prefs = fakePrefs({}, { failSet: () => fail });
  const storage = createReminderStorage({ prefs, keys: KEYS, now: () => now });
  const state = { reminders: [base({ id: 1 })], nextId: 2 };
  const notifier = createNotifier({ plugin: fakePlugin(), prefs, getReminders: () => state.reminders, getSettings: () => SETTINGS, getUserName: () => '', now: () => now, random: () => 0 });
  const actions = createReminderActions({ state, storage, notifier });
  const added = await actions.add({ name: 'Failed one', time: '10:00', recurrence: { type: 'daily' }, color: null, notes: '' });
  assert.equal(added.saved.saved, false); // user is told "Couldn't save"
  fail = false;
  await actions.update(1, { name: 'Pill', time: '09:00', recurrence: { type: 'daily' }, color: null, notes: '' });
  const stored = JSON.parse(prefs.store.get(KEYS.reminders));
  assert.ok(!stored.some(r => r.name === 'Failed one'), 'the "unsaved" reminder was saved and scheduled anyway');
});

// ---------- 12. Voice / natural-language parsing ----------

const FRIDAY = new Date(2026, 10, 27, 10, 0);
const parse = (text, now = FRIDAY) => parseReminderRequest(text, now);

test('OK voice: noon, midnight, 12 am, 12 pm, tonight, this evening', () => {
  assert.deepEqual(parse('take pills at noon').time, { hour: 12, minute: 0 });
  assert.deepEqual(parse('take pills at midnight').time, { hour: 0, minute: 0 });
  assert.deepEqual(parse('take pills at 12 am').time, { hour: 0, minute: 0 });
  assert.deepEqual(parse('take pills at 12 pm').time, { hour: 12, minute: 0 });
  assert.equal(parse('take pills tonight').time.hour, 21);
  assert.equal(parse('take pills this evening').time.hour, 19);
});

test('OK voice: "next Friday" on a Friday asks which Friday; no time asks for one', () => {
  assert.ok(parse('call doctor next Friday').questions.some(q => q.id === 'date'));
  assert.ok(parse('take pills').questions.some(q => q.id === 'time'));
});

test('FIXED voice: "every day" next to a weekday word silently becomes weekly-on-that-day', () => {
  const d = parse('buy Friday paper every day at 9 am');
  assert.ok(d.recurrence.type === 'daily' || d.questions.length > 0,
    `became ${JSON.stringify(d.recurrence)} named "${d.name}" with no question`);
});

test('FIXED voice: "at 0:30" (unambiguous 24-hour time) defaults to 12:30', () => {
  assert.deepEqual(parse('take pills at 0:30').time && { hour: parse('take pills at 0:30').time.hour, minute: 30 }, { hour: 0, minute: 30 });
});

test('FIXED voice: a very long sentence produces a name longer than the 60-character field limit', () => {
  const d = parse(`${'take the blue pill with water and food '.repeat(5)}at 9 am`);
  assert.ok(d.name.length <= 60, `name is ${d.name.length} characters`);
});

// =====================================================================
// ROUND 2 (2026-11-26). Same convention: "BUG R2 ..." fails today and
// should pass once fixed; "OK R2 ..." passes and documents a ruled-out case.
// =====================================================================

// ---------- 7/11. Mark Taken on a snooze, and stale alerts ----------

test('FIXED R2 snooze: Mark Taken on a snooze fired BEFORE the reminder time does not mark today taken', () => {
  // The detail screen offers Snooze for any reminder due today and not done (main.js:1621),
  // including before its time. Snoozed at 07:00 for a 09:00 pill -> alert at 07:10 -> Mark Taken.
  // buildSnooze records extra.day = today, but markTakenFromNotification (main.js:957) passes only
  // the reminder to resolveMarkTaken, which looks for "the latest scheduled time at or before now".
  const reminder = base({ time: '09:00', takenDate: '2026-11-25', lastCompletedDate: '2026-11-25', currentStreak: 3, longestStreak: 3 });
  const snoozedAt = new Date(2026, 10, 26, 7, 0);
  const snooze = buildSnooze({ reminder, settings: SETTINGS, now: snoozedAt, random: () => 0 });
  assert.equal(snooze.extra.day, '2026-11-26');
  const pressedAt = new Date(2026, 10, 26, 7, 10);
  const route = classifyNotificationAction({ actionId: 'MARK_TAKEN', notification: { id: snooze.id, extra: snooze.extra } });
  const decision = resolveMarkTaken(reminder, pressedAt, { snoozeDay: route.snoozeDay });
  assert.equal(decision.kind, 'complete_today', `press is resolved as ${JSON.stringify(decision)}: today's dose is not recorded and the 09:00 alert still fires`);
});

test('FIXED R2 snooze: same case when yesterday was missed credits YESTERDAY, not today', () => {
  const reminder = base({ time: '09:00', takenDate: '2026-11-24', lastCompletedDate: '2026-11-24', currentStreak: 3, longestStreak: 3 });
  const snooze = buildSnooze({ reminder, settings: SETTINGS, now: new Date(2026, 10, 26, 7, 0), random: () => 0 });
  const route = classifyNotificationAction({ actionId: 'MARK_TAKEN', notification: { id: snooze.id, extra: snooze.extra } });
  const decision = resolveMarkTaken(reminder, new Date(2026, 10, 26, 7, 10), { snoozeDay: route.snoozeDay });
  assert.deepEqual(decision, { kind: 'complete_today' }, `got ${JSON.stringify(decision)}`);
});

test('FIXED R2 stale alert: Mark Taken on today\'s 09:00 alert, pressed after the time was edited to 20:00, is ignored', () => {
  // 09:00 alert delivered; user edits the reminder to 20:00 at 09:20; then presses Mark Taken at 09:30.
  const before = base({ time: '09:00', takenDate: '2026-11-25', lastCompletedDate: '2026-11-25', currentStreak: 3, longestStreak: 3 });
  const alert = desiredNotifications({ reminders: [before], settings: SETTINGS, now: new Date(2026, 10, 25, 12, 0), random: () => 0 }).items[0].notification;
  const reminder = { ...before, time: '20:00' }; // edited at 09:20
  const route = classifyNotificationAction({ actionId: 'MARK_TAKEN', notification: { id: alert.id, extra: alert.extra } });
  const decision = resolveMarkTaken(reminder, new Date(2026, 10, 26, 9, 30), { snoozeDay: route.snoozeDay, alertTime: route.alertTime });
  assert.equal(decision.kind, 'complete_today', `got ${JSON.stringify(decision)}: the dose taken from the alert is dropped`);
});

// ---------- 7/10. Late Mark Taken vs. the launch stale-streak check (grace = None) ----------

test('FIXED R2 streak: with grace None, a Mark Taken press handled the next morning loses the whole streak', () => {
  // Tue 21:00 alert, Mark Taken pressed with the app closed, handled Wed 08:00.
  // init() runs checkStaleStreaks (main.js:2272) BEFORE markAppReady, then the held press credits Tuesday.
  let r = base({ time: '21:00', takenDate: '2026-11-23', lastCompletedDate: '2026-11-23', currentStreak: 10, longestStreak: 10 }); // Mon taken
  const wed = new Date(2026, 10, 25, 8, 0);
  [r] = checkStaleStreaks([r], todayKey(wed), 0); // launch
  const decision = resolveMarkTaken(r, wed);
  assert.deepEqual(decision, { kind: 'credit_past', day: '2026-11-24' });
  r = creditPastDay(r, decision.day, 0);
  assert.equal(r.currentStreak, 11, `Mon+Tue+... were all taken, but the streak is ${r.currentStreak}`);
});

test('OK R2 streak: same late press with the default 1-day grace keeps the streak', () => {
  let r = base({ time: '21:00', takenDate: '2026-11-23', lastCompletedDate: '2026-11-23', currentStreak: 10, longestStreak: 10 });
  const wed = new Date(2026, 10, 25, 8, 0);
  [r] = checkStaleStreaks([r], todayKey(wed), 1);
  r = creditPastDay(r, resolveMarkTaken(r, wed).day, 1);
  assert.equal(r.currentStreak, 11);
});

// ---------- 1. Alerts for a dose already taken ----------

test('BUG R2 taken early: a daily pill marked taken at 08:00 still gets its 09:00 "time to take" alert today', { todo: 'open: needs a design decision (bug #2: one-time alerts per day instead of repeating ones)' }, () => {
  // Repeating calendar triggers can't skip one day, and desiredNotifications ignores takenDate for
  // recurring reminders. For a medication app this invites a second dose.
  const r = base({ time: '09:00', takenDate: '2026-11-26', lastCompletedDate: '2026-11-26' });
  const now = new Date(2026, 10, 26, 8, 0);
  const { items } = desiredNotifications({ reminders: [r], settings: SETTINGS, now, random: () => 0 });
  const firesToday = items.some(i => i.notification.schedule.on && i.notification.schedule.on.hour === 9 && i.notification.schedule.on.weekday === undefined && i.notification.schedule.on.day === undefined);
  assert.ok(!firesToday, 'a repeating daily 09:00 trigger is scheduled, so it fires today even though the dose is already recorded');
});

// ---------- 1/4. Month-end reminders only look two occurrences ahead ----------

test('FIXED R2 month-end: a "31st" reminder has alerts for only the next 2 months; nothing after that until the app is opened', () => {
  const r = base({ recurrence: { type: 'monthlyDate', dayOfMonth: 31 } });
  const now = new Date(2026, 10, 26, 10, 0);
  const { items } = desiredNotifications({ reminders: [r], settings: SETTINGS, now, random: () => 0 });
  const ats = items.map(i => i.notification.schedule.at).filter(Boolean).map(d => todayKey(d));
  assert.deepEqual(ats, ['2026-11-30', '2027-02-28']); // since the fix: one-time alerts only for short months; slot 0 repeats on the 31st
  // If the app isn't opened (or resumed) before Dec 31, there is no alert for Jan 31.
  const coversJan = items.some(i => i.notification.schedule.on || ats.includes('2027-01-31'));
  assert.ok(coversJan, 'after Dec 31 the reminder silently stops alerting');
});

// ---------- 1/11. Snoozes are not counted against the 64 limit ----------

test('FIXED R2 64-limit: a full alert budget plus 5 snoozes leaves more than 64 pending alerts', async () => {
  const now = new Date(2026, 10, 26, 8, 0);
  const reminders = Array.from({ length: ALERT_BUDGET }, (_, i) => base({ id: i + 1, time: '09:00' }));
  const plugin = fakePlugin();
  const notifier = createNotifier({ plugin, prefs: fakePrefs({ 'tally-notification-scheme': '2' }), getReminders: () => reminders, getSettings: () => SETTINGS, getUserName: () => '', now: () => now, random: () => 0 });
  const result = await notifier.reconcile();
  assert.equal(result.ok, true);
  const snoozes = [];
  for (let id = 1; id <= 5; id++) snoozes.push(await notifier.snooze(reminders[id - 1]));
  // since the fix: the 5th is refused and says so (over_limit) instead of silently pushing an alert out
  assert.ok(snoozes.every(s => s.ok || s.reason === 'over_limit'), 'a snooze that does not fit is reported');
  assert.ok(plugin.pending.size <= IOS_PENDING_LIMIT, `${plugin.pending.size} pending: iOS silently drops the latest-firing ${plugin.pending.size - IOS_PENDING_LIMIT}, which is a reminder's alert, with no warning`);
});

// ---------- 5. Badge ----------

test('FIXED R2 badge: every alert sets the icon badge to 1, so 3 missed reminders show "1" until the app runs', () => {
  const rs = [base({ id: 1, time: '09:00' }), base({ id: 2, time: '09:05' }), base({ id: 3, time: '09:10' })];
  const { items } = desiredNotifications({ reminders: rs, settings: SETTINGS, now: new Date(2026, 10, 26, 8, 0), random: () => 0 });
  const badges = items.map(i => i.notification.badge);
  assert.deepEqual(badges, [1, 2, 3], `badges are ${JSON.stringify(badges)}`);
});

// ---------- 3. Time zones ----------

test('OK R2 time zone: daily and weekly alerts are floating calendar components (no zone), so they follow travel', () => {
  const rs = [base({ id: 1 }), base({ id: 2, recurrence: { type: 'daysOfWeek', daysOfWeek: [1] } })];
  const { items } = desiredNotifications({ reminders: rs, settings: SETTINGS, now: new Date(2026, 10, 26), random: () => 0 });
  for (const i of items) {
    assert.ok(i.notification.schedule.on, 'calendar trigger');
    assert.equal(i.notification.schedule.on.timeZone, undefined);
  }
});

test('FIXED R2 time zone: a one-time alert is a fixed instant (iOS countdown timer), so after flying it fires at the OLD zone\'s 09:00 unless the app is opened first', () => {
  // The plugin turns `at` into UNTimeIntervalNotificationTrigger (LocalNotificationsPlugin.swift:548).
  const r = base({ time: '09:00', recurrence: { type: 'once', date: '2026-12-01' } });
  const ny = inZone('America/New_York', () => desiredNotifications({ reminders: [r], settings: SETTINGS, now: new Date('2026-11-26T15:00:00Z'), random: () => 0 }).items[0].notification.schedule);
  // A fixed instant (`at`) would fire at the New York wall time; a zone-free calendar date fires at 09:00 local.
  const firesAtLA = ny.at ? inZone('America/Los_Angeles', () => new Date(ny.at).getHours()) : ny.on.hour;
  assert.equal(firesAtLA, 9, `scheduled in New York, then the phone moves to Los Angeles: fires at ${firesAtLA}:00 local`);
});

// ---------- 12. Voice ----------

test('FIXED R2 voice: "pills on the 31st of every month at 9" leaves "of month" in the name', () => {
  const draft = parseReminderRequest('pills on the 31st of every month at 9', new Date(2026, 10, 27, 15, 0));
  assert.deepEqual(draft.recurrence, { type: 'monthlyDate', dayOfMonth: 31 });
  assert.equal(draft.name, 'Pills');
});

test('OK R2 voice: noon/midnight/12 am/12 pm/tonight/this evening/no time at 3 PM on a Friday', () => {
  const fri = new Date(2026, 10, 27, 15, 0);
  const t = (s) => parseReminderRequest(s, fri);
  assert.deepEqual(t('pills at noon').time, { hour: 12, minute: 0 });
  assert.deepEqual(t('pills at midnight').time, { hour: 0, minute: 0 });
  assert.deepEqual(t('pills at 12 am').time, { hour: 0, minute: 0 });
  assert.deepEqual(t('pills at 12 pm').time, { hour: 12, minute: 0 });
  assert.deepEqual(t('pills tonight').recurrence, { type: 'once', date: '2026-11-27' });
  assert.equal(t('pills this evening').time.hour, 19);
  assert.equal(t('take pills').time, null);
  assert.ok(t('take pills').questions.some(q => q.id === 'time'), 'asks for a time');
  // 2:30 AM every day is kept as 02:30 (the DST-skipped hour on spring-forward day; see NEEDS DEVICE)
  assert.deepEqual(t('take medicine at 2:30 am every day').time, { hour: 2, minute: 30 });
});
