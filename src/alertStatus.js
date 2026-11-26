// Turns the result of a reconcile (notifications.js) into what the screen shows:
// which banner, what it says, and which reminder rows get a warning badge.
// Kept free of the DOM so it can be tested.

// -> { kind: 'none' | 'prompt' | 'denied' | 'failed', badges: Map(reminderId -> reason), count, leftover }
//   count:    reminders that are saved but have no working alert
//   leftover: old alerts that could not be removed (no reminder to point at)
export function summarizeAlerts(result, reminders) {
  const none = { kind: 'none', badges: new Map(), count: 0, leftover: 0 };
  if (!result) return none;
  if (result.permission === 'prompt') return { ...none, kind: 'prompt' };
  if (result.permission === 'unavailable') return none;

  const known = new Set(reminders.map(r => r.id));
  const badges = new Map();
  for (const f of result.failed || []) {
    if (!known.has(f.reminderId)) continue;
    if (!badges.has(f.reminderId)) badges.set(f.reminderId, f.reason);
  }
  const leftover = (result.failedCancels || []).length > 0 && badges.size === 0 ? result.failedCancels.length : 0;

  if (result.permission === 'denied') return { kind: 'denied', badges, count: badges.size, leftover: 0 };
  if (badges.size === 0 && leftover === 0) return none;
  return { kind: 'failed', badges, count: badges.size, leftover };
}

export function alertBannerText(summary) {
  if (summary.kind === 'denied') {
    return 'Notifications are off for Tickmark, so your reminders will not alert you. Turn them on in Settings → Notifications → Tickmark.';
  }
  if (summary.kind === 'failed') {
    const overLimit = [...summary.badges.values()].filter(r => r === 'over_limit').length;
    if (overLimit > 0) {
      return `iPhone allows only 64 scheduled alerts per app, so ${overLimit === 1 ? '1 reminder has' : `${overLimit} reminders have`} no alert. Delete some reminders or use fewer days to make room.`;
    }
    if (summary.count > 0) {
      return summary.count === 1
        ? '1 reminder is saved but its alert could not be scheduled.'
        : `${summary.count} reminders are saved but their alerts could not be scheduled.`;
    }
    return 'Some old alerts could not be removed, so you may get an alert for something you deleted.';
  }
  return '';
}

export function alertBadgeText(reason) {
  if (reason === 'permission_denied') return 'Alerts are off';
  if (reason === 'over_limit') return 'Over iPhone alert limit';
  return 'Alert not scheduled';
}
