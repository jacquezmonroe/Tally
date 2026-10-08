import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  windowFor,
  buildPlan,
  layoutBlocks,
  setBlockMinutes,
  moveBlock,
  removeBlock,
  addUnscheduled,
  planSummary,
  planFacts,
  planTotalMinutes,
  toStoredPlan,
  fromStoredPlan,
  formatMinutes,
  formatDuration,
  DEFAULT_MINUTES,
  MAX_MINUTES,
  MIN_MINUTES,
  MAX_BLOCKS,
  DAY_END,
} from './planner.js';
import { rankFocus, validateSummary } from './prioritizer.js';
import { createIntelligence } from './index.js';
import { todayKey } from '../streak.js';

// Thursday, October 8 2026, 2:00 PM local.
const NOW = new Date(2026, 9, 8, 14, 0);
const TODAY = todayKey(NOW);
const at = (h, m = 0) => h * 60 + m;
const rem = (id, name, time, extra = {}) => ({ id, name, time, takenDate: null, recurrence: { type: 'daily' }, ...extra });
const plan = (reminders, window, estimates = {}, now = NOW) => buildPlan({ reminders, now, window, estimates });
const ids = p => p.blocks.map(b => b.id);

const ORIGINAL_TZ = process.env.TZ;
const restoreTimeZone = () => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; };
after(restoreTimeZone);
function withTimeZone(zone, fn) {
  process.env.TZ = zone;
  try { fn(); } finally { restoreTimeZone(); }
}

// ---- windows ----

test('named scopes have fixed, visible windows', () => {
  assert.deepEqual(windowFor('morning', NOW), { start: at(6), end: at(12) });
  assert.deepEqual(windowFor('afternoon', NOW), { start: at(12), end: at(17) });
  assert.deepEqual(windowFor('evening', NOW), { start: at(17), end: at(22) });
});

test('"rest of today" runs from now to the latest known deadline, not a guessed bedtime', () => {
  const reminders = [rem(1, 'A', '15:00'), rem(2, 'B', '18:30')];
  assert.deepEqual(windowFor('rest', NOW, reminders), { start: at(14), end: at(18, 30) });
});

test('"rest of today" stretches to fit the work when deadlines come sooner than the work ends', () => {
  const reminders = [rem(1, 'A', '14:10'), rem(2, 'B', '14:20')];
  const window = windowFor('rest', NOW, reminders, { 1: 60, 2: 60 });
  assert.equal(window.start, at(14));
  assert.ok(window.end >= at(16));
});

test('"rest of today" never runs past the end of the day', () => {
  assert.equal(windowFor('rest', new Date(2026, 9, 8, 23, 58), [rem(1, 'A', '23:59')]).end <= DAY_END, true);
});

test('the window start rounds up to the next 5 minutes', () => {
  assert.equal(windowFor('rest', new Date(2026, 9, 8, 14, 1), []).start, at(14, 5));
  assert.equal(windowFor('rest', new Date(2026, 9, 8, 14, 5), []).start, at(14, 5));
});

// ---- layout ----

test('tasks are laid out back to back with no overlap, each labelled as an estimate', () => {
  const p = plan([rem(1, 'A', '18:00'), rem(2, 'B', '19:00')], { start: at(14), end: at(20) });
  assert.equal(p.blocks.length, 2);
  assert.equal(p.blocks[0].start, at(14));
  assert.equal(p.blocks[1].start, p.blocks[0].end);
  assert.ok(p.blocks.every(b => b.minutes === DEFAULT_MINUTES && b.estimated === true));
});

test('a block finishes by its reminder time when that is possible', () => {
  const p = plan([rem(1, 'Soon', '14:30')], { start: at(14), end: at(20) });
  assert.equal(p.blocks[0].end <= at(14, 30), true);
  assert.equal(p.blocks[0].lateBy, 0);
});

test('priority order yields to a deadline that would otherwise be missed', () => {
  // "Big" is high importance so it ranks first, but doing it first would make "Quick" miss 2:30.
  const big = rem(1, 'Big', '18:00', { importance: 'high' });
  const quick = rem(2, 'Quick', '14:30');
  assert.equal(rankFocus([big, quick], NOW)[0].name, 'Big');
  const p = plan([big, quick], { start: at(14), end: at(20) }, { 1: 60, 2: 15 });
  assert.deepEqual(p.blocks.map(b => b.name), ['Quick', 'Big']);
  assert.ok(p.blocks.every(b => b.lateBy === 0));
});

