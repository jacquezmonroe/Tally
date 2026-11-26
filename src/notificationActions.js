// Notification action buttons ("Mark Taken") for reminder notifications.
// Pure and Capacitor-free so the definition and the routing can be tested
// directly; main.js does the actual registering and acting.
//
// How an action gets back into the app: the notification carries an
// `actionTypeId`, iOS shows that type's buttons under it, and pressing one
// makes the Local Notifications plugin emit `localNotificationActionPerformed`
// with the button's id and the notification's own `extra` data (which holds
// the reminder id). classifyNotificationAction turns that event into one of
// three decisions.

import { appliesToday, isOverdueOneTime, isFinished } from './due.js';
import { todayKey, markReminderTaken } from './streak.js';

export const REMINDER_ACTION_TYPE_ID = 'REMINDER';
export const MARK_TAKEN_ACTION_ID = 'MARK_TAKEN';

// The one action type every reminder notification uses. `foreground: false`
// is what lets iOS run the action without opening the app.
export function reminderActionTypes() {
  return [{
    id: REMINDER_ACTION_TYPE_ID,
    actions: [{ id: MARK_TAKEN_ACTION_ID, title: 'Mark Taken', foreground: false, destructive: false }],
  }];
}

function reminderIdOf(action) {
  const raw = action?.notification?.extra?.reminderId;
  const id = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  return Number.isInteger(id) ? id : null;
}

// -> { kind: 'mark_taken' | 'open' | 'ignore', reminderId }
//   mark_taken: the Mark Taken button was pressed
//   open:       the notification itself was tapped (open the app, highlight the row)
//   ignore:     anything else (dismissed, unknown button, no reminder attached)
export function classifyNotificationAction(action) {
  const reminderId = reminderIdOf(action);
  if (reminderId === null) return { kind: 'ignore', reminderId: null };
  if (action.actionId === MARK_TAKEN_ACTION_ID) {
    // A snooze alert records the day it belongs to (see buildSnooze).
    const extra = action.notification.extra;
    const snoozeDay = extra.fp === 'snooze' && typeof extra.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(extra.day) ? extra.day : null;
    return snoozeDay ? { kind: 'mark_taken', reminderId, snoozeDay } : { kind: 'mark_taken', reminderId };
  }
  if (action.actionId === 'tap') return { kind: 'open', reminderId };
  return { kind: 'ignore', reminderId };
}

// ---- Which day a "Mark Taken" press counts for ----
// iOS can hand the press to the app later than it happened (it is held until
// the app's JavaScript runs, possibly the next morning). So the press counts
// for the day of the reminder's latest scheduled time at or before `now`, not
// simply "today": a press for Monday's alert handled on Tuesday before
// Tuesday's time must never mark Tuesday's dose as taken.
// Known limit: if it is handled after the NEXT alert has also fired, the two
// can't be told apart (the plugin doesn't pass the delivery date), and the
// newer one is credited.

const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Day key of the latest scheduled time at or before `now`, or null.
function latestOccurrenceKey(reminder, now) {
  if (appliesToday(reminder, now) && minutesOf(reminder.time) <= now.getHours() * 60 + now.getMinutes()) return todayKey(now);
  for (let i = 1; i <= 366; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    if (appliesToday(reminder, day)) return todayKey(day);
  }
  return null;
}

// A press on a snooze alert passes the snooze's own day (snoozeDay): a snooze
// can fire before the reminder's time, when "the latest scheduled time" would
// still be yesterday. A snoozeDay after today is not trusted.
// -> { kind: 'ignore' } | { kind: 'complete_today' } | { kind: 'credit_past', day }
export function resolveMarkTaken(reminder, now = new Date(), { snoozeDay = null } = {}) {
  if (!reminder) return { kind: 'ignore' };
  if (reminder.recurrence && reminder.recurrence.type === 'once') {
    return (appliesToday(reminder, now) || isOverdueOneTime(reminder, now)) && !isFinished(reminder, now)
      ? { kind: 'complete_today' } : { kind: 'ignore' };
  }
  const day = snoozeDay && snoozeDay <= todayKey(now) ? snoozeDay : latestOccurrenceKey(reminder, now);
  if (day === null) return { kind: 'ignore' };
  if (day === todayKey(now)) return isFinished(reminder, now) ? { kind: 'ignore' } : { kind: 'complete_today' };
  const alreadyCounted = (reminder.takenDate && reminder.takenDate >= day) || (reminder.lastCompletedDate && reminder.lastCompletedDate >= day);
  return alreadyCounted ? { kind: 'ignore' } : { kind: 'credit_past', day };
}

// Records a press for an earlier day: the streak counts that day, and
// takenDate moves to it only if nothing later is already recorded.
export function creditPastDay(reminder, day, graceOccurrences) {
  const updated = markReminderTaken(reminder, day, graceOccurrences);
  return { ...updated, takenDate: reminder.takenDate && reminder.takenDate > day ? reminder.takenDate : day };
}
