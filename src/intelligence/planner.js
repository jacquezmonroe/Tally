// "Plan my day": lays today's pending reminders out as non-overlapping time
// blocks inside a window the user chooses.
//
// What this does NOT do, on purpose:
//  - It knows nothing about your calendar or availability. The window (rest of
//    today, morning, afternoon, evening, or times you type) is the user's own
//    choice and is always shown and editable.
//  - It invents no durations. Tickmark stores none, so every task starts at a
//    default estimate that is always labelled as an estimate and can be edited.
//  - It never changes a reminder, its time, or its notification. A plan is a
//    separate, suggested layout that only exists once the user saves it.
//
// A reminder's time is treated as its deadline: a block should finish by it
// when that is possible. Order follows the focus ranking (prioritizer.js)
// except where that would make a deadline that could be met get missed.
// Pure and dependency-light so it can be tested directly. All times are
// minutes since local midnight.

import { getPendingToday } from '../due.js';
import { rankFocus } from './prioritizer.js';
import { todayKey } from '../streak.js';

export const DEFAULT_MINUTES = 15;
export const MIN_MINUTES = 5;
export const MAX_MINUTES = 480;
export const DURATION_OPTIONS = [5, 10, 15, 20, 30, 45, 60, 90, 120];
export const ROUND_TO = 5;
export const DAY_END = 23 * 60 + 55;
export const MAX_BLOCKS = 30;

export const SCOPES = {
  rest: { label: 'Rest of today' },
  morning: { label: 'Morning', start: 6 * 60, end: 12 * 60 },
  afternoon: { label: 'Afternoon', start: 12 * 60, end: 17 * 60 },
  evening: { label: 'Evening', start: 17 * 60, end: 22 * 60 },
};

const toMinutes = hhmm => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const minutesOf = date => date.getHours() * 60 + date.getMinutes();
const ceilTo = (value, step) => Math.ceil(value / step) * step;
const clampMinutes = value => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, n)) : DEFAULT_MINUTES;
};

