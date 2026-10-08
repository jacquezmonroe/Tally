import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreReminder,
  rankFocus,
  focusSummary,
  focusFacts,
  validateSummary,
  withImportance,
  normalizeImportance,
  POINTS,
  MAX_FACT_ITEMS,
  MAX_SUMMARY_LENGTH,
} from './prioritizer.js';
import { todayKey } from '../streak.js';
import { createIntelligence } from './index.js';

// Thursday, October 8 2026, 1:00 PM in whatever timezone the test runs in.
const NOW = new Date(2026, 9, 8, 13, 0);
const TODAY = todayKey(NOW);
let nextId = 1;
const make = (time, extra = {}) => ({
  id: nextId++, name: `Task ${time}`, time, takenDate: null, recurrence: { type: 'daily' }, ...extra,
});
const names = ranked => ranked.map(r => r.name);

const ORIGINAL_TZ = process.env.TZ;
const restoreTimeZone = () => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; };
after(restoreTimeZone);

// Runs `fn` in another timezone, then puts the original back so later tests are unaffected.
function withTimeZone(zone, fn) {
  process.env.TZ = zone;
  try { fn(); } finally { restoreTimeZone(); }
}

test('only reminders still pending today are ranked', () => {
  const reminders = [
    make('09:00'),                                                        // overdue: ranked
    make('15:00', { takenDate: TODAY }),                                  // already done
    make('16:00', { recurrence: { type: 'daysOfWeek', daysOfWeek: [1] } }), // Monday only; today is Thursday
    make('17:00', { recurrence: { type: 'once', date: '2026-10-07' } }),     // one-time, yesterday
    make('18:00', { recurrence: { type: 'once', date: TODAY } }),            // one-time, today: ranked
  ];
  assert.deepEqual(rankFocus(reminders, NOW).map(r => r.time), ['09:00', '18:00']);
});

test('overdue outranks due soon, which outranks due later today', () => {
  const overdue = make('12:00');
  const soon = make('13:30');
  const later = make('18:00');
  assert.deepEqual(rankFocus([later, soon, overdue], NOW).map(r => r.id), [overdue.id, soon.id, later.id]);
});

test('the later an overdue reminder is, the higher it ranks', () => {
  const a = make('12:45'); // 15 min late
  const b = make('09:00'); // 4 hours late
  assert.deepEqual(rankFocus([a, b], NOW).map(r => r.id), [b.id, a.id]);
  assert.ok(scoreReminder(b, NOW).score > scoreReminder(a, NOW).score);
});

test('overdue points are capped, so one very old reminder cannot dominate forever', () => {
  const ancient = make('00:01');
  const factor = scoreReminder(ancient, NOW).factors.find(f => f.id === 'overdue');
  assert.equal(factor.points, POINTS.overdueMax);
});

test('due-soon and later-today scores follow the time window', () => {
  assert.equal(scoreReminder(make('13:30'), NOW).factors[0].points, POINTS.dueWithinHour);
  assert.equal(scoreReminder(make('15:00'), NOW).factors[0].points, POINTS.dueWithin3Hours);
  assert.equal(scoreReminder(make('18:00'), NOW).factors[0].points, POINTS.laterTodayMax - 5);
  assert.equal(scoreReminder(make('23:59'), NOW).factors[0].points, POINTS.laterTodayMin);
});

test('high importance can lift a later task above one due sooner; low importance sinks it', () => {
  const soon = make('13:30');
  const laterHigh = make('18:00', { importance: 'high' });
  assert.equal(rankFocus([soon, laterHigh], NOW)[0].id, laterHigh.id);

  const soonLow = make('13:30', { importance: 'low' });
  const later = make('15:00');
  assert.equal(rankFocus([soonLow, later], NOW)[0].id, later.id);
});

test('importance is never invented: unset, unknown and "normal" all add nothing', () => {
  for (const importance of [undefined, null, 'normal', 'urgent', 5]) {
    const { factors } = scoreReminder(make('18:00', { importance }), NOW);
    assert.ok(!factors.some(f => f.id === 'importance'), `importance ${String(importance)}`);
  }
  assert.equal(normalizeImportance('urgent'), 'normal');
});

