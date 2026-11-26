import test from 'node:test';
import assert from 'node:assert/strict';
import { appliesToday, isPendingToday, isOverdue, isExpiredOneTime, getPendingToday, countOverdue, isAllDoneToday, nextOccurrence, isUpcoming, isDoneToday, filterForView, describeDay, isOverdueOneTime, isCompletedOneTime, getOverdueOneTime, getCompletedOneTime, oneTimeDay, dateFromKey, isFinished, countBadge, msUntilNextLocalMidnight } from './due.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { todayKey } from './streak.js';

// 2024-01-10 is a Wednesday.
function at(hour, minute = 0) {
  return new Date(2024, 0, 10, hour, minute);
}

function makeReminder(overrides = {}) {
  return { id: 1, name: 'Test', time: '09:00', takenDate: null, recurrence: { type: 'daily' }, ...overrides };
}

test('daily reminders apply every day', () => {
  assert.equal(appliesToday(makeReminder(), at(8)), true);
});

test('reminders with no recurrence field are treated as daily', () => {
  assert.equal(appliesToday(makeReminder({ recurrence: undefined }), at(8)), true);
});

test('daysOfWeek applies only on listed weekdays', () => {
  const monWedFri = makeReminder({ recurrence: { type: 'daysOfWeek', daysOfWeek: [1, 3, 5] } });
  const tuesThurs = makeReminder({ recurrence: { type: 'daysOfWeek', daysOfWeek: [2, 4] } });
  assert.equal(appliesToday(monWedFri, at(8)), true);
  assert.equal(appliesToday(tuesThurs, at(8)), false);
});

test('monthlyDate applies only on that day of the month', () => {
  assert.equal(appliesToday(makeReminder({ recurrence: { type: 'monthlyDate', dayOfMonth: 10 } }), at(8)), true);
  assert.equal(appliesToday(makeReminder({ recurrence: { type: 'monthlyDate', dayOfMonth: 11 } }), at(8)), false);
});

test('once applies only on its date', () => {
  assert.equal(appliesToday(makeReminder({ recurrence: { type: 'once', date: '2024-01-10' } }), at(8)), true);
  assert.equal(appliesToday(makeReminder({ recurrence: { type: 'once', date: '2024-01-11' } }), at(8)), false);
});

test('a reminder already taken today is not pending', () => {
  const taken = makeReminder({ takenDate: todayKey(at(8)) });
  assert.equal(isPendingToday(taken, at(8)), false);
});

test('a reminder taken on a previous day is still pending today', () => {
  assert.equal(isPendingToday(makeReminder({ takenDate: '2024-01-09' }), at(8)), true);
});

test('isOverdue is false before the scheduled time', () => {
  assert.equal(isOverdue(makeReminder({ time: '09:00' }), at(8, 59)), false);
});

test('isOverdue is true at and after the scheduled time', () => {
  assert.equal(isOverdue(makeReminder({ time: '09:00' }), at(9, 0)), true);
  assert.equal(isOverdue(makeReminder({ time: '09:00' }), at(15, 30)), true);
});

test('isOverdue is false once taken, even long after the scheduled time', () => {
  const taken = makeReminder({ time: '09:00', takenDate: todayKey(at(15)) });
  assert.equal(isOverdue(taken, at(15)), false);
});

test('isOverdue is false for reminders that do not apply today', () => {
  const tuesThurs = makeReminder({ time: '09:00', recurrence: { type: 'daysOfWeek', daysOfWeek: [2, 4] } });
  assert.equal(isOverdue(tuesThurs, at(15)), false);
});

test('getPendingToday returns applicable untaken reminders, soonest first', () => {
  const reminders = [
    makeReminder({ id: 1, time: '20:00' }),
    makeReminder({ id: 2, time: '08:00' }),
    makeReminder({ id: 3, time: '12:00', takenDate: todayKey(at(10)) }),
    makeReminder({ id: 4, time: '07:00', recurrence: { type: 'daysOfWeek', daysOfWeek: [2] } }),
  ];
  assert.deepEqual(getPendingToday(reminders, at(10)).map(r => r.id), [2, 1]);
});