export function formatMinutes(total) {
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// The window for a scope. "Rest of today" starts now and ends at the latest
// known deadline (or when the work would be done, if that is later): it uses
// what Tickmark knows, not a guess about the user's evening.
// -> { start, end }
export function windowFor(scope, now = new Date(), reminders = [], estimates = {}) {
  if (scope !== 'rest' && SCOPES[scope]) return { start: SCOPES[scope].start, end: SCOPES[scope].end };
  const start = ceilTo(minutesOf(now), ROUND_TO);
  const pending = getPendingToday(reminders, now);
  const total = pending.reduce((sum, r) => sum + clampMinutes(estimates[r.id] ?? DEFAULT_MINUTES), 0);
  const dues = pending.map(r => toMinutes(r.time)).filter(due => due > start);
  const end = Math.min(DAY_END, ceilTo(Math.max(...dues, start + total), 30));
  return { start, end: Math.max(end, Math.min(DAY_END, start + ROUND_TO)) };
}

// ---- Layout ----

// The effective deadline of a task: its reminder time, or the end of the
// window if that comes first. Overdue tasks have no deadline left to meet, so
// only the window end applies to them.
const deadlineOf = (task, windowEnd) => Math.min(task.overdue ? windowEnd : task.due, windowEnd);

// The fewest tasks that must finish late (or not fit) if these are worked
// from `cursor`: the Moore-Hodgson algorithm. Going by deadline order, any
// time the running total passes a deadline, the longest task so far is set
// aside as the late one. Unlike a plain earliest-deadline-first count, a task
// that can never make its deadline cannot drag the others down with it.
function minLate(tasks, cursor, windowEnd) {
  const ordered = [...tasks].sort((a, b) => deadlineOf(a, windowEnd) - deadlineOf(b, windowEnd) || a.rank - b.rank);
  const kept = [];
  let time = cursor;
  let late = 0;
  for (const task of ordered) {
    kept.push(task);
    time += task.minutes;
    if (time > deadlineOf(task, windowEnd)) {
      let longest = 0;
      kept.forEach((t, i) => { if (t.minutes > kept[longest].minutes) longest = i; });
      time -= kept[longest].minutes;
      kept.splice(longest, 1);
      late++;
    }
  }
  return late;
}

// A task that cannot make its deadline should still be done as soon as it
// can be without costing any on-time task its deadline: ahead of tasks that
// have no deadline pressure, not behind them. Each late task is pulled as far
// forward as that allows. Total time, and so the window fit, is unchanged.
function pullLateTasksForward(order, startAt) {
  const lateIdsOf = list => {
    let time = startAt;
    const late = [];
    for (const task of list) {
      time += task.minutes;
      if (!task.overdue && time > task.due) late.push(task.id);
    }
    return late;
  };
  let current = order;
  const lateNow = lateIdsOf(current);
  for (const id of [...lateNow].sort((a, b) => current.find(t => t.id === a).due - current.find(t => t.id === b).due)) {
    const from = current.findIndex(t => t.id === id);
    const onTime = current.map(t => t.id).filter(other => !lateIdsOf(current).includes(other));
    for (let to = 0; to < from; to++) {
      const moved = [...current];
      const [task] = moved.splice(from, 1);
      moved.splice(to, 0, task);
      const stillLate = new Set(lateIdsOf(moved));
      if (onTime.every(other => !stillLate.has(other))) { current = moved; break; }
    }
  }
  return current;
}

// Places `blocks` one after another from `startAt` and flags problems. Pure:
// returns new blocks. Used for the first plan and again after every edit, so
// edited plans can never overlap.
export function layoutBlocks(blocks, startAt, windowEnd) {
  let cursor = startAt;
  return blocks.map(block => {
    const start = cursor;
    const end = start + block.minutes;
    cursor = end;
    return {
      ...block,
      start,
      end,
      lateBy: !block.overdue && block.due != null && end > block.due ? end - block.due : 0,
      beyondWindow: end > windowEnd,
    };
  });
}

function describeUnscheduled(task, reason, window) {
  const text = {
    no_room: `Doesn't fit before ${formatMinutes(window.end)}`,
    due_before_window: `Due at ${formatMinutes(task.due)}, before your window starts`,
    window_passed: 'That part of the day has already passed',
    removed: 'Removed from the plan',
  }[reason];
  return { id: task.id, name: task.name, minutes: task.minutes, estimated: task.estimated, due: task.due, overdue: task.overdue, reasons: task.reasons, reason, text };
}

// Builds a plan for the pending reminders. Never invents a task: every block
// is a pending reminder from the list it was given.
// -> { window, startAt, blocks, unscheduled, notes }
export function buildPlan({ reminders, now = new Date(), window, estimates = {} }) {
  const nowMin = ceilTo(minutesOf(now), ROUND_TO);
  const startAt = Math.max(window.start, nowMin);
  const tasks = rankFocus(reminders, now).map(item => {
    const due = toMinutes(item.time);
    return {
      id: item.id,
      name: item.name,
      minutes: clampMinutes(estimates[item.id] ?? DEFAULT_MINUTES),
      estimated: !(item.id in estimates),
      due,
      overdue: due <= nowMin,
      rank: item.rank,
      reasons: item.reasons,
    };
  });

  if (startAt >= window.end) {
    return {
      window, startAt, blocks: [], notes: ['That part of the day has already passed.'],
      unscheduled: tasks.map(t => describeUnscheduled(t, 'window_passed', window)),
    };
  }

  const unscheduled = [];
  let remaining = [];
  for (const task of tasks) {
    if (!task.overdue && task.due < startAt) unscheduled.push(describeUnscheduled(task, 'due_before_window', window));
    else remaining.push(task);
  }

  const order = [];
  let cursor = startAt;
  while (remaining.length) {
    const fitting = remaining.filter(t => cursor + t.minutes <= window.end);
    for (const task of remaining) {
      if (!fitting.includes(task)) unscheduled.push(describeUnscheduled(task, 'no_room', window));
    }
    if (fitting.length === 0) { remaining = []; break; }

    // Highest priority first, unless doing it now would cost an on-time finish
    // that is otherwise possible. If nothing can be on time any more, priority decides.
    const bestPossible = minLate(fitting, cursor, window.end);
    const pick = fitting.find(candidate => {
      if (cursor + candidate.minutes > deadlineOf(candidate, window.end)) return false;
      const rest = fitting.filter(t => t !== candidate);
      return minLate(rest, cursor + candidate.minutes, window.end) <= bestPossible;
    }) || fitting[0];
    order.push(pick);
    cursor += pick.minutes;
    remaining = fitting.filter(t => t !== pick);
  }

  const blocks = layoutBlocks(pullLateTasksForward(order, startAt).map(task => ({
    id: task.id, name: task.name, minutes: task.minutes, estimated: task.estimated,
    due: task.due, overdue: task.overdue, reasons: task.reasons,
  })), startAt, window.end);

  return { window, startAt, blocks, unscheduled, notes: [] };
}

// ---- Edits (all return a new plan; none can create an overlap) ----

const relayout = (plan, blocks) => ({ ...plan, blocks: layoutBlocks(blocks, plan.startAt, plan.window.end) });

export function setBlockMinutes(plan, id, minutes) {
  return relayout(plan, plan.blocks.map(b => (b.id === id ? { ...b, minutes: clampMinutes(minutes), estimated: false } : b)));
}

export function moveBlock(plan, id, delta) {
  const index = plan.blocks.findIndex(b => b.id === id);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= plan.blocks.length) return plan;
  const blocks = [...plan.blocks];
  [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
  return relayout(plan, blocks);
}

export function removeBlock(plan, id) {
  const block = plan.blocks.find(b => b.id === id);
  if (!block) return plan;
  const next = relayout(plan, plan.blocks.filter(b => b.id !== id));
  return { ...next, unscheduled: [...plan.unscheduled, describeUnscheduled(block, 'removed', plan.window)] };
}

// Puts an unscheduled task at the end, even if it runs past the window: the
// plan then shows the warning instead of hiding the problem.
export function addUnscheduled(plan, id) {
  const task = plan.unscheduled.find(t => t.id === id);
  if (!task || plan.blocks.length >= MAX_BLOCKS) return plan;
  const block = { id: task.id, name: task.name, minutes: task.minutes, estimated: task.estimated, due: task.due, overdue: task.overdue, reasons: task.reasons };
  return { ...relayout(plan, [...plan.blocks, block]), unscheduled: plan.unscheduled.filter(t => t.id !== id) };
}

// ---- Words ----

export function planTotalMinutes(plan) {
  return plan.blocks.reduce((sum, b) => sum + b.minutes, 0);
}

// A sentence built only from the plan: used when the model is unavailable and
// whenever its sentence fails validation.
export function planSummary(plan) {
  if (plan.blocks.length === 0) return plan.notes[0] || 'Nothing to plan.';
  const first = plan.blocks[0];
  const last = plan.blocks[plan.blocks.length - 1];
  const count = plan.blocks.length;
  const late = plan.blocks.filter(b => b.lateBy > 0).length;
  const parts = [
    `First up: “${first.name}” at ${formatMinutes(first.start)}.`,
    `${count} task${count === 1 ? '' : 's'}, about ${formatDuration(planTotalMinutes(plan))} (estimated), done by ${formatMinutes(last.end)}.`,
  ];
  if (late > 0) parts.push(`${late} would finish after ${late === 1 ? 'its' : 'their'} reminder time.`);
  return parts.join(' ');
}

export const MAX_FACT_BLOCKS = 8;
export const MAX_FACT_NAME = 60;

// The plan as plain lines for the model: times, names, estimated lengths.
export function planFacts(plan) {
  return plan.blocks.slice(0, MAX_FACT_BLOCKS)
    .map(b => `${formatMinutes(b.start)} to ${formatMinutes(b.end)}: ${b.name.slice(0, MAX_FACT_NAME)} (${formatDuration(b.minutes)} estimated${b.lateBy > 0 ? ', finishes after its reminder time' : ''})`)
    .join('\n');
}

// ---- Saving ----
// A saved plan is only a layout for today. It stores which reminders and when,
// never a copy of them, and is ignored if it is for another day or damaged.

export const PLAN_VERSION = 1;

export function toStoredPlan(plan, now = new Date()) {
  return {
    v: PLAN_VERSION,
    date: todayKey(now),
    window: { start: plan.window.start, end: plan.window.end },
    startAt: plan.startAt,
    blocks: plan.blocks.map(b => ({ id: b.id, minutes: b.minutes, estimated: b.estimated })),
  };
}

const isMinute = n => Number.isInteger(n) && n >= 0 && n <= 24 * 60;

// -> a plan rebuilt against today's reminders, or null if unusable.
export function fromStoredPlan(raw, reminders, now = new Date()) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch { return null; }
  }
  if (!data || data.v !== PLAN_VERSION || data.date !== todayKey(now)) return null;
  if (!data.window || !isMinute(data.window.start) || !isMinute(data.window.end) || data.window.end <= data.window.start) return null;
  if (!isMinute(data.startAt) || !Array.isArray(data.blocks) || data.blocks.length > MAX_BLOCKS) return null;

  const pending = new Map(getPendingToday(reminders, now).map(r => [r.id, r]));
  const ranked = new Map(rankFocus(reminders, now).map(item => [item.id, item]));
  const nowMin = ceilTo(minutesOf(now), ROUND_TO);
  const seen = new Set();
  const blocks = [];
  for (const entry of data.blocks) {
    const reminder = pending.get(entry?.id);
    if (!reminder || seen.has(entry.id)) continue; // deleted, finished or not due today: dropped
    seen.add(entry.id);
    const due = toMinutes(reminder.time);
    blocks.push({
      id: reminder.id,
      name: reminder.name,
      minutes: clampMinutes(entry.minutes),
      estimated: entry.estimated !== false,
      due,
      overdue: due <= nowMin,
      reasons: ranked.get(reminder.id)?.reasons || [],
    });
  }
  const plan = { window: { start: data.window.start, end: data.window.end }, startAt: data.startAt, unscheduled: [], notes: [] };
  return { ...plan, blocks: layoutBlocks(blocks, plan.startAt, plan.window.end) };
}