test('a one-time reminder gets a bump, and says why', () => {
  const once = make('18:00', { recurrence: { type: 'once', date: TODAY } });
  const daily = make('18:00');
  assert.equal(scoreReminder(once, NOW).score - scoreReminder(daily, NOW).score, POINTS.oneTime);
  assert.ok(scoreReminder(once, NOW).factors.some(f => /One-time/.test(f.text)));
});

test('a streak only counts when there is one worth protecting, and only for repeating reminders', () => {
  const two = scoreReminder(make('18:00', { currentStreak: 2 }), NOW).factors.find(f => f.id === 'streak');
  assert.equal(two.text, 'Keeps your streak of 2 going');
  assert.ok(!scoreReminder(make('18:00', { currentStreak: 1 }), NOW).factors.some(f => f.id === 'streak'));
  assert.ok(!scoreReminder(make('18:00', { currentStreak: 9, recurrence: { type: 'monthlyDate', dayOfMonth: 8 } }), NOW).factors.some(f => f.id === 'streak'));
  assert.equal(scoreReminder(make('18:00', { currentStreak: 40 }), NOW).factors.find(f => f.id === 'streak').points, POINTS.streakMax);
});

test('partly finished steps add a small, honest bump', () => {
  const steps = [{ id: 1, title: 'a', done: true }, { id: 2, title: 'b', done: false }];
  const started = scoreReminder(make('18:00', { subtasks: steps }), NOW).factors.find(f => f.id === 'started');
  assert.equal(started.text, 'Already started: 1 of 2 steps done');
  const untouched = steps.map(s => ({ ...s, done: false }));
  const finished = steps.map(s => ({ ...s, done: true }));
  assert.ok(!scoreReminder(make('18:00', { subtasks: untouched }), NOW).factors.some(f => f.id === 'started'));
  assert.ok(!scoreReminder(make('18:00', { subtasks: finished }), NOW).factors.some(f => f.id === 'started'));
});

test('reminder color is not a category and never affects ranking', () => {
  const plain = make('18:00');
  const colored = { ...plain, color: 'coral' };
  assert.equal(scoreReminder(colored, NOW).score, scoreReminder(plain, NOW).score);
});

test('reasons come from the strongest factor first and are plain sentences', () => {
  const r = make('09:00', { importance: 'high', currentStreak: 3 });
  const [item] = rankFocus([r], NOW);
  assert.equal(item.reasons[0], 'Overdue by 4 h');
  assert.ok(item.reasons.includes('You marked this high priority'));
  assert.ok(item.reasons.includes('Keeps your streak of 3 going'));
});

test('ties break by earlier time, then older reminder, and never depend on input order', () => {
  const a = make('18:00', { name: 'A' });
  const b = make('18:00', { name: 'B' });
  const c = make('19:00', { name: 'C' });
  const forward = rankFocus([a, b, c], NOW).map(r => r.name);
  const reversed = rankFocus([c, b, a], NOW).map(r => r.name);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward.slice(0, 2), ['A', 'B']);
});

test('ranks run 1..n and ranking never mutates its input', () => {
  const reminders = [make('18:00'), make('09:00'), make('13:30')];
  const snapshot = JSON.stringify(reminders);
  const ranked = rankFocus(reminders, NOW);
  assert.deepEqual(ranked.map(r => r.rank), [1, 2, 3]);
  assert.equal(JSON.stringify(reminders), snapshot);
});

test('an empty or finished day has nothing to rank', () => {
  assert.deepEqual(rankFocus([], NOW), []);
  assert.deepEqual(rankFocus([make('09:00', { takenDate: TODAY })], NOW), []);
  assert.equal(focusSummary([]), 'Nothing left for today.');
});

test('reminders saved before importance existed rank normally', () => {
  const legacy = { id: 99, name: 'Old', time: '18:00', takenDate: null, recurrence: { type: 'daily' } };
  assert.equal(rankFocus([legacy], NOW).length, 1);
});