test('isExpiredOneTime is true only for a one-time reminder whose moment has passed', () => {
  const once = date => makeReminder({ time: '09:00', recurrence: { type: 'once', date } });
  assert.equal(isExpiredOneTime(once('2024-01-10'), at(9, 1)), true);   // same day, time passed
  assert.equal(isExpiredOneTime(once('2024-01-10'), at(8, 59)), false); // same day, still ahead
  assert.equal(isExpiredOneTime(once('2024-01-09'), at(8)), true);      // earlier date
  assert.equal(isExpiredOneTime(once('2024-01-11'), at(23)), false);    // later date
});

test('isExpiredOneTime is false for recurring reminders', () => {
  assert.equal(isExpiredOneTime(makeReminder(), at(23)), false);
  assert.equal(isExpiredOneTime(makeReminder({ recurrence: { type: 'monthlyDate', dayOfMonth: 1 } }), at(23)), false);
  assert.equal(isExpiredOneTime(makeReminder({ recurrence: undefined }), at(23)), false);
});

test('isAllDoneToday is false for an empty list', () => {
  assert.equal(isAllDoneToday([], at(10)), false);
});

test('isAllDoneToday is false when nothing in the list applies today', () => {
  const tuesOnly = makeReminder({ recurrence: { type: 'daysOfWeek', daysOfWeek: [2] } }); // today is Wed
  assert.equal(isAllDoneToday([tuesOnly], at(10)), false);
});

test('isAllDoneToday is false while anything relevant to today is still pending', () => {
  const reminders = [
    makeReminder({ id: 1, takenDate: todayKey(at(10)) }),
    makeReminder({ id: 2, takenDate: null }),
  ];
  assert.equal(isAllDoneToday(reminders, at(10)), false);
});

test('isAllDoneToday is true once every reminder relevant to today is taken', () => {
  const today = todayKey(at(10));
  const reminders = [
    makeReminder({ id: 1, takenDate: today }),
    makeReminder({ id: 2, takenDate: today, recurrence: { type: 'daysOfWeek', daysOfWeek: [2] } }), // not today, irrelevant
  ];
  assert.equal(isAllDoneToday(reminders, at(10)), true);
});

test('countOverdue counts only pending reminders whose time has passed', () => {
  const reminders = [
    makeReminder({ id: 1, time: '08:00' }),
    makeReminder({ id: 2, time: '09:30' }),
    makeReminder({ id: 3, time: '20:00' }),
    makeReminder({ id: 4, time: '07:00', takenDate: todayKey(at(10)) }),
  ];
  assert.equal(countOverdue(reminders, at(10)), 2);
  assert.equal(countOverdue([], at(10)), 0);
});

const ymd = d => [d.getFullYear(), d.getMonth() + 1, d.getDate()];

test('nextOccurrence: daily is tomorrow', () => {
  assert.deepEqual(ymd(nextOccurrence(makeReminder(), at(10))), [2024, 1, 11]);
});

test('nextOccurrence: daysOfWeek finds the next listed weekday, never today', () => {
  const fri = makeReminder({ recurrence: { type: 'daysOfWeek', daysOfWeek: [5] } });
  const wed = makeReminder({ recurrence: { type: 'daysOfWeek', daysOfWeek: [3] } }); // today is Wed
  assert.deepEqual(ymd(nextOccurrence(fri, at(10))), [2024, 1, 12]);
  assert.deepEqual(ymd(nextOccurrence(wed, at(10))), [2024, 1, 17]);
});

test('nextOccurrence: monthlyDate rolls to the next month when the day has passed', () => {
  assert.deepEqual(ymd(nextOccurrence(makeReminder({ recurrence: { type: 'monthlyDate', dayOfMonth: 5 } }), at(10))), [2024, 2, 5]);
  assert.deepEqual(ymd(nextOccurrence(makeReminder({ recurrence: { type: 'monthlyDate', dayOfMonth: 31 } }), at(10))), [2024, 1, 31]);
});