test('a task that can never make its deadline does not drag a feasible one down with it', () => {
  // Hopeless: 60 min of work due in 23 min. Feasible: 20 min of work due in 26 min.
  const hopeless = rem(1, 'Hopeless', '14:23', { importance: 'high' });
  const feasible = rem(2, 'Feasible', '14:26');
  const overdue = rem(3, 'Overdue', '12:00');
  const p = plan([hopeless, feasible, overdue], { start: at(14), end: at(18) }, { 1: 60, 2: 20, 3: 15 });
  assert.equal(p.blocks.find(b => b.id === 2).lateBy, 0);
});

test('with several deadlines reachable only in one order, that order is used even against priority', () => {
  const a = rem(1, 'High but late deadline', '16:00', { importance: 'high' });
  const b = rem(2, 'Low but tight deadline', '14:20', { importance: 'low' });
  assert.equal(rankFocus([a, b], NOW)[0].id, 1); // by priority A would be first
  const p = plan([a, b], { start: at(14), end: at(20) }, { 1: 60, 2: 20 });
  assert.deepEqual(ids(p), [2, 1]);
  assert.ok(p.blocks.every(x => x.lateBy === 0));
});

test('a task that must be late is done as early as it can be, not pushed behind tasks with no deadline', () => {
  // Dana (due 7:08) and Submit (due 7:13) cannot both be on time; high-priority Submit wins.
  // Dana should then come right after it, ahead of the overdue and open-ended tasks.
  const now = new Date(2026, 9, 8, 18, 45);
  const reminders = [
    rem(1, 'Call Mom', '17:48', { recurrence: { type: 'once', date: TODAY } }),
    rem(2, 'Submit expense report', '19:13', { recurrence: { type: 'once', date: TODAY }, importance: 'high' }),
    rem(3, 'Reply to Dana', '19:08'),
    rem(4, 'Read a chapter', '21:08', { importance: 'low' }),
    rem(5, 'Water the plants', '22:38'),
  ];
  const p = buildPlan({ reminders, now, window: { start: at(18, 45), end: at(23) } });
  assert.deepEqual(p.blocks.map(b => b.name).slice(0, 2), ['Submit expense report', 'Reply to Dana']);
  assert.equal(p.blocks.find(b => b.name === 'Submit expense report').lateBy, 0);
  assert.ok(p.blocks.find(b => b.name === 'Reply to Dana').lateBy <= 10);
  assert.ok(p.blocks.filter(b => b.lateBy > 0).length <= 1);
});

test('when two deadlines cannot both be met, nothing overlaps and the late one is flagged', () => {
  const p = plan([rem(1, 'A', '14:15'), rem(2, 'B', '14:15')], { start: at(14), end: at(20) });
  assert.equal(p.blocks.length, 2);
  assert.equal(p.blocks[1].start, p.blocks[0].end);
  assert.equal(p.blocks.filter(b => b.lateBy > 0).length, 1);
  assert.match(planSummary(p), /would finish after its reminder time/);
});

test('an overdue task is scheduled at the start with no deadline to miss', () => {
  const p = plan([rem(1, 'Late', '12:00'), rem(2, 'Later', '17:00')], { start: at(14), end: at(20) });
  assert.equal(p.blocks[0].id, 1);
  assert.equal(p.blocks[0].overdue, true);
  assert.equal(p.blocks[0].lateBy, 0);
});

test('the plan never starts in the past', () => {
  const p = plan([rem(1, 'A', '18:00')], { start: at(9), end: at(20) }, {}, new Date(2026, 9, 8, 14, 3));
  assert.equal(p.startAt, at(14, 5));
  assert.equal(p.blocks[0].start, at(14, 5));
});

test('a window that has already passed says so and schedules nothing', () => {
  const p = plan([rem(1, 'A', '18:00')], { start: at(6), end: at(12) });
  assert.deepEqual(p.blocks, []);
  assert.equal(p.unscheduled[0].reason, 'window_passed');
  assert.equal(planSummary(p), 'That part of the day has already passed.');
});

