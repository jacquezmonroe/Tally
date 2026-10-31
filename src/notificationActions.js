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
  if (action.actionId === MARK_TAKEN_ACTION_ID) return { kind: 'mark_taken', reminderId };
  if (action.actionId === 'tap') return { kind: 'open', reminderId };
  return { kind: 'ignore', reminderId };
}