test('nextOccurrence: once is its date if still ahead, otherwise null', () => {
  const once = date => makeReminder({ recurrence: { type: 'once', date } });
  assert.deepEqual(ymd(nextOccurrence(once('2024-02-01'), at(10))), [2024, 2, 1]);
  assert.equal(nextOccurrence(once('2024-01-10'), at(10)), null);
  assert.equal(nextOccurrence(once('2024-01-09'), at(10)), null);
});

test('isUpcoming is true only for reminders not due today that will recur', () => {
  assert.equal(isUpcoming(makeReminder({ recurrence: { type: 'daysOfWeek', daysOfWeek: [5] } }), at(10)), true);
  assert.equal(isUpcoming(makeReminder(), at(10)), false); // daily applies today
  assert.equal(isUpcoming(makeReminder({ recurrence: { type: 'once', date: '2024-01-20' } }), at(10)), true);
  assert.equal(isUpcoming(makeReminder({ recurrence: { type: 'once', date: '2024-01-01' } }), at(10)), false);
});

test('isDoneToday needs the reminder to apply today and be taken today', () => {
  const today = todayKey(at(10));
  assert.equal(isDoneToday(makeReminder({ takenDate: today }), at(10)), true);
  assert.equal(isDoneToday(makeReminder({ takenDate: '2024-01-09' }), at(10)), false);
  assert.equal(isDoneToday(makeReminder({ takenDate: today, recurrence: { type: 'daysOfWeek', daysOfWeek: [2] } }), at(10)), false);
});

test('filterForView splits reminders across the three tabs', () => {
  const today = todayKey(at(10));
  const reminders = [
    makeReminder({ id: 1, time: '20:00' }),
    makeReminder({ id: 2, time: '08:00' }),
    makeReminder({ id: 3, time: '12:00', takenDate: today }),
    makeReminder({ id: 4, time: '07:00', recurrence: { type: 'daysOfWeek', daysOfWeek: [6] } }),
    makeReminder({ id: 5, time: '09:00', recurrence: { type: 'daysOfWeek', daysOfWeek: [5] } }),
    makeReminder({ id: 6, time: '09:00', recurrence: { type: 'once', date: '2024-01-01' } }), // expired: in no tab
  ];
  const ids = view => filterForView(reminders, view, at(10)).map(r => r.id);
  assert.deepEqual(ids('today'), [2, 1]);
  assert.deepEqual(ids('done'), [3]);
  assert.deepEqual(ids('upcoming'), [5, 4]); // Fri Jan 12 before Sat Jan 13
});

test('describeDay says Today / Tomorrow, then a short date', () => {
  assert.equal(describeDay(at(23), at(1)), 'Today');
  assert.equal(describeDay(new Date(2024, 0, 11), at(10)), 'Tomorrow');
  assert.equal(describeDay(new Date(2024, 0, 12), at(10), 'en-US'), 'Fri, Jan 12');
});

// ---- One-time reminders from earlier days (stabilization finding 2) ----
// Before this fix a one-time reminder whose day had passed matched no tab:
// filterForView returned it for none of today / upcoming / done, so it was
// saved but invisible.

const onceOn = (id, date, over = {}) => makeReminder({ id, name: `R${id}`, recurrence: { type: 'once', date }, ...over });
// 2024-01-10 is "today" in these tests (see at()).
const TODAY = '2024-01-10';

const PLACES = ['today', 'upcoming', 'done', 'overdue', 'completed'];
function placesOf(reminder, date) {
  const found = [];
  for (const view of ['today', 'upcoming', 'done']) if (filterForView([reminder], view, date).length) found.push(view);
  if (getOverdueOneTime([reminder], date).length) found.push('overdue');
  if (getCompletedOneTime([reminder], date).length) found.push('completed');
  return found;
}

