// The one place that decides which alerts should exist, and makes the phone's
// scheduled alerts match. Nothing else schedules or cancels a reminder alert.
//
// How it works ("reconcile"): from the saved reminders and settings, work out
// the full list of alerts that SHOULD exist; ask the plugin which alerts DO
// exist; schedule the missing or out-of-date ones; cancel the extra ones; and
// report, per reminder, whether that worked. Running it twice in a row changes
// nothing the second time, which is what makes "Retry" safe: it can never
// create duplicates.
//
// ---- Alert IDs ----
//   id = reminderId * 16 + slot
//   slot 0        the reminder's main alert (daily, monthly or one-time)
//   slots 1 to 7  weekly alerts: slot = weekday + 1 (Sunday 1 ... Saturday 7),
//                 which also happens to be the plugin's own weekday number
//   slot 8        snooze
//   slot 9        monthly on the 29th-31st: the occurrence after the one in slot 0
//   slots 10 to 15 reserved
// Every (reminder, kind of alert) pair gets its own id, so ids can never
// collide (the old scheme gave a weekly alert id*100+weekday, which equals
// another reminder's plain id once ids reach 100). Reminder ids are capped at
// MAX_REMINDER_ID so the largest id is exactly 2^31 - 1, the 32-bit limit.
//
// ---- What the plugin gives us (checked against @capacitor/local-notifications 8.3.1) ----
//  - Scheduling an id that already exists REPLACES it, so rescheduling is safe.
//  - getPending() returns each alert's id, title, body, schedule and `extra`,
//    but NOT its sound. So each alert carries a short fingerprint of everything
//    that matters in `extra.fp`, and reconcile compares fingerprints.
//  - Sound: leaving `sound` out is silent on iOS; any name that isn't a bundled
//    file plays the default system sound. The app has no custom sound files,
//    so the only real choices are "default sound" and "silent".
//  - On iOS, scheduling while notifications are denied does NOT fail; the alert
//    just never shows. So permission has to be checked, not inferred from errors.
//
// Quiet hours: the alert still arrives on time, silently (no `sound`).

import { getNotificationBody } from './personalization.js';
import { isExpiredOneTime, appliesToday, isOverdueOneTime, dateFromKey } from './due.js';
import { isWithinQuietHours } from './settings.js';
import { todayKey } from './streak.js';
import { reminderActionTypes, REMINDER_ACTION_TYPE_ID } from './notificationActions.js';
import { MAX_REMINDER_ID } from './storage.js';

export const ALERT_TITLE = 'Tickmark';
export const SLOT_MAIN = 0;
export const SLOT_SNOOZE = 8;
export const SLOT_MONTHLY_NEXT = 9;
export const SLOTS_PER_REMINDER = 16;
export const SCHEME_VERSION = 2;
export const SCHEME_KEY = 'tally-notification-scheme';
export const SNOOZE_MINUTES = 10;
// iOS keeps only the 64 soonest pending alerts per app and silently drops the
// rest. A few slots stay free so a snooze never pushes a reminder's alert out.
export const IOS_PENDING_LIMIT = 64;
export const SNOOZE_RESERVE = 4;
export const ALERT_BUDGET = IOS_PENDING_LIMIT - SNOOZE_RESERVE;

// ---- IDs ----
export function notificationId(reminderId, slot) {
  if (!Number.isSafeInteger(reminderId) || reminderId < 1 || reminderId > MAX_REMINDER_ID) {
    throw new RangeError(`reminder id out of range: ${reminderId}`);
  }
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS_PER_REMINDER) throw new RangeError(`slot out of range: ${slot}`);
  return reminderId * SLOTS_PER_REMINDER + slot;
}

// -> { reminderId, slot } or null for anything that can't be one of our ids.
export function decodeNotificationId(id) {
  if (!Number.isSafeInteger(id) || id < SLOTS_PER_REMINDER || id > 2 ** 31 - 1) return null;
  const reminderId = Math.floor(id / SLOTS_PER_REMINDER);
  return reminderId <= MAX_REMINDER_ID ? { reminderId, slot: id % SLOTS_PER_REMINDER } : null;
}