test('a task that does not fit in the window is listed, not squeezed in', () => {
  const p = plan([rem(1, 'Long', '18:00'), rem(2, 'Short', '18:00')], { start: at(14), end: at(14, 30) }, { 1: 45, 2: 10 });
  assert.deepEqual(ids(p), [2]);
  assert.equal(p.unscheduled[0].id, 1);
  assert.equal(p.unscheduled[0].reason, 'no_room');
  assert.match(p.unscheduled[0].text, /Doesn't fit before 2:30 PM/);
});

test('a task due before the window opens cannot be planned inside it', () => {
  const p = plan([rem(1, 'Morning thing', '15:00')], { start: at(17), end: at(22) });
  assert.deepEqual(p.blocks, []);
  assert.equal(p.unscheduled[0].reason, 'due_before_window');
  assert.match(p.unscheduled[0].text, /Due at 3:00 PM, before your window starts/);
});

test('nothing is invented: only pending reminders for today become blocks', () => {
  const reminders = [
    rem(1, 'Pending', '18:00'),
    rem(2, 'Done', '17:00', { takenDate: TODAY }),
    rem(3, 'Monday only', '17:00', { recurrence: { type: 'daysOfWeek', daysOfWeek: [1] } }),
    rem(4, 'Yesterday only', '17:00', { recurrence: { type: 'once', date: '2026-10-07' } }),
  ];
  const p = plan(reminders, { start: at(14), end: at(20) });
  assert.deepEqual(p.blocks.map(b => b.name), ['Pending']);
  assert.deepEqual(p.unscheduled, []);
});

test('an empty list gives an empty plan with a plain sentence', () => {
  const p = plan([], { start: at(14), end: at(20) });
  assert.deepEqual(p.blocks, []);
  assert.equal(planSummary(p), 'Nothing to plan.');
});

test('user-set durations are honoured and clamped to a sane range', () => {
  const p = plan([rem(1, 'A', '20:00'), rem(2, 'B', '20:00'), rem(3, 'C', '20:00')], { start: at(14), end: at(23) }, { 1: 45, 2: 9999, 3: -4 });
  const by = Object.fromEntries(p.blocks.map(b => [b.id, b]));
  assert.equal(by[1].minutes, 45);
  assert.equal(by[1].estimated, false);
  assert.equal(by[2].minutes, MAX_MINUTES);
  assert.equal(by[3].minutes, MIN_MINUTES);
});

test('planning never mutates its input', () => {
  const reminders = [rem(1, 'A', '18:00'), rem(2, 'B', '19:00')];
  const snapshot = JSON.stringify(reminders);
  plan(reminders, { start: at(14), end: at(20) });
  assert.equal(JSON.stringify(reminders), snapshot);
});

// ---- properties: no overlap, in window, deadlines met whenever they can be ----

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function edfFeasible(blocks, startAt) {
  const ordered = [...blocks].sort((a, b) => (a.overdue ? Infinity : a.due) - (b.overdue ? Infinity : b.due));
  let time = startAt;
  for (const b of ordered) {
    time += b.minutes;
    if (!b.overdue && time > b.due) return false;
  }
  return true;
}

test('property: 400 random days never overlap, stay in the window, and meet every deadline that can be met', () => {
  const random = mulberry32(20261008);
  const options = [5, 10, 15, 20, 30, 45, 60, 90];
  for (let run = 0; run < 400; run++) {
    const count = 1 + Math.floor(random() * 8);
    const reminders = Array.from({ length: count }, (_, i) => {
      const due = at(10) + Math.floor(random() * (13 * 60));
      return rem(i + 1, `T${i + 1}`, `${String(Math.floor(due / 60)).padStart(2, '0')}:${String(due % 60).padStart(2, '0')}`, {
        importance: ['high', 'normal', 'low'][Math.floor(random() * 3)],
      });
    });
    const estimates = Object.fromEntries(reminders.map(r => [r.id, options[Math.floor(random() * options.length)]]));
    const start = at(12) + Math.floor(random() * 6) * 60;
    const window = { start, end: start + (2 + Math.floor(random() * 8)) * 60 };
    const p = plan(reminders, window, estimates);

    const label = `run ${run}`;
    assert.ok(p.startAt >= window.start && p.startAt >= at(14), `${label}: starts after now and window start`);
    p.blocks.forEach((b, i) => {
      assert.equal(b.end, b.start + b.minutes, `${label}: block length`);
      assert.equal(b.start, i === 0 ? p.startAt : p.blocks[i - 1].end, `${label}: back to back, no overlap`);
      assert.ok(b.end <= window.end, `${label}: inside window`);
    });
    const placed = new Set([...ids(p), ...p.unscheduled.map(u => u.id)]);
    assert.equal(placed.size, ids(p).length + p.unscheduled.length, `${label}: no task appears twice`);
    assert.deepEqual([...placed].sort((a, b) => a - b), rankFocus(reminders, NOW).map(r => r.id).sort((a, b) => a - b), `${label}: every pending task is placed or listed`);
    if (edfFeasible(p.blocks, p.startAt)) {
      assert.ok(p.blocks.every(b => b.lateBy === 0), `${label}: an on-time order exists, so nothing may be late`);
    }
  }
});

// ---- editing ----

const base = () => plan([rem(1, 'A', '18:00'), rem(2, 'B', '18:30'), rem(3, 'C', '19:00')], { start: at(14), end: at(20) });

test('changing a duration re-times every later block and keeps them contiguous', () => {
  const edited = setBlockMinutes(base(), 1, 60);
  const first = edited.blocks.find(b => b.id === 1);
  assert.equal(first.minutes, 60);
  assert.equal(first.estimated, false);
  edited.blocks.forEach((b, i) => { if (i) assert.equal(b.start, edited.blocks[i - 1].end); });
});

test('moving a block swaps order, re-times, and refuses to move past the ends', () => {
  const p = base();
  const moved = moveBlock(p, p.blocks[0].id, 1);
  assert.equal(moved.blocks[1].id, p.blocks[0].id);
  assert.equal(moveBlock(p, p.blocks[0].id, -1), p);
  assert.equal(moveBlock(p, p.blocks[2].id, 1), p);
  assert.equal(moveBlock(p, 999, 1), p);
});

test('an edit that causes lateness shows the warning instead of hiding it', () => {
  const p = plan([rem(1, 'Tight', '14:30'), rem(2, 'Other', '18:00')], { start: at(14), end: at(20) });
  const late = moveBlock(p, p.blocks.find(b => b.id === 1).id, 1);
  const tight = late.blocks.find(b => b.id === 1);
  assert.equal(late.blocks[0].id, 2);
  assert.ok(tight.lateBy > 0 || tight.end <= at(14, 30));
  const stretched = setBlockMinutes(p, 2, 120);
  assert.ok(stretched.blocks.some(b => b.lateBy > 0) || stretched.blocks.every(b => b.end <= b.due || b.overdue));
});

test('a plan edited past the window end flags it', () => {
  const p = plan([rem(1, 'A', '18:00')], { start: at(14), end: at(14, 30) });
  const stretched = setBlockMinutes(p, 1, 60);
  assert.equal(stretched.blocks[0].beyondWindow, true);
});

test('removing a block moves it to the unscheduled list, and it can be added back', () => {
  const removed = removeBlock(base(), 2);
  assert.deepEqual(ids(removed), [1, 3]);
  assert.equal(removed.unscheduled[0].reason, 'removed');
  removed.blocks.forEach((b, i) => { if (i) assert.equal(b.start, removed.blocks[i - 1].end); });
  const restored = addUnscheduled(removed, 2);
  assert.deepEqual(ids(restored), [1, 3, 2]);
  assert.deepEqual(restored.unscheduled, []);
  assert.equal(addUnscheduled(restored, 2), restored);
});

test('edits never mutate the plan they were given', () => {
  const p = base();
  const snapshot = JSON.stringify(p);
  setBlockMinutes(p, 1, 90); moveBlock(p, 1, 1); removeBlock(p, 1);
  assert.equal(JSON.stringify(p), snapshot);
});

test('layoutBlocks alone cannot produce an overlap whatever order it is given', () => {
  const blocks = [{ id: 1, minutes: 30, due: at(18) }, { id: 2, minutes: 10, due: at(15) }, { id: 3, minutes: 5, due: null }];
  const laid = layoutBlocks(blocks, at(14), at(20));
  laid.forEach((b, i) => { if (i) assert.equal(b.start, laid[i - 1].end); });
});

test('there is a hard cap on blocks', () => {
  const many = Array.from({ length: MAX_BLOCKS + 5 }, (_, i) => rem(i + 1, `T${i}`, '23:00'));
  const p = plan(many, { start: at(14), end: at(23, 55) }, Object.fromEntries(many.map(r => [r.id, 5])));
  const full = { ...p, blocks: p.blocks.slice(0, MAX_BLOCKS), unscheduled: [{ ...p.blocks[0], id: 9999, reason: 'removed', text: '' }] };
  assert.equal(addUnscheduled(full, 9999), full);
});

// ---- words ----

test('formatting', () => {
  assert.equal(formatMinutes(at(0, 5)), '12:05 AM');
  assert.equal(formatMinutes(at(12)), '12:00 PM');
  assert.equal(formatMinutes(at(14, 30)), '2:30 PM');
  assert.equal(formatDuration(45), '45 min');
  assert.equal(formatDuration(90), '1 h 30 min');
  assert.equal(formatDuration(120), '2 h');
});

test('the plain summary labels the total as an estimate and uses only plan facts', () => {
  const p = base();
  assert.equal(planSummary(p), 'First up: “A” at 2:00 PM. 3 tasks, about 45 min (estimated), done by 2:45 PM.');
  assert.equal(planTotalMinutes(p), 45);
});

test('facts for the model carry times, names and estimated lengths only', () => {
  const facts = planFacts(base());
  assert.equal(facts.split('\n').length, 3);
  assert.match(facts.split('\n')[0], /^2:00 PM to 2:15 PM: A \(15 min estimated\)$/);
});

test('a model sentence with an invented time is rejected, a faithful one is accepted', () => {
  const facts = planFacts(base());
  assert.equal(validateSummary('Start with A at 2:00 PM, then B and C.', facts).ok, true);
  assert.equal(validateSummary('Start with A at 2:07 PM.', facts).ok, false);   // 2:07 is not in the plan
  assert.equal(validateSummary('Everything is done by 4:30 PM.', facts).ok, false); // 4:30 is not in the plan
});

// ---- saving ----

test('a saved plan round-trips against the same reminders', () => {
  const reminders = [rem(1, 'A', '18:00'), rem(2, 'B', '18:30')];
  const p = plan(reminders, { start: at(14), end: at(20) }, { 2: 30 });
  const restored = fromStoredPlan(JSON.parse(JSON.stringify(toStoredPlan(p, NOW))), reminders, NOW);
  assert.deepEqual(restored.blocks.map(b => [b.id, b.start, b.end, b.minutes, b.estimated]), p.blocks.map(b => [b.id, b.start, b.end, b.minutes, b.estimated]));
});

test('what is stored is only layout: no names, no reminder copies', () => {
  const stored = toStoredPlan(base(), NOW);
  assert.deepEqual(Object.keys(stored).sort(), ['blocks', 'date', 'startAt', 'v', 'window']);
  assert.deepEqual(Object.keys(stored.blocks[0]).sort(), ['estimated', 'id', 'minutes']);
});

test('a stored plan for another day, or damaged, or the wrong version, is ignored', () => {
  const reminders = [rem(1, 'A', '18:00')];
  const good = toStoredPlan(plan(reminders, { start: at(14), end: at(20) }), NOW);
  assert.equal(fromStoredPlan({ ...good, date: '2026-10-07' }, reminders, NOW), null);
  assert.equal(fromStoredPlan({ ...good, v: 2 }, reminders, NOW), null);
  assert.equal(fromStoredPlan({ ...good, window: { start: 500, end: 100 } }, reminders, NOW), null);
  assert.equal(fromStoredPlan({ ...good, blocks: 'nope' }, reminders, NOW), null);
  assert.equal(fromStoredPlan('{not json', reminders, NOW), null);
  assert.equal(fromStoredPlan(null, reminders, NOW), null);
  assert.equal(fromStoredPlan(undefined, reminders, NOW), null);
  assert.equal(fromStoredPlan({ ...good, blocks: Array.from({ length: MAX_BLOCKS + 1 }, () => ({ id: 1 })) }, reminders, NOW), null);
});

test('blocks for reminders that were deleted, finished or duplicated are dropped on load', () => {
  const reminders = [rem(1, 'A', '18:00'), rem(2, 'B', '18:30', { takenDate: TODAY })];
  const stored = { ...toStoredPlan(plan([rem(1, 'A', '18:00'), rem(2, 'B', '18:30')], { start: at(14), end: at(20) }), NOW) };
  stored.blocks.push({ id: 1, minutes: 15 }, { id: 404, minutes: 15 });
  const restored = fromStoredPlan(stored, reminders, NOW);
  assert.deepEqual(ids(restored), [1]);
});

test('hand-edited storage cannot create overlaps or absurd lengths', () => {
  const reminders = [rem(1, 'A', '18:00'), rem(2, 'B', '18:30')];
  const stored = toStoredPlan(plan(reminders, { start: at(14), end: at(20) }), NOW);
  stored.blocks = [{ id: 1, minutes: 99999 }, { id: 2, minutes: -3 }];
  const restored = fromStoredPlan(stored, reminders, NOW);
  assert.equal(restored.blocks[0].minutes, MAX_MINUTES);
  assert.equal(restored.blocks[1].minutes, MIN_MINUTES);
  assert.equal(restored.blocks[1].start, restored.blocks[0].end);
});

// ---- the planner cannot touch reminders or notifications ----

test('planning and saving use no storage, notification or network API', () => {
  const source = readFileSync(new URL('./planner.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  for (const pattern of [/Preferences/, /LocalNotifications/, /localStorage/, /\bfetch\s*\(/, /schedule\s*\(/, /https?:\/\//]) {
    assert.doesNotMatch(source, pattern);
  }
});

// ---- timezone ----

for (const zone of ['Pacific/Auckland', 'America/Los_Angeles', 'Asia/Kolkata']) {
  test(`planning uses the device's local clock in ${zone}`, () => {
    withTimeZone(zone, () => {
      const lateEvening = new Date(2026, 9, 8, 21, 0);
      const p = buildPlan({ reminders: [rem(1, 'A', '22:00')], now: lateEvening, window: windowFor('rest', lateEvening, [rem(1, 'A', '22:00')]) });
      assert.equal(p.startAt, at(21));
      assert.equal(p.blocks[0].start, at(21));
      assert.equal(p.blocks[0].end <= at(22), true);
    });
  });
}

// ---- the orchestrator's plan summary ----

const AVAILABLE = { available: true, osSupported: true, modelAvailable: true, reason: null };
function fakeNative({ availability = AVAILABLE, explain } = {}) {
  const calls = { availability: 0, explain: [] };
  return {
    calls,
    async availability() { calls.availability++; return availability; },
    async explainPlan(facts) { calls.explain.push(facts); return explain ? explain(facts) : { summary: 'Start with A.' }; },
    async cancel() {},
  };
}

test('a faithful model sentence is used; an invented one falls back to the plain sentence', async () => {
  const p = base();
  const good = await createIntelligence({ native: fakeNative({ explain: async () => ({ summary: 'Start with A at 2:00 PM, then B and C.' }) }) }).summarizePlan(p);
  assert.deepEqual(good, { status: 'ok', summary: 'Start with A at 2:00 PM, then B and C.', usedAI: true });
  const bad = await createIntelligence({ native: fakeNative({ explain: async () => ({ summary: 'You will be done by 6:15 PM.' }) }) }).summarizePlan(p);
  assert.deepEqual(bad, { status: 'ok', summary: planSummary(p), usedAI: false });
});

test('an unavailable or failing model, or a one-block plan, never blocks the plan', async () => {
  const p = base();
  for (const native of [
    fakeNative({ availability: { available: false, osSupported: true, modelAvailable: false, reason: 'model_not_ready' } }),
    fakeNative({ explain: async () => { throw Object.assign(new Error('x'), { code: 'declined' }); } }),
    fakeNative({ explain: async () => null }),
  ]) {
    assert.deepEqual(await createIntelligence({ native }).summarizePlan(p), { status: 'ok', summary: planSummary(p), usedAI: false });
  }
  const native = fakeNative();
  const single = plan([rem(1, 'A', '18:00')], { start: at(14), end: at(20) });
  assert.equal((await createIntelligence({ native }).summarizePlan(single)).usedAI, false);
  assert.equal(native.calls.availability, 0);
});