test('REGRESSION: an unfinished one-time reminder from a past day is in the Overdue list, not nowhere', () => {
  const r = onceOn(1, '2024-01-08');
  assert.deepEqual(filterForView([r], 'today', at(10)), []);
  assert.deepEqual(getOverdueOneTime([r], at(10)).map(x => x.id), [1]);
  assert.equal(isOverdueOneTime(r, at(10)), true);
});

test('overdue list is oldest first, then by time, and ignores finished and recurring reminders', () => {
  const list = [
    onceOn(1, '2024-01-09', { time: '08:00' }),
    onceOn(2, '2024-01-05', { time: '18:00' }),
    onceOn(3, '2024-01-09', { time: '07:00' }),
    onceOn(4, '2024-01-02', { takenDate: '2024-01-02' }),
    makeReminder({ id: 5 }),
    onceOn(6, TODAY),
    onceOn(7, '2024-01-20'),
  ];
  assert.deepEqual(getOverdueOneTime(list, at(10)).map(x => x.id), [2, 3, 1]);
});

test('completing an overdue reminder moves it to Done today, then to Completed from the next day', () => {
  const r = onceOn(1, '2024-01-08', { takenDate: TODAY });
  assert.deepEqual(placesOf(r, at(12)), ['done']);
  assert.equal(isOverdueOneTime(r, at(12)), false);
  const nextDay = new Date(2024, 0, 11, 0, 0);
  assert.deepEqual(placesOf(r, nextDay), ['completed']);
  assert.equal(isDoneToday(r, nextDay), false);
});

test('a one-time reminder done on its own day: Done that day, Completed afterwards, never deleted', () => {
  const r = onceOn(1, TODAY, { takenDate: TODAY });
  assert.deepEqual(placesOf(r, at(23, 59)), ['done']);
  assert.deepEqual(placesOf(r, new Date(2024, 0, 11, 0, 0)), ['completed']);
  assert.deepEqual(placesOf(r, new Date(2025, 5, 1, 9, 0)), ['completed'], 'still there a year later');
});

test('completed list is most recently finished first', () => {
  const list = [onceOn(1, '2024-01-01', { takenDate: '2024-01-02' }), onceOn(2, '2024-01-01', { takenDate: '2024-01-08' }), onceOn(3, '2024-01-01', { takenDate: '2024-01-05' })];
  assert.deepEqual(getCompletedOneTime(list, at(10)).map(x => x.id), [2, 3, 1]);
});

test('a one-time reminder completed early (its day is still ahead) is not "upcoming" any more', () => {
  const r = onceOn(1, '2024-01-20', { takenDate: TODAY });
  assert.equal(isUpcoming(r, at(10)), false);
  assert.deepEqual(placesOf(r, at(10)), ['done']);
});

test('un-completing an overdue reminder puts it back in Overdue', () => {
  const r = onceOn(1, '2024-01-08', { takenDate: null });
  assert.deepEqual(placesOf(r, at(10)), ['overdue']);
});

test('INVARIANT: every one-time reminder is in exactly one place, for every date and completion state', () => {
  const dates = ['2023-12-31', '2024-01-01', '2024-01-09', TODAY, '2024-01-11', '2024-02-29'];
  const taken = [null, '2023-12-31', '2024-01-09', TODAY];
  const nows = [at(0, 0), at(0, 1), at(9, 0), at(23, 59), new Date(2024, 0, 11, 0, 0)];
  for (const date of dates) for (const takenDate of taken) for (const now of nows) {
    const places = placesOf(onceOn(1, date, { takenDate }), now);
    assert.equal(places.length, 1, `date ${date}, taken ${takenDate}, now ${now.toString()}: in ${JSON.stringify(places)}`);
    assert.ok(PLACES.includes(places[0]));
  }
});

test('midnight boundary: dated today and unfinished is Today until local midnight, Overdue from 00:00', () => {
  const r = onceOn(1, TODAY, { time: '23:59' });
  assert.deepEqual(placesOf(r, at(23, 59)), ['today']);
  assert.deepEqual(placesOf(r, new Date(2024, 0, 10, 23, 59, 59, 999)), ['today']);
  assert.deepEqual(placesOf(r, new Date(2024, 0, 11, 0, 0, 0, 0)), ['overdue']);
});