// ---- Sound ----
// -> 'default' or null (null means silent: the field is left out entirely)
export function soundFor(hour, minute, settings) {
  return settings.soundEnabled && !isWithinQuietHours(hour, minute, settings.quietHours) ? 'default' : null;
}

// ---- Fingerprint: a short hash of everything that makes an alert "the same" ----
function hash32(text, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
const fingerprintOf = (parts) => {
  const text = JSON.stringify(parts);
  return hash32(text, 2166136261) + hash32(text, 5381);
};

// ---- Building the alerts that should exist ----
const parseTime = (time) => time.split(':').map(Number);

// iOS can only repeat "day N of every month", which silently skips months
// without that day. So the 29th-31st (which fall back to a short month's last
// day, see appliesToday) get one-time alerts for their next two occurrences
// instead; every reconcile (launch, resume, any change) moves them forward.
const isMonthEnd = (rec) => rec.type === 'monthlyDate' && rec.dayOfMonth > 28;

function nextMonthEndTimes(reminder, hour, minute, now, count = 2) {
  const times = [];
  for (let i = 0; i <= 93 && times.length < count; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    if (!appliesToday(reminder, day)) continue;
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
    if (at > now) times.push(at);
  }
  return times;
}

function scheduleFor(reminder, slot, hour, minute, now) {
  const rec = reminder.recurrence || { type: 'daily' };
  if (rec.type === 'daysOfWeek') return { on: { weekday: slot, hour, minute }, allowWhileIdle: true };
  if (isMonthEnd(rec)) return { at: nextMonthEndTimes(reminder, hour, minute, now)[slot === SLOT_MAIN ? 0 : 1], allowWhileIdle: true };
  if (rec.type === 'monthlyDate') return { on: { day: rec.dayOfMonth, hour, minute }, allowWhileIdle: true };
  if (rec.type === 'once') {
    const [y, m, d] = rec.date.split('-').map(Number);
    return { at: new Date(y, m - 1, d, hour, minute), allowWhileIdle: true };
  }
  return { on: { hour, minute }, allowWhileIdle: true };
}

function slotsFor(reminder) {
  const rec = reminder.recurrence || { type: 'daily' };
  if (rec.type === 'daysOfWeek') return (rec.daysOfWeek || []).map(dow => dow + 1);
  return isMonthEnd(rec) ? [SLOT_MAIN, SLOT_MONTHLY_NEXT] : [SLOT_MAIN];
}

// -> { items: [{ id, reminderId, slot, fingerprint, notification }], problems: [{ reminderId, reason }] }
// An expired or already-completed one-time reminder has nothing left to alert about. A reminder
// that can't be given a valid id or time is reported, never thrown on.
export function desiredNotifications({ reminders, settings, userName, now = new Date(), random = Math.random }) {
  const items = [];
  const problems = [];
  for (const reminder of reminders) {
    if (isExpiredOneTime(reminder, now)) continue;
    if (reminder.recurrence && reminder.recurrence.type === 'once' && reminder.takenDate) continue; // done early: nothing left to alert about
    const [hour, minute] = parseTime(reminder.time || '');
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isSafeInteger(reminder.id)
      || reminder.id < 1 || reminder.id > MAX_REMINDER_ID) {
      problems.push({ reminderId: reminder.id, reason: 'unschedulable' });
      continue;
    }
    const sound = soundFor(hour, minute, settings);
    for (const slot of slotsFor(reminder)) {
      const schedule = scheduleFor(reminder, slot, hour, minute, now);
      const fingerprint = fingerprintOf({
        v: SCHEME_VERSION, slot, name: reminder.name, userName: userName || '',
        schedule: schedule.at ? { at: schedule.at.toISOString() } : schedule.on, sound: Boolean(sound), badge: 1, action: REMINDER_ACTION_TYPE_ID,
      });
      items.push({
        id: notificationId(reminder.id, slot),
        reminderId: reminder.id,
        slot,
        fingerprint,
        notification: {
          id: notificationId(reminder.id, slot),
          title: ALERT_TITLE,
          body: getNotificationBody(reminder.name, userName, random()),
          schedule,
          ...(sound ? { sound } : {}),
          badge: 1,
          actionTypeId: REMINDER_ACTION_TYPE_ID,
          extra: { reminderId: reminder.id, fp: fingerprint },
        },
      });
    }
  }
  return { items, problems };
}