for (const zone of ['Pacific/Auckland', 'America/Los_Angeles', 'Asia/Kolkata']) {
  test(`"due soon" and "overdue" use the device's local clock in ${zone}`, () => {
    withTimeZone(zone, () => {
      const lateNight = new Date(2026, 9, 8, 23, 50);
      const soon = make('23:55');
      const past = make('00:10');
      const ranked = rankFocus([soon, past], lateNight);
      assert.equal(ranked.find(r => r.id === soon.id).reasons[0], 'Due in 5 min');
      assert.equal(ranked.find(r => r.id === past.id).reasons[0], 'Overdue by 23 h 40 min');
    });
  });
}

// ---- summary and its guard ----

test('the plain summary names the top task and why, using only ranking facts', () => {
  const ranked = rankFocus([make('09:00', { name: 'Call Mom' }), make('18:00', { name: 'Water plants' })], NOW);
  assert.equal(focusSummary(ranked), 'Start with “Call Mom”: overdue by 4 h. Then “Water plants”.');
  assert.equal(focusSummary(ranked.slice(0, 1)), 'Start with “Call Mom”: overdue by 4 h.');
});

test('facts for the model are bounded and contain only task names and reasons', () => {
  const reminders = Array.from({ length: 9 }, (_, i) => make(`${String(14 + i % 9).padStart(2, '0')}:00`, { name: `Task number ${i} ${'x'.repeat(100)}` }));
  const facts = focusFacts(rankFocus(reminders, NOW));
  const lines = facts.split('\n');
  assert.equal(lines.length, MAX_FACT_ITEMS);
  assert.ok(lines.every(l => l.length < 200));
  assert.match(lines[0], /^1\. Task number/);
});

test('a model sentence is accepted only if it adds no new numbers', () => {
  const facts = '1. Call Mom — Overdue by 45 min; Keeps your streak of 6 going\n2. Water plants — Due at 6:00 PM';
  assert.deepEqual(validateSummary('Call Mom first: it is 45 minutes late and protects your 6 day streak.', facts), {
    ok: true, text: 'Call Mom first: it is 45 minutes late and protects your 6 day streak.',
  });
  assert.equal(validateSummary('Call Mom first, it is 90 minutes late.', facts).ok, false);   // 90 is invented
  assert.equal(validateSummary('Do the 3 tasks in order.', facts).ok, false);                  // 3 is invented
  assert.equal(validateSummary('Start with Call Mom, then water the plants.', facts).ok, true); // no numbers at all
});

test('a model sentence is rejected when empty, too long, a link, or not text', () => {
  const facts = '1. A — x';
  assert.equal(validateSummary('', facts).ok, false);
  assert.equal(validateSummary('   ', facts).ok, false);
  assert.equal(validateSummary('x'.repeat(MAX_SUMMARY_LENGTH + 1), facts).ok, false);
  assert.equal(validateSummary('See https://example.com for more', facts).ok, false);
  assert.equal(validateSummary(null, facts).ok, false);
  assert.equal(validateSummary(42, facts).ok, false);
});

test('surrounding quotes are stripped from a model sentence', () => {
  assert.equal(validateSummary('"Start with Call Mom."', '1. Call Mom').text, 'Start with Call Mom.');
});

// ---- user override ----

test('withImportance changes one reminder immutably and drops the field for "normal"', () => {
  const a = make('18:00');
  const b = make('19:00');
  const list = Object.freeze([Object.freeze(a), Object.freeze(b)]);
  const high = withImportance(list, a.id, 'high');
  assert.equal(high[0].importance, 'high');
  assert.equal(high[1], b);
  assert.equal('importance' in withImportance(high, a.id, 'normal')[0], false);
  assert.equal('importance' in withImportance(high, a.id, 'bogus')[0], false);
  assert.deepEqual(withImportance(list, 12345, 'high'), list);
});

test('overriding importance re-ranks immediately', () => {
  const first = make('13:30', { name: 'Soon' });
  const second = make('18:00', { name: 'Later' });
  const reminders = [first, second];
  assert.deepEqual(names(rankFocus(reminders, NOW)), ['Soon', 'Later']);
  const overridden = withImportance(reminders, second.id, 'high');
  assert.deepEqual(names(rankFocus(overridden, NOW)), ['Later', 'Soon']);
  assert.deepEqual(names(rankFocus(withImportance(overridden, second.id, 'normal'), NOW)), ['Soon', 'Later']);
});

