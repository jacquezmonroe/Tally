// "What should I focus on today?": ranks the reminders still pending today.
//
// The ranking is deterministic and explainable: every point comes from a named
// factor with a human-readable reason, and every factor reads a field Tally
// actually stores (due time, overdue status, one-time vs repeating, streak,
// step progress, and the importance the user chose). Nothing is guessed: a
// reminder with no importance set counts as neutral, and a reminder's color is
// not treated as a category because it carries no meaning of its own.
// The on-device model, if used at all, only phrases a summary of this ranking
// (see summarize in index.js); it never changes the order.

import { getPendingToday } from '../due.js';
import { isStreakEligible } from '../streak.js';
import { getSubtasks } from '../subtasks.js';

export const IMPORTANCE_LEVELS = ['high', 'normal', 'low'];

// A stored value that is missing or unrecognised means "the user never chose".
export function normalizeImportance(value) {
  return value === 'high' || value === 'low' ? value : 'normal';
}

export const POINTS = {
  overdueBase: 60,
  overdueMax: 80,        // base + up to 20 more, one point per 15 minutes late
  dueWithinHour: 35,
  dueWithin3Hours: 25,
  laterTodayMax: 15,     // fades by one point per hour, floor 5
  laterTodayMin: 5,
  oneTime: 12,
  streakMax: 15,
  started: 4,
  high: 30,
  low: -20,
};

const MINUTE = 60000;

function formatClock(time) {
  const [h, m] = time.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${period}`;
}

function formatDuration(minutes) {
  const total = Math.max(1, Math.round(minutes));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

// -> { score, factors: [{ id, points, text }] } for one pending reminder.
export function scoreReminder(reminder, now = new Date()) {
  const [hour, minute] = reminder.time.split(':').map(Number);
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
  const minutesUntil = (due.getTime() - now.getTime()) / MINUTE;
  const factors = [];

  if (minutesUntil <= 0) {
    const late = -minutesUntil;
    factors.push({
      id: 'overdue',
      points: Math.min(POINTS.overdueMax, POINTS.overdueBase + Math.floor(late / 15)),
      text: `Overdue by ${formatDuration(late)}`,
    });
  } else if (minutesUntil <= 60) {
    factors.push({ id: 'due_soon', points: POINTS.dueWithinHour, text: `Due in ${formatDuration(minutesUntil)}` });
  } else if (minutesUntil <= 180) {
    factors.push({ id: 'due_later', points: POINTS.dueWithin3Hours, text: `Due at ${formatClock(reminder.time)}` });
  } else {
    const fade = Math.floor(minutesUntil / 60);
    factors.push({
      id: 'due_today',
      points: Math.max(POINTS.laterTodayMin, POINTS.laterTodayMax - fade),
      text: `Due at ${formatClock(reminder.time)}`,
    });
  }

  if ((reminder.recurrence || {}).type === 'once') {
    factors.push({ id: 'one_time', points: POINTS.oneTime, text: "One-time, so it won't come around again" });
  }

  const streak = reminder.currentStreak || 0;
  if (isStreakEligible(reminder) && streak >= 2) {
    factors.push({ id: 'streak', points: Math.min(POINTS.streakMax, streak), text: `Keeps your streak of ${streak} going` });
  }

  const steps = getSubtasks(reminder);
  const stepsDone = steps.filter(s => s.done).length;
  if (steps.length > 0 && stepsDone > 0 && stepsDone < steps.length) {
    factors.push({ id: 'started', points: POINTS.started, text: `Already started: ${stepsDone} of ${steps.length} steps done` });
  }

  const importance = normalizeImportance(reminder.importance);
  if (importance === 'high') factors.push({ id: 'importance', points: POINTS.high, text: 'You marked this high priority' });
  if (importance === 'low') factors.push({ id: 'importance', points: POINTS.low, text: 'You marked this low priority' });

  return { score: factors.reduce((sum, f) => sum + f.points, 0), factors };
}

// The reminders still pending today, best first. Ties go to the earlier time,
// then the older reminder, so the order never flips between renders.
// -> [{ id, name, time, rank, score, importance, reasons: string[] }]
export function rankFocus(reminders, now = new Date()) {
  return getPendingToday(reminders, now)
    .map(reminder => {
      const { score, factors } = scoreReminder(reminder, now);
      const ordered = [...factors].sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
      return {
        id: reminder.id,
        name: reminder.name,
        time: reminder.time,
        score,
        importance: normalizeImportance(reminder.importance),
        reasons: ordered.map(f => f.text),
      };
    })
    .sort((a, b) => b.score - a.score || a.time.localeCompare(b.time) || a.id - b.id)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

// ---- Summary ----

// A plain sentence built only from the ranking: used when the model is
// unavailable, and as the fallback whenever its sentence fails validation.
export function focusSummary(ranked) {
  if (ranked.length === 0) return 'Nothing left for today.';
  const first = ranked[0];
  const why = first.reasons[0] ? first.reasons[0].charAt(0).toLowerCase() + first.reasons[0].slice(1) : 'it is next on your list';
  const second = ranked[1];
  return `Start with “${first.name}”: ${why}.${second ? ` Then “${second.name}”.` : ''}`;
}

export const MAX_FACT_ITEMS = 5;
export const MAX_FACT_NAME = 60;

// The ranking as plain lines for the model: the top few tasks and their
// reasons, nothing else.
export function focusFacts(ranked) {
  return ranked.slice(0, MAX_FACT_ITEMS)
    .map(item => `${item.rank}. ${item.name.slice(0, MAX_FACT_NAME)} — ${item.reasons.join('; ') || 'no special reason'}`)
    .join('\n');
}

export const MAX_SUMMARY_LENGTH = 240;

// The model's sentence is only used if it adds nothing new: no digits or
// clock times that aren't in the facts it was given, no links, and a sensible length.
// -> { ok: true, text } | { ok: false }
export function validateSummary(raw, facts) {
  if (typeof raw !== 'string') return { ok: false };
  const text = raw.replace(/\s+/g, ' ').trim().replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  if (!text || text.length > MAX_SUMMARY_LENGTH) return { ok: false };
  if (/https?:|www\./i.test(text)) return { ok: false };
  const known = new Set(String(facts).match(/\d+/g) || []);
  for (const token of text.match(/\d+/g) || []) {
    if (!known.has(token)) return { ok: false };
  }
  // A clock time like 2:15 must appear exactly in the facts, not just be built from digits that do.
  const knownTimes = new Set(String(facts).match(/\b\d{1,2}:\d{2}\b/g) || []);
  for (const time of text.match(/\b\d{1,2}:\d{2}\b/g) || []) {
    if (!knownTimes.has(time)) return { ok: false };
  }
  return { ok: true, text };
}

// Returns a new list with one reminder's importance changed (never mutates).
export function withImportance(reminders, id, importance) {
  const level = normalizeImportance(importance);
  return reminders.map(r => {
    if (r.id !== id) return r;
    const { importance: _old, ...rest } = r;
    return level === 'normal' ? rest : { ...rest, importance: level };
  });
}