// The snooze alert: one extra one-time alert a few minutes from now, built the
// same way as the others (same sound rules, same action button).
export function buildSnooze({ reminder, settings, userName, now = new Date(), minutes = SNOOZE_MINUTES, random = Math.random }) {
  const at = new Date(now.getTime() + minutes * 60 * 1000);
  const sound = soundFor(at.getHours(), at.getMinutes(), settings);
  return {
    id: notificationId(reminder.id, SLOT_SNOOZE),
    title: ALERT_TITLE,
    body: getNotificationBody(reminder.name, userName, random()),
    schedule: { at, allowWhileIdle: true },
    ...(sound ? { sound } : {}),
    badge: 1,
    actionTypeId: REMINDER_ACTION_TYPE_ID,
    extra: { reminderId: reminder.id, fp: 'snooze', day: todayKey(now) }, // the day this snooze belongs to
  };
}

// Keeps whole reminders, oldest (lowest id) first, while they fit in the
// budget; a later reminder that is smaller can still fit after one that
// doesn't. -> { items, over: [reminderId] }
export function fitAlertBudget(items, budget = ALERT_BUDGET) {
  const byReminder = new Map();
  for (const item of items) {
    if (!byReminder.has(item.reminderId)) byReminder.set(item.reminderId, []);
    byReminder.get(item.reminderId).push(item);
  }
  const kept = [];
  const over = [];
  for (const id of [...byReminder.keys()].sort((a, b) => a - b)) {
    const group = byReminder.get(id);
    if (kept.length + group.length <= budget) kept.push(...group);
    else over.push(id);
  }
  return { items: kept, over };
}

// ---- Comparing what should exist with what does ----

// A pending snooze is kept while its reminder still exists, still applies on
// the day the snooze belongs to (it may have been edited to another day since),
// hasn't been done for that day, and the snooze time is still ahead. Anything
// else is cancelled. Snoozes from before the day was recorded use today.
function snoozeStillWanted(pendingItem, remindersById, now) {
  const decoded = decodeNotificationId(pendingItem.id);
  if (!decoded || decoded.slot !== SLOT_SNOOZE) return false;
  const reminder = remindersById.get(decoded.reminderId);
  const recorded = pendingItem.extra && pendingItem.extra.day;
  const day = typeof recorded === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(recorded) ? recorded : todayKey(now);
  if (!reminder || reminder.takenDate === day) return false;
  const isOnce = reminder.recurrence && reminder.recurrence.type === 'once';
  if (isOnce && reminder.takenDate) return false; // a one-time reminder done on any day is finished
  const dayDate = dateFromKey(day);
  if (!appliesToday(reminder, dayDate) && !isOverdueOneTime(reminder, dayDate)) return false;
  const at = pendingItem.schedule?.at ? new Date(pendingItem.schedule.at) : null;
  return !at || Number.isNaN(at.getTime()) || at > now;
}