// ---- the model's part: phrasing only ----

const AVAILABLE = { available: true, osSupported: true, modelAvailable: true, reason: null };
function fakeNative({ availability = AVAILABLE, explain } = {}) {
  const calls = { availability: 0, explain: [], cancel: 0 };
  return {
    calls,
    async availability() { calls.availability++; return availability; },
    async explainFocus(facts) { calls.explain.push(facts); return explain ? explain(facts) : { summary: 'Start with Task 09:00 first.' }; },
    async cancel() { calls.cancel++; },
  };
}
const twoTasks = () => rankFocus([make('09:00', { name: 'Call Mom' }), make('18:00', { name: 'Water plants' })], NOW);

test('a valid model sentence is used, and the ranking order is never changed by it', async () => {
  const ranked = twoTasks();
  const before = JSON.stringify(ranked);
  const native = fakeNative({ explain: async () => ({ summary: 'Call Mom first: it is overdue. Then water the plants.' }) });
  const result = await createIntelligence({ native }).summarizeFocus(ranked);
  assert.deepEqual(result, { status: 'ok', summary: 'Call Mom first: it is overdue. Then water the plants.', usedAI: true });
  assert.equal(JSON.stringify(ranked), before);
  assert.match(native.calls.explain[0], /^1\. Call Mom/);
});

test('a model sentence with an invented number falls back to the plain sentence', async () => {
  const ranked = twoTasks();
  const native = fakeNative({ explain: async () => ({ summary: 'Call Mom first, it is 99 minutes late.' }) });
  const result = await createIntelligence({ native }).summarizeFocus(ranked);
  assert.equal(result.usedAI, false);
  assert.equal(result.summary, focusSummary(ranked));
});

test('unavailable, failing or malformed model: the plain sentence, never an error', async () => {
  const ranked = twoTasks();
  const cases = [
    fakeNative({ availability: { available: false, osSupported: true, modelAvailable: false, reason: 'apple_intelligence_not_enabled' } }),
    fakeNative({ explain: async () => { throw Object.assign(new Error('x'), { code: 'declined' }); } }),
    fakeNative({ explain: async () => ({}) }),
    fakeNative({ explain: async () => null }),
  ];
  for (const native of cases) {
    const result = await createIntelligence({ native }).summarizeFocus(ranked);
    assert.deepEqual(result, { status: 'ok', summary: focusSummary(ranked), usedAI: false });
  }
});

test('a single task or an empty day never calls the model', async () => {
  const native = fakeNative();
  const intelligence = createIntelligence({ native });
  assert.equal((await intelligence.summarizeFocus([])).summary, 'Nothing left for today.');
  assert.equal((await intelligence.summarizeFocus(twoTasks().slice(0, 1))).usedAI, false);
  assert.equal(native.calls.availability, 0);
});

test('cancelling a summary discards its result', async () => {
  let release;
  const native = fakeNative({ explain: () => new Promise(resolve => { release = () => resolve({ summary: 'Call Mom first.' }); }) });
  const intelligence = createIntelligence({ native });
  const pending = intelligence.summarizeFocus(twoTasks());
  await new Promise(r => setImmediate(r));
  intelligence.cancel();
  release();
  assert.deepEqual(await pending, { status: 'cancelled' });
});

test('while the model is busy, a summary request gets the plain sentence', async () => {
  let release;
  const native = fakeNative({ explain: () => new Promise(resolve => { release = () => resolve({ summary: 'Call Mom first.' }); }) });
  const intelligence = createIntelligence({ native });
  const first = intelligence.summarizeFocus(twoTasks());
  await new Promise(r => setImmediate(r));
  assert.equal((await intelligence.summarizeFocus(twoTasks())).usedAI, false);
  release();
  assert.equal((await first).usedAI, true);
  assert.equal(native.calls.explain.length, 1);
});