test('oneTimeDay returns the local day, and null for recurring reminders', () => {
  const day = oneTimeDay(onceOn(1, '2024-03-09'));
  assert.deepEqual([day.getFullYear(), day.getMonth(), day.getDate(), day.getHours()], [2024, 2, 9, 0]);
  assert.equal(oneTimeDay(makeReminder()), null);
});

test('overdue and completed one-time reminders do not change the all-done banner or the today-only overdue count', () => {
  const list = [makeReminder({ id: 1, takenDate: TODAY }), onceOn(2, '2024-01-01'), onceOn(3, '2024-01-01', { takenDate: '2024-01-02' })];
  assert.equal(isAllDoneToday(list, at(12)), true);
  assert.equal(countOverdue(list, at(12)), 0);
});

test('the icon badge counts today\'s overdue plus unfinished one-time reminders from earlier days, never finished ones', () => {
  const list = [
    makeReminder({ id: 1, time: '08:00' }),                         // daily, 8:00 passed, not taken: overdue today
    makeReminder({ id: 2, time: '23:00' }),                         // daily, not due yet
    onceOn(3, '2024-01-08'),                                        // unfinished, earlier day
    onceOn(4, '2024-01-01'),                                        // unfinished, earlier day
    onceOn(5, '2024-01-02', { takenDate: '2024-01-02' }),           // finished earlier
    onceOn(6, '2024-01-05', { takenDate: TODAY }),                  // finished today
    onceOn(7, '2024-01-20'),                                        // in the future
  ];
  assert.equal(countOverdue(list, at(10)), 1);
  assert.equal(countBadge(list, at(10)), 3);
});

test('the badge drops when an overdue one-time reminder is completed, and at local midnight an unfinished one starts counting', () => {
  const r = onceOn(1, TODAY, { time: '23:59' });
  assert.equal(countBadge([r], at(23, 58)), 0, 'its own day, time not passed yet');
  assert.equal(countBadge([r], at(23, 59)), 1, 'its own day, minute reached: overdue today');
  assert.equal(countBadge([r], new Date(2024, 0, 11, 0, 0)), 1, 'midnight: now overdue');
  assert.equal(countBadge([{ ...r, takenDate: '2024-01-11' }], new Date(2024, 0, 11, 9, 0)), 0, 'completed');
});

// The same boundaries in different real time zones. The day rule must follow
// the phone's local clock, not UTC: these run the check in a child process
// whose TZ is set, so a UTC-based comparison would give a different answer.
const ZONES = ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles', 'Asia/Kolkata'];
const dueUrl = new URL('./due.js', import.meta.url).href;
const zoneScript = `
  import { getOverdueOneTime, filterForView } from ${JSON.stringify(dueUrl)};
  const r = { id: 1, name: 'x', time: '23:59', takenDate: null, recurrence: { type: 'once', date: '2024-01-10' } };
  const at = (d, h, m) => new Date(2024, 0, d, h, m);
  const state = (now) => ({ today: filterForView([r], 'today', now).length, overdue: getOverdueOneTime([r], now).length });
  console.log(JSON.stringify({ before: state(at(10, 23, 59)), after: state(at(11, 0, 0)), early: state(at(10, 0, 0)) }));
`;
for (const zone of ZONES) {
  test(`midnight boundary follows the local clock in ${zone}`, () => {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', zoneScript], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), {
      early: { today: 1, overdue: 0 },
      before: { today: 1, overdue: 0 },
      after: { today: 0, overdue: 1 },
    });
  });
}

test('isFinished: recurring is done for today only, one-time is done for good', () => {
  assert.equal(isFinished(makeReminder({ takenDate: TODAY }), at(10)), true);
  assert.equal(isFinished(makeReminder({ takenDate: '2024-01-09' }), at(10)), false);
  assert.equal(isFinished(onceOn(1, '2024-01-01', { takenDate: '2024-01-02' }), at(10)), true);
  assert.equal(isFinished(onceOn(1, '2024-01-01'), at(10)), false);
});

