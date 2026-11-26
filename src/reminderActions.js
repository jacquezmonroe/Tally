// Adding, editing and deleting reminders, moved out of main.js unchanged in
// behavior so the real flows can be tested. The app's storage and notifier are
// passed in; main.js owns the screen and calls these.
//
// Every action has TWO separate outcomes, reported separately:
//   saved:  did the reminder reach storage?
//   alerts: did the phone's alerts end up matching? (the result of reconcile)
// A reminder whose alert couldn't be scheduled stays saved. A change that
// couldn't be saved is undone in memory as well. Nothing here ever throws on a
// storage or scheduling failure.

import { normalizeImportance } from './intelligence/prioritizer.js';
import { MAX_REMINDER_ID } from './storage.js';

// state: { reminders, nextId } as getters/setters over main.js's variables.
// storage: { saveReminders(list), saveNextId(n) } -> { saved }
// notifier: { reconcile(), snooze(reminder, minutes) }
export function createReminderActions({ state, storage, notifier }) {
  async function persist({ andNextId = false } = {}) {
    const saved = await storage.saveReminders(state.reminders);
    if (andNextId && saved.saved) await storage.saveNextId(state.nextId);
    return saved;
  }

  // Alerts are only worth scheduling for reminders that were really saved.
  async function afterSave(saved) {
    return saved.saved ? notifier.reconcile() : null;
  }

  return {
    // fields: { name, time, recurrence, color, notes, subtasks?, importance? }
    // -> { reminder, saved, alerts } or { error: 'ids_exhausted' }
    async add({ name, time, recurrence, color, notes, subtasks = [], importance = 'normal' }) {
      if (state.nextId > MAX_REMINDER_ID) return { error: 'ids_exhausted', saved: { saved: false, reason: 'ids_exhausted' }, alerts: null };
      const level = normalizeImportance(importance);
      const reminder = {
        id: state.nextId,
        name,
        time,
        recurrence,
        color,
        notes,
        ...(subtasks.length ? { subtasks } : {}),
        ...(level !== 'normal' ? { importance: level } : {}),
        takenDate: null,
        currentStreak: 0,
        longestStreak: 0,
        lastCompletedDate: null,
      };
      const before = { reminders: state.reminders, nextId: state.nextId };
      state.nextId += 1;
      state.reminders = [...state.reminders, reminder];
      const saved = await persist({ andNextId: true });
      // Not saved: undo it in memory too, or the next unrelated save would
      // quietly save (and schedule) the reminder the user was told had failed.
      if (!saved.saved) { state.reminders = before.reminders; state.nextId = before.nextId; }
      return { reminder, saved, alerts: await afterSave(saved) };
    },

    // -> { reminder, saved, alerts } or { error: 'not_found' }
    async update(id, { name, time, recurrence, color, notes, importance = 'normal' }) {
      const reminder = state.reminders.find(r => r.id === id);
      if (!reminder) return { error: 'not_found', saved: { saved: false, reason: 'not_found' }, alerts: null };
      const before = { ...reminder };
      reminder.name = name;
      reminder.time = time;
      reminder.recurrence = recurrence;
      // A one-time reminder counts as finished once it has any takenDate, so a
      // completion from before its (new) date must not carry over and hide it.
      if (recurrence && recurrence.type === 'once' && reminder.takenDate && reminder.takenDate < recurrence.date) reminder.takenDate = null;
      reminder.color = color;
      reminder.notes = notes;
      const level = normalizeImportance(importance);
      if (level === 'normal') delete reminder.importance;
      else reminder.importance = level;
      const saved = await persist();
      if (!saved.saved) {
        // Put the same object back exactly as it was (the screen holds it).
        for (const key of Object.keys(reminder)) if (!(key in before)) delete reminder[key];
        Object.assign(reminder, before);
      }
      return { reminder, saved, alerts: await afterSave(saved) };
    },

    // Reconcile removes the deleted reminder's alerts (they are no longer wanted).
    async remove(id) {
      const reminder = state.reminders.find(r => r.id === id);
      const before = state.reminders;
      state.reminders = state.reminders.filter(r => r.id !== id);
      const saved = await persist();
      if (!saved.saved) state.reminders = before;
      return { reminder: reminder || null, saved, alerts: await afterSave(saved) };
    },

    // Re-checks every alert against the saved data: used after settings
    // changes, on launch, on resume, after completing a reminder (to drop a
    // pending snooze) and for Retry.
    syncAlerts: () => notifier.reconcile(),

    async snooze(id, minutes) {
      const reminder = state.reminders.find(r => r.id === id);
      if (!reminder) return { ok: false, reason: 'not_found' };
      return notifier.snooze(reminder, minutes);
    },
  };
}