// -> { toSchedule: [item], unchanged: [item], toCancel: [id], keptSnoozes: [id] }
export function planChanges({ desired, pending, reminders, now = new Date() }) {
  const pendingById = new Map(pending.map(p => [p.id, p]));
  const remindersById = new Map(reminders.map(r => [r.id, r]));
  const wanted = new Set(desired.map(d => d.id));
  const toSchedule = [];
  const unchanged = [];
  for (const item of desired) {
    const existing = pendingById.get(item.id);
    if (existing && existing.extra && existing.extra.fp === item.fingerprint) unchanged.push(item);
    else toSchedule.push(item);
  }
  const toCancel = [];
  const keptSnoozes = [];
  for (const p of pending) {
    if (wanted.has(p.id)) continue;
    if (snoozeStillWanted(p, remindersById, now)) keptSnoozes.push(p.id);
    else toCancel.push(p.id);
  }
  return { toSchedule, unchanged, toCancel, keptSnoozes };
}

// ---- Talking to the plugin ----
const messageOf = (e) => (e && e.message) || String(e);

async function readPermission(plugin) {
  try {
    const status = await plugin.checkPermissions();
    const display = status && status.display;
    if (display === 'granted') return 'granted';
    if (display === 'denied') return 'denied';
    return 'prompt';
  } catch {
    return 'unavailable'; // e.g. a plain browser: there is nothing to schedule
  }
}

// Brings the phone's pending alerts in line with the saved reminders.
// Never throws. -> {
//   permission: 'granted' | 'denied' | 'prompt' | 'unavailable',
//   ok: true when every reminder's alerts are as they should be,
//   scheduled: [reminderId], unchanged: [reminderId], cancelled: [id],
//   failed: [{ reminderId, reason: 'schedule_failed' | 'cancel_failed' | 'permission_denied' | 'unschedulable' | 'over_limit', message? }],
//   failedCancels: [id] (alerts that should have been removed but couldn't be),
//   cleanupSkipped: true if the list of pending alerts couldn't be read
// }
export async function reconcile({ plugin, reminders, settings, userName, now = new Date(), random = Math.random }) {
  const result = { permission: 'unavailable', ok: true, scheduled: [], unchanged: [], cancelled: [], failed: [], failedCancels: [], cleanupSkipped: false };
  const desired = desiredNotifications({ reminders, settings, userName, now, random });
  const { problems } = desired;
  const { items, over } = fitAlertBudget(desired.items);
  for (const p of problems) result.failed.push({ reminderId: p.reminderId, reason: p.reason });
  for (const reminderId of over) result.failed.push({ reminderId, reason: 'over_limit' });

  result.permission = await readPermission(plugin);
  if (result.permission === 'unavailable') return { ...result, failed: [], ok: true };
  if (result.permission === 'denied') {
    const ids = [...new Set(items.map(i => i.reminderId))];
    result.failed.push(...ids.map(reminderId => ({ reminderId, reason: 'permission_denied' })));
    result.ok = false;
    return result;
  }
  if (result.permission === 'prompt') {
    result.ok = false; // nothing can be scheduled until the user chooses; the "Enable" banner handles it
    return result;
  }

  try { await plugin.registerActionTypes({ types: reminderActionTypes() }); } catch { /* alerts still fire, just without the button */ }

  let pending = [];
  try {
    pending = (await plugin.getPending()).notifications || [];
  } catch {
    result.cleanupSkipped = true; // can still schedule (ids replace), just can't remove extras this time
  }

  const plan = planChanges({ desired: items, pending, reminders, now });
  result.unchanged = [...new Set(plan.unchanged.map(i => i.reminderId))];

  if (plan.toCancel.length) {
    try {
      await plugin.cancel({ notifications: plan.toCancel.map(id => ({ id })) });
      result.cancelled = plan.toCancel;
    } catch (e) {
      result.failedCancels = plan.toCancel;
      const known = new Set(reminders.map(r => r.id));
      const seen = new Set();
      for (const id of plan.toCancel) {
        const decoded = decodeNotificationId(id);
        if (decoded && known.has(decoded.reminderId) && !seen.has(decoded.reminderId)) {
          seen.add(decoded.reminderId);
          result.failed.push({ reminderId: decoded.reminderId, reason: 'cancel_failed', message: messageOf(e) });
        }
      }
    }
  }

  const byReminder = new Map();
  for (const item of plan.toSchedule) {
    if (!byReminder.has(item.reminderId)) byReminder.set(item.reminderId, []);
    byReminder.get(item.reminderId).push(item.notification);
  }
  for (const [reminderId, notifications] of byReminder) {
    try {
      await plugin.schedule({ notifications });
      result.scheduled.push(reminderId);
    } catch (e) {
      result.failed.push({ reminderId, reason: 'schedule_failed', message: messageOf(e) });
    }
  }

  result.ok = result.failed.length === 0 && result.failedCancels.length === 0;
  return result;
}