test('dateFromKey gives local midnight', () => {
  const d = dateFromKey('2024-03-09');
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2024, 2, 9, 0]);
});

// ---- Monthly on the 29th, 30th or 31st falls back to the month's last day ----
test('monthly 31st applies on the last day of short months, and only then', () => {
  const r = makeReminder({ recurrence: { type: 'monthlyDate', dayOfMonth: 31 } });
  assert.equal(appliesToday(r, new Date(2027, 3, 30)), true);   // Apr 30
  assert.equal(appliesToday(r, new Date(2027, 3, 29)), false);
  assert.equal(appliesToday(r, new Date(2027, 1, 28)), true);   // Feb 28, common year
  assert.equal(appliesToday(r, new Date(2028, 1, 29)), true);   // Feb 29, leap year
  assert.equal(appliesToday(r, new Date(2028, 1, 28)), false);
  assert.equal(appliesToday(r, new Date(2027, 4, 31)), true);   // May 31
  assert.equal(appliesToday(r, new Date(2027, 4, 30)), false);
});

test('monthly 29th and 30th in February', () => {
  const on = day => makeReminder({ recurrence: { type: 'monthlyDate', dayOfMonth: day } });
  assert.equal(appliesToday(on(29), new Date(2027, 1, 28)), true);
  assert.equal(appliesToday(on(29), new Date(2028, 1, 29)), true);
  assert.equal(appliesToday(on(29), new Date(2028, 1, 28)), false);
  assert.equal(appliesToday(on(30), new Date(2027, 1, 28)), true);
  assert.equal(appliesToday(on(30), new Date(2027, 3, 30)), true);
});

test('monthly 31st occurs in all 12 months', () => {
  const r = makeReminder({ recurrence: { type: 'monthlyDate', dayOfMonth: 31 } });
  const months = new Set();
  let cursor = new Date(2026, 11, 31);
  for (let i = 0; i < 12; i++) { cursor = nextOccurrence(r, cursor); months.add(cursor.getMonth()); }
  assert.equal(months.size, 12);
});

// ---- When the next day starts (for refreshing an app left open) ----

test('msUntilNextLocalMidnight: ordinary evening', () => {
  assert.equal(msUntilNextLocalMidnight(new Date(2026, 10, 25, 23, 0, 0)), 3600000);
  assert.equal(msUntilNextLocalMidnight(new Date(2026, 10, 25, 0, 0, 0)), 24 * 3600000);
});

test('msUntilNextLocalMidnight: lands exactly on local midnight across both US DST changes', () => {
  const prev = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    for (const start of [new Date(2027, 2, 14, 0, 30), new Date(2026, 10, 1, 0, 30), new Date(2027, 2, 13, 22, 0)]) {
      const next = new Date(start.getTime() + msUntilNextLocalMidnight(start));
      assert.deepEqual([next.getHours(), next.getMinutes()], [0, 0]);
      assert.equal(next.getDate(), new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1).getDate());
    }
  } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
});

// ---- Overdue uses the same clock time the alert uses ----
// On a spring-forward day 2:30 AM doesn't exist; JavaScript (and so the alert)
// moves it to 3:30 AM. "Overdue" must not appear before the alert can fire.
test('isOverdue: a 2:30 AM one-time reminder on spring-forward day is not overdue at 3:00, but is at 3:30', () => {
  const prev = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const r = makeReminder({ time: '02:30', recurrence: { type: 'once', date: '2027-03-14' } });
    assert.equal(isOverdue(r, new Date(2027, 2, 14, 3, 0)), false);
    assert.equal(isOverdue(r, new Date(2027, 2, 14, 3, 30)), true);
    // An ordinary day is unchanged: overdue from the scheduled minute on.
    const d = makeReminder({ time: '09:00' });
    assert.equal(isOverdue(d, new Date(2027, 2, 15, 8, 59)), false);
    assert.equal(isOverdue(d, new Date(2027, 2, 15, 9, 0)), true);
  } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
});