// ---- Upgrade cleanup ----
// The first time the new scheme runs, every alert scheduled under the old ids
// is removed (they could duplicate or collide with the new ones) and reconcile
// then rebuilds them from the saved data. The marker is written only once the
// removal has succeeded, so a failure is retried on the next launch.
export async function cancelAllPending(plugin) {
  try {
    const pending = (await plugin.getPending()).notifications || [];
    if (pending.length) await plugin.cancel({ notifications: pending.map(p => ({ id: p.id })) });
    return { ok: true, cancelled: pending.length };
  } catch (e) {
    return { ok: false, cancelled: 0, message: messageOf(e) };
  }
}

// prefs: { get(key) -> string | null, set(key, value) }
export async function ensureSchemeMigrated({ plugin, prefs }) {
  let marker = null;
  try { marker = await prefs.get(SCHEME_KEY); } catch { /* treat as not migrated */ }
  if (Number(marker) >= SCHEME_VERSION) return { ran: false, ok: true, cancelled: 0 };
  const cleanup = await cancelAllPending(plugin);
  if (!cleanup.ok) return { ran: true, ok: false, cancelled: 0, message: cleanup.message };
  try {
    await prefs.set(SCHEME_KEY, String(SCHEME_VERSION));
  } catch {
    return { ran: true, ok: false, cancelled: cleanup.cancelled };
  }
  return { ran: true, ok: true, cancelled: cleanup.cancelled };
}

// ---- The notifier the app uses ----
// Wraps the above with the app's current data, and runs one reconcile at a
// time: calls that arrive while one is running are folded into a single
// follow-up run, so two never overlap (an overlap could cancel an alert the
// other one had just scheduled).
export function createNotifier({ plugin, prefs, getReminders, getSettings, getUserName, now = () => new Date(), random = Math.random }) {
  let running = null;
  let queued = null;

  const runOnce = () => reconcile({
    plugin, reminders: getReminders(), settings: getSettings(), userName: getUserName(), now: now(), random,
  });

  function reconcileNow() {
    if (!running) {
      running = runOnce().finally(() => { running = null; });
      return running;
    }
    if (!queued) {
      queued = running.catch(() => {}).then(() => {
        queued = null;
        return reconcileNow();
      });
    }
    return queued;
  }

  return {
    reconcile: reconcileNow,

    // -> { ok, reason? }  Schedules one snooze alert. It does not reconcile: a
    // later reconcile keeps a snooze while the reminder exists, is not taken
    // today, and the snooze time is still ahead (see planChanges).
    async snooze(reminder, minutes = SNOOZE_MINUTES) {
      const permission = await readPermission(plugin);
      if (permission === 'unavailable') return { ok: false, reason: 'unavailable' };
      if (permission !== 'granted') return { ok: false, reason: 'permission_denied' };
      try {
        await plugin.schedule({ notifications: [buildSnooze({ reminder, settings: getSettings(), userName: getUserName(), now: now(), minutes, random })] });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: 'schedule_failed', message: messageOf(e) };
      }
    },

    // Runs the one-time upgrade cleanup. Call before the first reconcile.
    migrate: () => ensureSchemeMigrated({ plugin, prefs }),
  };
}
